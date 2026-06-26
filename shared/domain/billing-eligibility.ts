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
