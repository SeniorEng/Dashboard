/**
 * SSoT der Rechnungs-BADGES — Sichten auf Zahlen, keine Zustände.
 *
 * Spezifikation: `docs/rechnungsstatus-zielmodell.md`, Abschnitt 1.
 *
 * ── Was ein Badge von einem Status unterscheidet ────────────────────────
 * Ein Badge wird NIE geschrieben, NIE migriert und NIE als Übergang geprüft.
 * Er wird bei jedem Lesen neu aus Zahlen abgeleitet. Zwei Rechnungen mit
 * demselben Status können verschiedene Badges tragen — das ist der Punkt.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Den Status `teilweise_bezahlt` (`shared/schema/billing.ts`, bis zum
 * Status-Umbau) und den Cluster `teilzahlung`.
 *
 * Der alte Status war zugleich abgeleiteter Wert UND persistierter Zustand —
 * zwei Wahrheiten über dieselbe Frage, die nur solange gleich blieben, wie
 * niemand die Spalte anders anfasste. Er hatte zusätzlich einen konkreten
 * Fehler zur Folge: `assignInvoiceStage` kannte ihn nicht und schickte ihn
 * über den `default`-Zweig auf `rechnung_erstellt`, also in die €-Summe der
 * Entwürfe.
 *
 * Als Badge kann das nicht mehr passieren: es gibt keine Stufe, in die er
 * fallen könnte.
 *
 * Geldbeträge ausnahmslos Integer-Cents.
 */

import type { InvoiceStatus } from "../schema/billing";
import { agingModelForBillingType, resolveAgingBucket } from "./billing-pipeline";

export const INVOICE_BADGES = ["teilweise_bezahlt", "ueberfaellig", "versandt"] as const;
export type InvoiceBadge = (typeof INVOICE_BADGES)[number];

export const INVOICE_BADGE_LABELS: Record<InvoiceBadge, string> = {
  teilweise_bezahlt: "Teilweise bezahlt",
  ueberfaellig: "Überfällig",
  versandt: "Versandt",
};

export interface InvoiceBadgeInput {
  status: InvoiceStatus;
  invoiceType: string;
  /** Brutto-Forderung in Cent. */
  grossAmountCents: number;
  /** Summe ALLER gebundenen Zahlungen in Cent (kumuliert, nicht die letzte). */
  paidCents: number;
  /**
   * Hängt an dieser Rechnung eine gebundene Qonto-Zahlung (Task #1897)?
   *
   * Nicht dasselbe wie `paidCents > 0`: gebunden heißt „das Geld ist auf dem
   * Konto und dieser Rechnung zugeordnet", freigegeben ist es damit noch nicht.
   * Genau diese Unterscheidung war der Kern von #1897.
   */
  hasBoundPayment: boolean;
  /** Fälligkeitsdatum (ISO) — Anker für Selbstzahler/Privat. */
  dueDate: string | null;
  /** Versanddatum (ISO) — Anker für Pflegekassen, und Quelle des Versandt-Badges. */
  sentAt: string | null;
  /**
   * Zahler-Typ. Die EINZIGE legitime Empfänger-Unterscheidung im
   * Rechnungswesen nach dem Status-Umbau — sie sitzt hier, im Badge, nicht im
   * Status (Spec, Abschnitt 7.3).
   */
  billingType: string;
  /** Stichtag. Hereingereicht, nie hier gelesen (Testbarkeit). */
  asOfIso: string;
}

/**
 * Ist auf die Rechnung Geld eingegangen, aber nicht genug?
 *
 * Bewusst OHNE Toleranz-Rechnung: die gehört in
 * `classifyPaymentDifference`/`resolveInvoicePaymentStatus`, wo entschieden
 * wird, ob der Status auf `bezahlt` geht. Hier zählt nur, ob nach dieser
 * Entscheidung noch etwas offen ist — deshalb der Vergleich gegen den
 * STATUS: steht `bezahlt`, ist nichts mehr teilweise.
 */
export function istTeilweiseBezahlt(input: InvoiceBadgeInput): boolean {
  if (input.status === "bezahlt" || input.status === "storniert") return false;
  return input.paidCents > 0 && input.paidCents < input.grossAmountCents;
}

/**
 * Ist die Rechnung unbezahlt, ohne gebundene Zahlung, und die Frist
 * überschritten?
 *
 * ── Die einzige legitime Empfänger-Unterscheidung ───────────────────────
 * Selbstzahler/Privat altern ab dem **Fälligkeitsdatum**, Pflegekassen ab dem
 * **Versanddatum**. Das ist nach dem Status-Umbau die EINZIGE Stelle im
 * Rechnungswesen, an der noch „Kasse ≠ Kunde" steht — und sie steht dort
 * absichtlich (Spec, Abschnitt 7.3).
 *
 * Sachlicher Grund: bei der Kasse liegt zwischen Versand und Zahlung der
 * Avis-Schritt. „Überfällig ab Fälligkeitsdatum" würde dort Rechnungen
 * anmahnen, die im normalen Lauf sind.
 *
 * Wer künftig eine ZWEITE Stelle mit `billingType` im Rechnungswesen findet,
 * hat einen Rückfall gefunden, keinen Rest.
 */
export function istUeberfaellig(input: InvoiceBadgeInput): boolean {
  if (input.status !== "versendet") return false;
  if (input.paidCents >= input.grossAmountCents) return false;

  // Gebundene Zahlung stoppt das Altern — die #1897-Regel, und der Grund, warum
  // dieses Badge sie kennen MUSS.
  //
  // Die erste Fassung fragte nur `paidCents >= grossAmountCents` und hätte
  // damit genau den Fehler wiederholt, den #1897 behoben hat: eine Rechnung mit
  // eingegangener, aber noch nicht freigegebener Zahlung galt weiter als
  // überfällig — „die Abrechnung mahnte Geld an, das auf dem Konto lag".
  //
  // Sichtbar geworden wäre es als Widerspruch in derselben Zeile: das Cockpit
  // führt sie über `isAgingCluster` als `aging: "none"`, die Liste hätte
  // daneben „Überfällig" gezeigt. Das Board ist hier die ältere und geprüfte
  // Wahrheit; das Badge folgt ihr.
  if (input.hasBoundPayment) return false;

  // KEINE eigene Frist-Zahl. Der erste Entwurf dieser Funktion trug einen
  // `fristTage`-Parameter — und hätte damit eine ZWEITE Definition von
  // „überfällig" neben die bestehende Aging-Ampel gestellt. Genau die Sorte
  // Zweitbegriff, gegen die der ganze Umbau läuft.
  //
  // Stattdessen komponiert: Anker aus `agingModelForBillingType`, Schwelle aus
  // `resolveAgingBucket`. „Überfällig" ist alles, was die Ampel nicht mehr
  // grün nennt — beim Selbstzahler ab dem Tag nach Fälligkeit, bei der Kasse
  // nach der Wartefrist ab Versand.
  const model = agingModelForBillingType(input.billingType);
  const anker = model === "selbstzahler" ? input.dueDate : input.sentAt;
  const bucket = resolveAgingBucket(model, anker, input.asOfIso);
  return bucket !== "green" && bucket !== "none";
}

/**
 * Wurde das Dokument verschickt?
 *
 * Trägt vor allem beim STORNO-Dokument: dass eine Stornorechnung verschickt
 * wurde, ist ein Kennzeichen am Beleg, kein Zustandswechsel — sie war vorher
 * fertig (`abgeschlossen`) und ist es nachher.
 *
 * Bei normalen Rechnungen sagt der Status `versendet` dasselbe bereits; dort
 * ist das Badge redundant und wird nicht ausgegeben.
 */
export function istVersandt(input: InvoiceBadgeInput): boolean {
  if (input.invoiceType !== "stornorechnung") return false;
  return input.sentAt !== null;
}

/** Alle zutreffenden Badges einer Rechnung. Reihenfolge = Anzeigereihenfolge. */
export function invoiceBadges(input: InvoiceBadgeInput): InvoiceBadge[] {
  const badges: InvoiceBadge[] = [];
  if (istTeilweiseBezahlt(input)) badges.push("teilweise_bezahlt");
  if (istUeberfaellig(input)) badges.push("ueberfaellig");
  if (istVersandt(input)) badges.push("versandt");
  return badges;
}
