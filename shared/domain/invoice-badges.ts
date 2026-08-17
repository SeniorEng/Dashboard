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
  /** Fälligkeitsdatum (ISO) — Anker für Selbstzahler/Privat. */
  dueDate: string | null;
  /** Versanddatum (ISO) — Anker für Pflegekassen, und Quelle des Versandt-Badges. */
  sentAt: string | null;
  /** Zahler-Typ. Siehe Kommentar bei `istUeberfaellig`. */
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
 * Ist die Rechnung unbezahlt und die Frist überschritten?
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
export function istUeberfaellig(input: InvoiceBadgeInput, fristTage: number): boolean {
  if (input.status !== "versendet") return false;
  if (input.paidCents >= input.grossAmountCents) return false;

  const selbstzahler = input.billingType === "selbstzahler" || input.billingType === "privat";
  const anker = selbstzahler ? input.dueDate : input.sentAt;
  if (!anker) return false;

  const tage = tageZwischen(anker, input.asOfIso);
  // Beim Selbstzahler IST das Fälligkeitsdatum die Frist; bei der Kasse zählt
  // die Wartefrist ab Versand.
  return selbstzahler ? tage > 0 : tage > fristTage;
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
export function invoiceBadges(input: InvoiceBadgeInput, fristTage: number): InvoiceBadge[] {
  const badges: InvoiceBadge[] = [];
  if (istTeilweiseBezahlt(input)) badges.push("teilweise_bezahlt");
  if (istUeberfaellig(input, fristTage)) badges.push("ueberfaellig");
  if (istVersandt(input)) badges.push("versandt");
  return badges;
}

/** Ganztägige Differenz `asOf - anker` in Tagen. */
function tageZwischen(ankerIso: string, asOfIso: string): number {
  const a = new Date(`${ankerIso.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${asOfIso.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.floor((b - a) / 86_400_000);
}
