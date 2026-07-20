/**
 * Task #1456 — Pre-Commit-Review Eligibilität (Phase 2): PURE SSoT der
 * Abrechnungs-Berechtigung pro Kunde.
 *
 * Diese Datei spiegelt EXAKT die Signatur-/Termin-Akzeptanz des echten
 * Generate-Pfads (`buildInvoiceDraft` in `server/services/invoice-calc.ts`). Der
 * Generate-Pfad importiert dieselben Helfer/Meldungen aus dieser Datei — es gibt
 * KEINE zweite Kopie der Regel, damit Review-Vorschau und tatsächliche
 * Erstellung niemals auseinanderdriften (Eligible im Review ⇒ Generate akzeptiert;
 * Blocked im Review ⇒ Generate lehnt mit identischer Begründung ab).
 *
 * Reine Domänen-Schicht: keine DB, keine Seiteneffekte, Integer-Cents irrelevant
 * (hier wird nicht gerechnet, nur klassifiziert).
 */

/** Maschinenlesbarer Grund, warum ein Kunde NICHT abgerechnet werden kann. */
export type BillingBlockReason =
  | "customer_signature_required"
  | "not_signed"
  | "no_appointments"
  | "already_billed";

/**
 * Wortgleiche Begründungen — identisch zu den `badRequest`-Meldungen, die
 * `buildInvoiceDraft` wirft. Der Generate-Pfad konsumiert diese Konstanten,
 * sodass Anzeige (Review) und Ablehnung (Generate) garantiert denselben Text
 * verwenden.
 */
export const BILLING_BLOCK_MESSAGES: Record<BillingBlockReason, string> = {
  customer_signature_required:
    "Bei Pflegekassen-Abrechnung muss der Leistungsnachweis vom Kunden unterschrieben sein — eine reine Mitarbeiter-Unterschrift genügt nicht.",
  not_signed:
    "Der Leistungsnachweis wurde noch nicht unterschrieben. Bitte lassen Sie den Leistungsnachweis zuerst vom Mitarbeiter unterschreiben.",
  no_appointments: "Der Leistungsnachweis enthält keine Termine.",
  already_billed: "Alle Termine aus dem Leistungsnachweis wurden bereits abgerechnet.",
};

/**
 * Task #1786 — Prägnante Kurz-Labels für die Inline-Anzeige in der Kundenzeile
 * (Karte „Noch zu erstellen"). Die ausführlichen Meldungen (`BILLING_BLOCK_MESSAGES`)
 * bleiben für Dialog/Vorschau; hier genügt ein knapper Grund-Hinweis im dezenten
 * Stil des bestehenden „noch X geplante Termine"-Vermerks.
 */
export const BILLING_BLOCK_SHORT_LABELS: Record<BillingBlockReason, string> = {
  customer_signature_required: "Kundenunterschrift fehlt",
  not_signed: "Nicht unterschrieben",
  no_appointments: "Keine Termine",
  already_billed: "Bereits abgerechnet",
};

/** Pflegekassen-Abrechnung (gesetzlich/privat) verlangt die Kundenunterschrift. */
export function isPflegekasseBillingType(billingType: string | null | undefined): boolean {
  return billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat";
}

/**
 * Akzeptanz-Regel einer einzelnen Leistungsnachweis-Zeile (Task #1074):
 *  • Pflegekasse: NUR `completed` (Kundenunterschrift) zählt.
 *  • Selbstzahler: `completed` ODER `employee_signed`.
 * Identisch zur Filter-Logik in `buildInvoiceDraft`.
 */
export function isServiceRecordSignedForBilling(
  billingType: string | null | undefined,
  status: string,
): boolean {
  return isPflegekasseBillingType(billingType)
    ? status === "completed"
    : status === "completed" || status === "employee_signed";
}

/**
 * Task #1625 — Fakten der Dokumentations-Abdeckung eines Kunden im Zeitraum:
 * dokumentierte (`completed`) Termine vs. die davon durch aktive
 * Leistungsnachweise abgedeckten Termine. Identisch zu den Feldern, die
 * `/billing/eligible-customers` pro Kunde ausliefert.
 */
export interface DocumentationCoverage {
  completedAppointments: number;
  coveredAppointments: number;
}

/**
 * Task #1625 — PURE SSoT der „unvollständig dokumentiert"-Regel. Ein Kunde
 * gilt als partiell dokumentiert, wenn im Zeitraum dokumentierte Termine
 * existieren, aber weniger davon durch aktive Leistungsnachweise abgedeckt
 * sind als dokumentiert wurden. Genau dieses Signal zeigt das Frontend als
 * „Nur X/Y dokumentierte Termine im Leistungsnachweis" — es gibt KEINE zweite
 * Definition, damit Anzeige (Hinweis + Skip-Zähler) und der server-seitige
 * Skip in der Massenerstellung garantiert übereinstimmen.
 */
export function isPartiallyDocumented(coverage: DocumentationCoverage): boolean {
  return (
    coverage.completedAppointments > 0 &&
    coverage.coveredAppointments < coverage.completedAppointments
  );
}

/**
 * Task #1771 — PURE SSoT der Reifegruppierung „hat noch offene Termine?". Ein
 * Kunde gilt als „noch offen", wenn im gewählten Monat mindestens ein offener
 * (geplanter) Termin verbleibt. Die Zahl der offenen Termine liefert der Server
 * aus DER EINEN `FINAL_APPOINTMENT_STATUSES`-SSoT
 * (`getOpenAppointmentCountByCustomer`); hier wird nur die Schwelle (> 0)
 * angewandt. Dieselbe Regel nutzen die Karte „Noch zu erstellen" (Gruppierung
 * „Bereit zum Abrechnen" vs. „Noch offene Termine") UND der Reife-Scope im
 * Split-Knopf „Alle erstellen", damit beide nie auseinanderlaufen.
 */
export function hasOpenAppointments(c: { openAppointments?: number | null }): boolean {
  return (c.openAppointments ?? 0) > 0;
}

/**
 * Task #1813 — PURE SSoT der „Nachberechnung"-Regel (spät unterschriebene
 * Nachzügler). Ein Kunde ist eine Nachberechnung, wenn im Zeitraum bereits
 * eine Rechnung existiert (also ein Teil der signierten Termine schon
 * abgerechnet ist) UND weitere signierte Termine noch offen sind. Genau dieser
 * Fall entsteht seit dem Late-Signing-Fix (spät unterschriebene Termine tauchen
 * korrekt wieder zur Abrechnung auf) — er ist KEIN Fehler und KEINE
 * Doppelabrechnung. Sowohl die Liste („Noch zu erstellen") als auch der
 * Vorschau-Dialog konsumieren DIESE eine Regel, damit die Kennzeichnung nie
 * auseinanderläuft.
 */
export interface LateSignedFollowUpFacts {
  /** Termine unter signierten LNs (bereits abgerechnete + noch offene). */
  signedAppointmentCount: number;
  /** Davon NOCH NICHT abgerechnet (= wird jetzt abgerechnet). */
  unbilledAppointmentCount: number;
}

export function isLateSignedFollowUp(f: LateSignedFollowUpFacts): boolean {
  return (
    f.unbilledAppointmentCount > 0 &&
    f.signedAppointmentCount > f.unbilledAppointmentCount
  );
}

/**
 * Anzahl der nachträglich unterschriebenen Termine, die jetzt abgerechnet
 * werden (= die noch nicht abgerechneten signierten Termine). 0, wenn es sich
 * nicht um eine Nachberechnung handelt.
 */
export function lateSignedFollowUpCount(f: LateSignedFollowUpFacts): number {
  return isLateSignedFollowUp(f) ? f.unbilledAppointmentCount : 0;
}

export type BillingEligibilityStatus = "eligible" | "blocked";

/** Eingangsfakten der Klassifikation (vom Server aus denselben Readern gefüllt). */
export interface BillingEligibilityFacts {
  billingType: string | null | undefined;
  /** Status ALLER aktiven Leistungsnachweise des Kunden im Zeitraum. */
  serviceRecordStatuses: readonly string[];
  /** Anzahl Termine unter den signierten LNs (vor „bereits abgerechnet"-Filter). */
  signedAppointmentCount: number;
  /** Anzahl davon, die NOCH NICHT abgerechnet sind. */
  unbilledAppointmentCount: number;
}

export interface BillingEligibilityResult {
  status: BillingEligibilityStatus;
  reason: BillingBlockReason | null;
  message: string | null;
}

/**
 * Klassifiziert die Abrechnungsberechtigung eines Kunden in DERSELBEN Reihenfolge
 * wie `buildInvoiceDraft`:
 *   1. kein signierter LN              → Signatur-Block (kassen-/zahlerabhängig)
 *   2. signiert, aber 0 Termine        → `no_appointments`
 *   3. alle Termine bereits abgerechnet → `already_billed`
 *   4. sonst                           → `eligible`
 */
export function classifyBillingEligibility(
  facts: BillingEligibilityFacts,
): BillingEligibilityResult {
  const signedRecordCount = facts.serviceRecordStatuses.filter((s) =>
    isServiceRecordSignedForBilling(facts.billingType, s),
  ).length;

  if (signedRecordCount === 0) {
    const reason: BillingBlockReason = isPflegekasseBillingType(facts.billingType)
      ? "customer_signature_required"
      : "not_signed";
    return { status: "blocked", reason, message: BILLING_BLOCK_MESSAGES[reason] };
  }
  if (facts.signedAppointmentCount === 0) {
    return {
      status: "blocked",
      reason: "no_appointments",
      message: BILLING_BLOCK_MESSAGES.no_appointments,
    };
  }
  if (facts.unbilledAppointmentCount === 0) {
    return {
      status: "blocked",
      reason: "already_billed",
      message: BILLING_BLOCK_MESSAGES.already_billed,
    };
  }
  return { status: "eligible", reason: null, message: null };
}

/**
 * Task #1786 — Reifegruppe eines Kunden in der Karte „Noch zu erstellen".
 * Genau EINE Gruppe pro Kunde:
 *  • `has_open_appointments` — im Monat sind noch offene (geplante) Termine.
 *  • `signature_blocked`     — keine offenen Termine mehr, aber Pflegekasse ohne
 *                              Kundenunterschrift (nur `employee_signed`).
 *  • `partially_documented`  — abrechenbar, aber weniger Termine durch aktive
 *                              Leistungsnachweise abgedeckt als dokumentiert.
 *  • `ready`                 — tatsächlich abrechenbar, vollständig dokumentiert,
 *                              keine offenen Termine mehr.
 */
export type BillingMaturityGroup =
  | "ready"
  | "partially_documented"
  | "signature_blocked"
  | "has_open_appointments";

/** Eingangsfakten der Reifegruppierung — schon vom Server gelieferte Felder. */
export interface BillingMaturityFacts {
  openAppointments?: number | null;
  completedAppointments: number;
  coveredAppointments: number;
  eligibility: { status: BillingEligibilityStatus; reason: BillingBlockReason | null };
}

/**
 * PURE SSoT der Reifegruppierung. Verwendet dieselben Helfer wie Anzeige und
 * Server-Skip (`hasOpenAppointments`, `isPartiallyDocumented`,
 * `eligibility.reason/status`) — KEINE zweite parallele Regel, damit Anzeige und
 * Erstellungs-Pfad nie auseinanderlaufen. Reihenfolge = Schwere/Blockierung:
 * offene Termine → fehlende Kundenunterschrift → unvollständig dokumentiert →
 * bereit.
 */
export function classifyBillingMaturity(c: BillingMaturityFacts): BillingMaturityGroup {
  if (hasOpenAppointments(c)) return "has_open_appointments";
  // Blockierte Kunden dürfen NIE unter „ready" landen. Fehlende Kundenunterschrift
  // ist der Regelfall und bekommt eine eigene Gruppe; alle übrigen Block-Gründe
  // (not_signed/no_appointments/already_billed) werden pragmatisch ebenfalls in
  // „signature_blocked" (= „nicht bereit, Grund per Inline-Label") einsortiert,
  // damit sie sichtbar bleiben und nicht als abrechenbar erscheinen.
  if (c.eligibility.status !== "eligible") return "signature_blocked";
  if (isPartiallyDocumented(c)) return "partially_documented";
  return "ready";
}
