/**
 * Task #1405 — Abrechnung als Single Source of Truth (Pipeline-Board).
 *
 * Diese Datei ist die PURE Domänen-Schicht des gemeinsamen
 * `billing-pipeline-reader` (Q4): Stage- und Aging-Zuordnung als reine,
 * deterministische Funktionen ohne DB-/Netzwerk-Zugriff. Sie KOMPONIERT die
 * bestehenden SSoT-Prädikate (`isAppointmentDocumentedAndSigned`,
 * `INVOICE_STATUSES`), statt sie zu re-implementieren.
 *
 * Leitprinzip (Q1): „Eine Karte kann in N Stufen erscheinen, aber jeder € lebt
 * in genau EINER Stufe." Die Stage-Zuordnung einer Atomic-Unit (Termin VOR
 * Topf-Split, Rechnung NACH Topf-Split) ist daher TOTAL und DISJUNKT — exakt
 * genau eine Zuordnung pro Eingabe (verankert in
 * `tests/architecture/billing-pipeline-stage-identity.test.ts`).
 *
 * Geldbeträge sind ausnahmslos Integer-Cents.
 */
import type { AppointmentStatus } from "./appointments";
import type { InvoiceStatus } from "../schema/billing";
import { parseLocalDate } from "../utils/datetime";
import {
  isPflegekasseBillingType,
  isServiceRecordSignedForBilling,
} from "./billing-eligibility";

// ============================================
// PIPELINE-STUFEN (SSoT) — nur bestehende Status
// ============================================

/**
 * Die EINE Status-Pipeline (geordnet). Spiegelt den fachlichen
 * Monats-Lebenszyklus wider — keine neuen Status, nur Sichten auf bestehende
 * Termin-/Service-Record-/Rechnungs-Status.
 */
export const PIPELINE_STAGES = [
  "offen",
  "dokumentiert",
  "unterschrieben",
  "rechnung_erstellt",
  "versendet",
  "bezahlt",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  offen: "Offen",
  dokumentiert: "Dokumentiert",
  unterschrieben: "Unterschrieben",
  rechnung_erstellt: "Rechnung erstellt",
  versendet: "Versendet",
  bezahlt: "Bezahlt",
};

/**
 * Side-/Endzustände — KEIN Pipeline-Schritt, sondern Badges. Ihre € fließen
 * NICHT in die Stufen-Summen, werden aber separat ausgewiesen (Q1:
 * „Gesamtumsatz = Σ über alle Stufen + Side-Badges").
 */
export const PIPELINE_SIDE_STATES = [
  "storniert",
  // Storno-DOKUMENT (`invoice_type = 'stornorechnung'`, Status
  // `abgeschlossen`). Eigener Zustand, nicht mit „storniert" vermischt: eine
  // stornierte RECHNUNG und das STORNO-DOKUMENT dazu sind zwei verschiedene
  // Dinge, und die Trennung ist der Punkt (siehe `storniertesDokumentTraegtKeineForderung`).
  "storno_dokument",
  "kunde_nicht_angetroffen",
  "nicht_abgerechnet",
  "wartet_auf_kundenunterschrift",
] as const;
export type PipelineSideState = (typeof PIPELINE_SIDE_STATES)[number];

/**
 * Task #1879 — Side-Zustände, deren € als ERWARTETER Umsatz gelten und daher
 * in die Gesamt-Umsatz-Sicht der Pipeline-Karte einfließen. „Wartet auf
 * Kundenunterschrift" ist dokumentierte Arbeit, die abgerechnet wird, sobald
 * der Kunde unterschreibt — also erwarteter Umsatz, kein Sackgassen-Zustand.
 *
 * Bewusst NICHT enthalten (kein erwarteter Umsatz):
 *   • „Storniert"               — storniert, wird nie abgerechnet.
 *   • „Kunde nicht angetroffen" — entgangener Termin.
 *   • „Nicht abgerechnet"       — Frist abgelaufen, nicht mehr abrechenbar.
 *
 * Dies ist die EINE Quelle dafür, welche Side-Zustände zum erwarteten Umsatz
 * zählen — Server und Karte lesen dieselbe Definition.
 */
export const EXPECTED_REVENUE_SIDE_STATES = [
  "wartet_auf_kundenunterschrift",
] as const satisfies readonly PipelineSideState[];

export const PIPELINE_SIDE_STATE_LABELS: Record<PipelineSideState, string> = {
  storniert: "Storniert",
  storno_dokument: "Storno-Dokument",
  kunde_nicht_angetroffen: "Kunde nicht angetroffen",
  nicht_abgerechnet: "Nicht abgerechnet",
  // Task #1874: Pflegekasse-Termin ist nur vom Mitarbeiter unterschrieben
  // (`employee_signed`) — die Kundenunterschrift auf dem Leistungsnachweis fehlt,
  // daher NOCH nicht abrechenbar. Sein € ist sichtbar, zählt aber NICHT in die
  // Stufe „Unterschrieben" (= bereit zum Abrechnen).
  //
  // Task #1905 — Beschriftung wortgleich zum Cluster „Leistungsnachweis fehlt"
  // der Karte „Noch zu erstellen": Ohne Kundenunterschrift ist der
  // Leistungsnachweis nicht gültig, und beide Ansichten beantworten hier
  // dieselbe fachliche Frage. Der Schlüssel (`wartet_auf_kundenunterschrift`)
  // und die €-Zuordnung bleiben unverändert — er ist über
  // `EXPECTED_REVENUE_SIDE_STATES` an die Umsatz-Sicht gebunden; nur die
  // Beschriftung wird angeglichen, damit Karte und Liste dieselbe Sprache
  // sprechen.
  wartet_auf_kundenunterschrift: "Leistungsnachweis fehlt",
};

/**
 * Eine Atomic-Unit wird genau einem dieser drei Ausgänge zugeordnet:
 *  - `stage`    → eine Pipeline-Stufe (trägt € in die Stufen-Summe).
 *  - `side`     → ein Side-Badge (trägt € in die Side-Summe, nicht in Stufen).
 *  - `excluded` → keine Umsatz-tragende Einheit an dieser Stelle:
 *       `invoiced`  = Termin wurde abgerechnet, sein € lebt jetzt auf der
 *                     Rechnung (Hybrid-Bruchkante, vermeidet Doppelzählung).
 *       `cancelled` = stornierter Termin ohne Umsatz.
 */
export type PipelineExclusionReason = "invoiced" | "cancelled";

export type PipelineAssignment =
  | { kind: "stage"; stage: PipelineStage }
  | { kind: "side"; state: PipelineSideState }
  | { kind: "excluded"; reason: PipelineExclusionReason };

// ============================================
// TERMIN → STUFE (frühe Stufen, VOR Topf-Split)
// ============================================

export interface AppointmentPipelineInput {
  /** Persistierter Termin-Status (oder abgeleitetes `expired_unsigned`). */
  status: AppointmentStatus;
  /**
   * Task #1874 — Zahler-Typ des Kunden (`billingType`). Entscheidet, welche
   * Unterschrift den Termin abrechenbar macht: Pflegekasse verlangt die
   * Kundenunterschrift, Selbstzahler genügt die Mitarbeiter-Unterschrift.
   */
  billingType: string | null | undefined;
  /**
   * Direkte Unterschrift am Termin (`signature_data IS NOT NULL`). Eine am
   * Termin erfasste Kundenunterschrift gilt für BEIDE Zahler-Typen als
   * abrechenbar.
   */
  hasDirectSignature: boolean;
  /**
   * Es existiert ein aktiver Leistungsnachweis mit `status='completed'`
   * (Kundenunterschrift). Macht den Termin für beide Zahler-Typen abrechenbar.
   */
  hasCompletedServiceRecord: boolean;
  /**
   * Es existiert ein aktiver Leistungsnachweis mit `status='employee_signed'`
   * (nur Mitarbeiter-Unterschrift). Reicht bei Selbstzahler zur Abrechnung,
   * bei Pflegekasse NICHT (dort fehlt die Kundenunterschrift).
   */
  hasEmployeeSignedServiceRecord: boolean;
  /**
   * True, wenn der Termin bereits über eine nicht-stornierte Rechnung
   * abgerechnet ist. Dann verlässt er die Termin-Stufen und sein € lebt auf
   * der Rechnung (Hybrid-Einheit, Q1/D1).
   */
  isInvoiced: boolean;
}

/**
 * Task #1874 — „abrechenbar unterschrieben" für die Pipeline. Nutzt DASSELBE
 * Gate wie der Rechnungs-Pfad (`isServiceRecordSignedForBilling`,
 * `shared/domain/billing-eligibility.ts`), damit die Stufe „Unterschrieben"
 * (= bereit zum Abrechnen) NIE mit der tatsächlichen Abrechenbarkeit
 * auseinanderdriftet:
 *   • Selbstzahler: `employee_signed` ODER `completed` genügt.
 *   • Pflegekasse:  NUR `completed` (Kundenunterschrift) zählt.
 * Eine direkt am Termin erfasste Unterschrift ist eine echte Kundenunterschrift
 * und zählt für beide Zahler-Typen.
 */
function isAppointmentBillableSigned(input: AppointmentPipelineInput): boolean {
  return (
    input.hasDirectSignature ||
    (input.hasCompletedServiceRecord &&
      isServiceRecordSignedForBilling(input.billingType, "completed")) ||
    (input.hasEmployeeSignedServiceRecord &&
      isServiceRecordSignedForBilling(input.billingType, "employee_signed"))
  );
}

/**
 * Ordnet einen Termin GENAU einem Pipeline-Ausgang zu (total + disjunkt).
 *
 * | Quelle                                            | Ausgang                             |
 * | ------------------------------------------------- | ----------------------------------- |
 * | `scheduled` / `documenting`                       | Stufe „Offen"                       |
 * | `completed`, nicht abrechenbar signiert           | Stufe „Dokumentiert"                |
 * | `completed`, abrechenbar signiert                 | Stufe „Unterschrieben"              |
 * | `completed`, Pflegekasse nur `employee_signed`    | Side „Wartet auf Kundenunterschrift"|
 * | bereits abgerechnet                               | excluded „invoiced"                 |
 * | `cancelled`                                       | excluded „cancelled"                |
 * | `customer_no_show`                                | Side „Kunde nicht angetroffen"      |
 * | `expired_unsigned` (abgeleitet)                   | Side „Nicht abgerechnet"            |
 */
export function assignAppointmentStage(input: AppointmentPipelineInput): PipelineAssignment {
  const { status } = input;

  // Terminale Side-/Excluded-Zustände haben Vorrang vor „abgerechnet?",
  // damit ein stornierter/No-Show-Termin nie als Umsatz erscheint.
  if (status === "cancelled") return { kind: "excluded", reason: "cancelled" };
  if (status === "customer_no_show") return { kind: "side", state: "kunde_nicht_angetroffen" };
  if (status === "expired_unsigned") return { kind: "side", state: "nicht_abgerechnet" };

  // Abgerechnete Termine: € lebt auf der Rechnung (keine Doppelzählung).
  if (input.isInvoiced) return { kind: "excluded", reason: "invoiced" };

  if (status === "scheduled" || status === "documenting") {
    return { kind: "stage", stage: "offen" };
  }
  // status === "completed"
  if (isAppointmentBillableSigned(input)) {
    return { kind: "stage", stage: "unterschrieben" };
  }
  // Task #1874: Pflegekasse-Termin nur mit Mitarbeiter-Unterschrift (LN
  // `employee_signed`, keine Kundenunterschrift) — sichtbar, aber NICHT
  // abrechenbar. Eigener Side-Zustand statt „Unterschrieben", damit die Stufe
  // „bereit zum Abrechnen" mit der Eligibility-Sicht („Bereit zum Abrechnen")
  // rekonziliert.
  if (
    isPflegekasseBillingType(input.billingType) &&
    input.hasEmployeeSignedServiceRecord
  ) {
    return { kind: "side", state: "wartet_auf_kundenunterschrift" };
  }
  return { kind: "stage", stage: "dokumentiert" };
}

// ============================================
// RECHNUNG → STUFE (späte Stufen, NACH Topf-Split)
// ============================================

export interface InvoicePipelineInput {
  /**
   * Rechnungs-Status. TYPISIERT, nicht `string` — und das ist der halbe Punkt
   * des Umbaus: solange hier `string` stand, war `INVOICE_STATUSES` eine
   * Dekoration. Der erschöpfende `switch` unten fängt einen vergessenen Zweig
   * nur, wenn der Eingang die Union kennt.
   */
  status: InvoiceStatus;
  /** Rechnungs-Typ (`INVOICE_TYPES`): rechnung | stornorechnung | nachberechnung. */
  invoiceType: string;
}

/**
 * SSoT: **Trägt dieses Dokument einen offenen Forderungsbetrag?**
 *
 * Nein für Storno-Dokumente — ausdrückliche Regel, kein Nebeneffekt einer
 * Enum-Zuordnung (Spec, Abschnitt 4.4).
 *
 * Der Betrag, den ein Storno-Dokument aufhebt, ist bereits am ORIGINAL
 * herausgerechnet: dort steht `storniert`, und stornierte Rechnungen zählen in
 * keine Stufe. Beide mitzuzählen wäre eine Doppelzählung — auf der
 * Referenz-Kopie −15.884,35 €, was die Stufe `versendet` von 23.748,53 € auf
 * rund 7.864 € drücken würde. Eine Zahl, die nichts Reales beschreibt.
 *
 * Warum das eine eigene Funktion ist und kein `if` im Zuordnungs-Code: bis zu
 * diesem Umbau folgte der Ausschluss IMPLIZIT daraus, dass der Typ
 * `stornorechnung` in den Side-Zustand „storniert" fiel. Sobald der Typ
 * aufhört, den Zustand zu bestimmen, verschwände er lautlos mit ihm — ohne
 * dass ein Test rot würde. Verankert in
 * `tests/billing/storno-ohne-forderung.test.ts`.
 */
export function traegtOffeneForderung(input: { invoiceType: string }): boolean {
  return input.invoiceType !== "stornorechnung";
}

/**
 * SSoT: **Ist dieses Dokument aktionsfähig?** — also weder storniert noch ein
 * Storno-Beleg. Genau die Menge, aus der Listen auswählen, Massenaktionen
 * schöpfen und Drucklisten sich speisen.
 *
 * ── Warum es diese Funktion GEBEN MUSS ──────────────────────────────────
 * Bis zum Status-Umbau beantwortete `isStorniertInvoice` diese Frage
 * mit — es prüfte `status = 'storniert' ODER invoiceType = 'stornorechnung'`.
 * Sieben Aufrufer schrieben deshalb `!isStorniertInvoice(...)` und meinten
 * damit „aktionsfähig".
 *
 * Seit der Typ nichts mehr über den Zustand aussagt, prüft
 * `isStorniertInvoice` nur noch den Status — und `!isStorniertInvoice(...)`
 * hätte Storno-BELEGE plötzlich als aktionsfähig durchgelassen: auswählbar in
 * der Liste, Kandidat für Massenaktionen, in der Druckliste. Lautlos, weil
 * kein Typ mehr widerspricht.
 *
 * Der Name sagt jetzt, was gemeint ist, statt sich auf eine Nebenwirkung zu
 * verlassen.
 *
 * ── Zugleich der TS-Zwilling der Aktive-Rechnung-SSoT ───────────────────
 * Diese Funktion ist wörtlich die Negation von `activeInvoiceCondition()` /
 * `activeInvoiceSqlRaw()` (`server/lib/appointment-invoiced.ts`): dort
 * `status <> 'storniert' AND invoice_type <> 'stornorechnung'`, hier dasselbe
 * als Prädikat auf geladenen Objekten.
 *
 * Diese Rolle hatte vor dem Umbau `isStorniertInvoice` — sie ging beim
 * Verengen auf den Status verloren, und `tests/unit/active-invoice-ssot.test.ts`
 * hat den Bruch gefangen. Wer eine der drei Formen ändert, ändert alle drei.
 */
export function istAktionsfaehigeRechnung(input: { status: string; invoiceType: string }): boolean {
  return traegtOffeneForderung(input) && !isStorniertInvoice(input);
}

/**
 * SSoT-Prädikat „Storniert-Side-Zustand" einer Rechnung: stornierter Status
 * (`status='storniert'`) ODER Gutschrift-Typ (`invoiceType='stornorechnung'`).
 * Wird von `assignInvoiceStage` UND vom Zahlungs-Zuordnungs-Picker
 * (`/billing/open-for-match`) genutzt, damit „was ist eine stornierte
 * Rechnung?" nur an EINER Stelle definiert ist.
 */
export function isStorniertInvoice(input: { status: string }): boolean {
  // NUR noch der Status. Der Typ sagt seit dem Umbau nichts mehr über den
  // Zustand aus: ein Storno-DOKUMENT ist `abgeschlossen`, nicht storniert.
  // Wer wissen will, ob ein Dokument eine offene Forderung trägt, fragt
  // `traegtOffeneForderung`.
  return input.status === "storniert";
}

/**
 * Ordnet eine Rechnung GENAU einem Pipeline-Ausgang zu (total + disjunkt).
 *
 * Stornierte Rechnungen (`status='storniert'`) und Gutschriften
 * (`invoiceType='stornorechnung'`) sind Side-Zustand „Storniert" und tragen
 * nicht in die Stufen-Summen ein (konsistent mit dem Default „Stornos
 * ausblenden" und der Umsatz-Statistik, die stornierte Rechnungen ausschließt).
 */
export function assignInvoiceStage(input: InvoicePipelineInput): PipelineAssignment {
  // Storno-DOKUMENT zuerst: es trägt keine offene Forderung (siehe
  // `traegtOffeneForderung`) und gehört deshalb in keine Stufe — unabhängig
  // davon, welchen Status es trägt.
  if (!traegtOffeneForderung(input)) {
    return { kind: "side", state: "storno_dokument" };
  }
  switch (input.status) {
    case "entwurf":
      return { kind: "stage", stage: "rechnung_erstellt" };
    case "versendet":
      return { kind: "stage", stage: "versendet" };
    case "bezahlt":
      return { kind: "stage", stage: "bezahlt" };
    case "storniert":
      return { kind: "side", state: "storniert" };
    case "abgeschlossen":
      // `abgeschlossen` ist Storno-Dokumenten vorbehalten — die sind oben
      // schon abgefangen. Trägt eine normale Rechnung diesen Status, ist das
      // ein Datenfehler und kein Anzeigefall.
      throw new Error(
        `Status "abgeschlossen" ist Storno-Dokumenten vorbehalten, hier aber auf invoiceType="${input.invoiceType}"`,
      );
    default:
      // KEIN stiller Auffang mehr. Die frühere „konservative" Einordnung auf
      // `rechnung_erstellt` hat genau den Fehler erzeugt, den dieser Umbau
      // behebt: `teilweise_bezahlt` fiel bei seiner Einführung unbemerkt hier
      // hinein und zählte im Cockpit-Board neben den Entwürfen.
      //
      // `never` erzwingt, dass jeder neue Status einen Zweig bekommt — der
      // Compiler bricht, sobald `INVOICE_STATUSES` wächst.
      return assertNieErreicht(input.status, "assignInvoiceStage");
  }
}

/**
 * Erschöpfungs-Wächter. Im Typsystem unerreichbar; zur Laufzeit die zweite
 * Lage für Werte, die aus der Datenbank kommen und die Union verletzen.
 */
function assertNieErreicht(wert: never, wo: string): never {
  throw new Error(`${wo}: unbekannter Wert "${String(wert)}" — Union und Daten laufen auseinander.`);
}

// ============================================
// HANDLUNGS-CLUSTER (Rechnungsliste) — Sicht auf bestehende Status
// ============================================

/**
 * Handlungs-Cluster der Rechnungsliste (Task #1412). Reine SICHT auf die
 * bestehenden Rechnungs-Status + den Zahler-Typ — KEIN neues Status-/Datenmodell.
 * Jede Rechnung gehört GENAU einem Cluster an (total + disjunkt):
 *
 *  - `zu_versenden`        — Entwurf (`entwurf`), noch nicht raus.
 *  - `avis_ausstehend`     — an Pflegekassen versendete Rechnung (`versendet`),
 *                            Zahlungsavis steht noch aus.
 *  - `zahlung_ausstehend`  — Selbstzahler/Privat versendet (`versendet`) ODER
 *                            Pflegekasse mit eingegangenem Avis (`avis_erhalten`).
 *  - `abgeschlossen`       — bezahlt (`bezahlt`).
 *  - `storniert`           — stornierte Rechnung / Gutschrift (Side-Zustand der
 *                            Pipeline). Standardmäßig ausgeblendet (Stornos-Filter),
 *                            hier nur, damit die Zuordnung total bleibt.
 */
export const INVOICE_ACTION_CLUSTERS = [
  "zu_versenden",
  // `avis_ausstehend` ist mit dem Empfaenger-Unterschied ENTFALLEN: Kasse und
  // Selbstzahler warten beide auf Zahlung, der Avis ist eine
  // Zuordnungs-Mechanik. `teilzahlung` ist ENTFALLEN: sie ist ein Badge.
  "zahlung_ausstehend",
  "zahlung_zugeordnet_pruefung",
  "abgeschlossen",
  "storniert",
] as const;
export type InvoiceActionCluster = (typeof INVOICE_ACTION_CLUSTERS)[number];

export const INVOICE_ACTION_CLUSTER_LABELS: Record<InvoiceActionCluster, string> = {
  zu_versenden: "Noch zu versenden",
  zahlung_ausstehend: "Zahlung ausstehend",
  zahlung_zugeordnet_pruefung: "Zahlung zugeordnet – Prüfung",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

/**
 * Die beiden Cluster, in denen eine Rechnung ALTERT (Mahn-/Wartelauf). Genau
 * hier — und nur hier — wird die Aging-Ampel berechnet.
 *
 * Das ist die geteilte Regel für Schritt 5 aus #1897: Sie ERSETZT die frühere
 * stufen-basierte Bedingung im Cockpit-Reader
 * (`stage === "versendet" || stage === "avis_erhalten"`), die die
 * Zahlungsbindung nicht kannte. Ergebnis dort war, dass eine Rechnung mit
 * längst eingegangener Zahlung weiter alterte und in `overdueCount` als
 * überfällig gezählt wurde — die Abrechnung mahnte Geld an, das auf dem Konto
 * lag.
 *
 * Weil die Liste (`client/src/features/billing/utils.ts` →
 * `invoiceAgingBucket`) schon immer über den Cluster gatet, lesen mit dieser
 * Funktion beide Seiten dieselbe Wahrheit: sobald eine Zahlung gebunden ist,
 * fällt die Rechnung in `zahlung_zugeordnet_pruefung` — und altert damit auf
 * BEIDEN Seiten nicht mehr.
 */
export function isAgingCluster(cluster: InvoiceActionCluster): boolean {
  // Nur noch EIN Warte-Cluster: `avis_ausstehend` ist mit dem
  // Empfaenger-Unterschied entfallen. Die Regel selbst ist unveraendert —
  // altern tut, wer auf Zahlung wartet.
  return cluster === "zahlung_ausstehend";
}

export interface InvoiceClusterInput {
  /** Rechnungs-Status, typisiert wie bei `InvoicePipelineInput`. */
  status: InvoiceStatus;
  /** Rechnungs-Typ (`INVOICE_TYPES`). */
  invoiceType: string;
  /**
   * Zahler-Typ. Fuer den CLUSTER nicht mehr gebraucht (Empfaenger-Unterschied
   * raus aus dem Modell), bleibt aber im Eingang: der Aging-Anker braucht ihn,
   * und die Aufrufer reichen dasselbe Objekt in beide Funktionen.
   */
  billingType: string;
  /**
   * Hängt an dieser Rechnung eine gebundene Qonto-Zahlung? Quelle ist
   * ausschließlich `qontoStorage.getClaimedInvoiceIds` (1:1-Match ODER Mitglied
   * eines an eine Transaktion gebundenen Avis) — hier wird NICHT nachgerechnet.
   *
   * Optional und `false`-default, damit Aufrufer, die diese Frage nicht
   * beantworten können (z.B. reine Status-Ansichten), unverändert weiterlaufen:
   * ohne die Angabe bleibt die Zuordnung exakt die von vorher.
   */
  hasBoundPayment?: boolean;
}

/**
 * Ordnet eine Rechnung GENAU einem Handlungs-Cluster zu (total + disjunkt).
 *
 * KOMPONIERT die bestehende `assignInvoiceStage`-SSoT und den Zahler-Typ-Pfad
 * aus `agingModelForBillingType` — es wird KEINE zweite, parallele Status-Logik
 * erfunden. Verankert in
 * `tests/architecture/billing-pipeline-stage-identity.test.ts`.
 */
export function assignInvoiceActionCluster(input: InvoiceClusterInput): InvoiceActionCluster {
  const assignment = assignInvoiceStage({
    status: input.status,
    invoiceType: input.invoiceType,
  });
  // assignInvoiceStage liefert für Rechnungen als einzigen Side-Zustand
  // „storniert" (Storno-Status oder Gutschrift-Typ). Der `excluded`-Ausgang
  // tritt für Rechnungen nicht auf (nur Termin-Pfad) — wird aber, falls er je
  // entstünde, ebenfalls dem Storniert-Cluster zugeordnet, damit die Zuordnung
  // total bleibt.
  if (assignment.kind === "side") {
    // Ein Storno-DOKUMENT ist fertig — dieselbe Aussage wie bei einer bezahlten
    // Rechnung, deshalb derselbe Cluster. Der Status sagt WARUM etwas fertig
    // ist, der Cluster sagt DASS.
    return assignment.state === "storno_dokument" ? "abgeschlossen" : "storniert";
  }
  if (assignment.kind !== "stage") return "storniert";

  // Gebundene Zahlung schlägt den Wartelauf: Das Geld ist da, es fehlt nur die
  // Entscheidung (Volldeckung freigeben, Überzahlung klären).
  if (input.hasBoundPayment === true && assignment.stage === "versendet") {
    return "zahlung_zugeordnet_pruefung";
  }

  switch (assignment.stage) {
    case "rechnung_erstellt":
      return "zu_versenden";
    case "versendet":
      // Der ZAHLER-TYP kommt hier nicht mehr vor. Das ist die konkrete Wirkung
      // von „Empfänger-Unterschied raus aus dem Modell": Kasse und Selbstzahler
      // warten beide auf Zahlung. Der Avis ist eine Zuordnungs-Quelle, kein
      // eigener Wartezustand.
      return "zahlung_ausstehend";
    case "bezahlt":
      return "abgeschlossen";
    default:
      // Termin-Stufen (offen/dokumentiert/unterschrieben) treten für Rechnungen
      // nicht auf; konservativ als „zu_versenden" behandeln, damit die Zuordnung
      // total bleibt (kein stiller Verlust einer Rechnung).
      return "zu_versenden";
  }
}

// ============================================
// AGING-AMPEL (Q5) — drei getrennte Modelle, pur berechnet
// ============================================

export type AgingBucket = "none" | "green" | "yellow" | "orange" | "red";

/**
 * Aging-Modell je Karten-/Rechnungs-Kontext:
 *  - `selbstzahler`        — Anker `dueDate` (4 Stufen inkl. Mahnstufen).
 *  - `pflegekasse_pre_avis`— Anker `versendetAm` (vor Avis-Eingang).
 *  - `pflegekasse_post_avis`— Anker `avisErhaltenAm` (nach Avis, vor Zahlung).
 */
export type AgingModel = "selbstzahler" | "pflegekasse_pre_avis" | "pflegekasse_post_avis";

/**
 * Leitet das Aging-Modell (und damit den Zahler-Typ-Pfad) aus dem `billingType`
 * einer Rechnung ab. Dies ist die EINE Quelle für die fachliche Unterscheidung
 * „rechnet direkt gegen den Kunden ab (Selbstzahler/Privat) vs. läuft über den
 * Pflegekassen-Avis-Pfad". Der Abrechnungs-Pipeline-Reader (`server/storage/
 * billing/pipeline-reader.ts`) UND die Handlungs-Cluster der Rechnungsliste
 * (`assignInvoiceActionCluster`) lesen dieselbe Funktion, damit Aging-Anker und
 * Cluster-Zuordnung nie auseinanderdriften.
 */
export function agingModelForBillingType(billingType: string): AgingModel {
  // Selbstzahler/Privat rechnen direkt gegen den Kunden ab (Fälligkeits-Aging).
  if (billingType === "selbstzahler" || billingType === "privat") return "selbstzahler";
  // Pflegekasse: vor Avis-Eingang am Versanddatum verankert.
  return "pflegekasse_pre_avis";
}

/** Ganztägige Differenz `asOf - anchor` in Tagen (kann negativ sein). */
export function daysBetweenIso(anchorIso: string, asOfIso: string): number {
  const anchor = parseLocalDate(anchorIso);
  const asOf = parseLocalDate(asOfIso);
  const a = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const b = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * Ordnet einen Aging-Bucket zu (pure). `anchorIso === null` ⇒ `none`
 * (z. B. eine noch nicht versendete Pflegekassen-Rechnung hat keinen
 * `versendetAm`-Anker).
 */
export function resolveAgingBucket(
  model: AgingModel,
  anchorIso: string | null,
  asOfIso: string,
): AgingBucket {
  if (!anchorIso) return "none";
  const days = daysBetweenIso(anchorIso, asOfIso);
  switch (model) {
    case "selbstzahler":
      // Anker = Fälligkeitsdatum. days = Tage ÜBER Fälligkeit.
      if (days <= 0) return "green"; // 0–14 T vor Fälligkeit (und früher)
      if (days <= 14) return "yellow"; // 1–14 T über (Erinnerung)
      if (days <= 30) return "orange"; // 15–30 T (Mahnstufe 1)
      return "red"; // 31+ T (Mahnstufe 2/Inkasso)
    case "pflegekasse_pre_avis":
      // Anker = Versanddatum.
      if (days <= 21) return "green";
      if (days <= 45) return "yellow"; // nachhaken
      return "red"; // Eskalation
    case "pflegekasse_post_avis":
      // Anker = Avis-Eingangsdatum.
      if (days <= 14) return "green";
      if (days <= 30) return "yellow";
      return "red";
  }
}

// ============================================
// €-KONSERVIERUNG (Q1) — pure Aggregation
// ============================================

/** Eine Atomic-Unit mit ihrer Zuordnung + ihrem €-Beitrag (Integer-Cents). */
export interface PipelineAtomicUnit {
  assignment: PipelineAssignment;
  cents: number;
}

export interface PipelineCentsSummary {
  /** €-Summe pro Pipeline-Stufe (Integer-Cents). */
  stageCents: Record<PipelineStage, number>;
  /** €-Summe pro Side-Badge (Integer-Cents). */
  sideCents: Record<PipelineSideState, number>;
  /** Σ über alle Stufen (ohne Side-Badges). */
  stageTotalCents: number;
  /** Σ über alle Side-Badges. */
  sideTotalCents: number;
  /** Σ Stufen + Side-Badges = Gesamtumsatz-Sicht (Q1). */
  grandTotalCents: number;
  /**
   * Task #1879 — Erwarteter Umsatz: Σ Stufen + die als erwarteten Umsatz
   * geltenden Side-Zustände (`EXPECTED_REVENUE_SIDE_STATES`, aktuell nur
   * „Wartet auf Kundenunterschrift"). Storniert / Kunde nicht angetroffen /
   * Nicht abgerechnet bleiben ausgeschlossen. Dies ist die Gesamt-Umsatz-Zahl
   * der Status-Pipeline-Karte.
   */
  expectedRevenueTotalCents: number;
}

function emptyStageRecord(): Record<PipelineStage, number> {
  return PIPELINE_STAGES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<PipelineStage, number>,
  );
}

function emptySideRecord(): Record<PipelineSideState, number> {
  return PIPELINE_SIDE_STATES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<PipelineSideState, number>,
  );
}

/**
 * Aggregiert Atomic-Units zu €-Summen je Stufe/Side-Badge. Jede Einheit trägt
 * ihren € zu GENAU einem Topf bei (Stufe ODER Side); `excluded`-Einheiten
 * tragen nichts bei (ihr € lebt anderswo). Damit gilt per Konstruktion die
 * €-Konservierung „jeder € in genau einer Stufe".
 */
export function summarizePipelineCents(units: PipelineAtomicUnit[]): PipelineCentsSummary {
  const stageCents = emptyStageRecord();
  const sideCents = emptySideRecord();
  for (const unit of units) {
    if (unit.assignment.kind === "stage") {
      stageCents[unit.assignment.stage] += unit.cents;
    } else if (unit.assignment.kind === "side") {
      sideCents[unit.assignment.state] += unit.cents;
    }
    // excluded: kein €-Beitrag
  }
  const stageTotalCents = PIPELINE_STAGES.reduce((sum, s) => sum + stageCents[s], 0);
  const sideTotalCents = PIPELINE_SIDE_STATES.reduce((sum, s) => sum + sideCents[s], 0);
  const expectedRevenueSideCents = EXPECTED_REVENUE_SIDE_STATES.reduce(
    (sum, s) => sum + sideCents[s],
    0,
  );
  return {
    stageCents,
    sideCents,
    stageTotalCents,
    sideTotalCents,
    grandTotalCents: stageTotalCents + sideTotalCents,
    expectedRevenueTotalCents: stageTotalCents + expectedRevenueSideCents,
  };
}
