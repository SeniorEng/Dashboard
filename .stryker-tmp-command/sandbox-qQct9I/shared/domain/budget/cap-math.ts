/**
 * Task #720 — Pure Cap-Mathematik für §45b/§45a/§39+§42a.
 *
 * Vor #720 lebte diese Mathematik in `server/storage/budget/cap-calculator.ts`
 * vermischt mit DB-Queries (`netConsumedInRange`, `getTotalCarryoverCents`,
 * Pflegegrad-Lookup). Damit konnte sie weder vom Frontend noch von
 * Equality-Tests direkt aufgerufen werden, und „Anzeige vs. Buchung"-Drift
 * (Task #423) wäre wieder möglich, wenn jemand die Formel an einer zweiten
 * Stelle nachbaut.
 *
 * Diese Datei enthält die REINE Berechnung — keine DB-Zugriffe, keine
 * Default-/State-Werte. Alle Inputs werden explizit übergeben. Der
 * Server-Wrapper (`cap-calculator.ts`) bleibt der einzige Ort, der die
 * Inputs aus der Datenbank materialisiert. Querschnitts-Auflage A
 * (pure / no state) ist damit erfüllt.
 *
 * Architecture-Test `tests/architecture/calculations-in-shared.test.ts`
 * verbietet neue `compute*`/`calculate*`-Cap-Funktionen außerhalb dieses
 * Verzeichnisses.
 */
// @ts-nocheck

import { clampToStatutoryMax } from "../budgets";

export type CapBudgetType =
  | "entlastungsbetrag_45b"
  | "umwandlung_45a"
  | "ersatzpflege_39_42a";

/**
 * Inputs werden vom DB-Wrapper befüllt. `netUsedInWindowCents` ist bereits
 * fenster-skopiert (`consumption - reversal`, OHNE `write_off` — siehe
 * `docs/budget-ssot-inventory.md` Abschnitt „write_off-Audit").
 */
export interface CapMathInput {
  budgetType: CapBudgetType;
  /** Aktueller Pflegegrad des Kunden — nur für §45a relevant, sonst egal. */
  pflegegrad: number | null;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  /** Carryover (§45b): zum Abfragedatum verfügbare Übertragssumme in Cents. */
  carryoverCents: number;
  /** Im Fenster (Monat/Jahr) bereits verbrauchter Cents-Betrag. */
  netUsedInWindowCents: number;
}

export interface CapMathResult {
  /** Vom Statut auf den gesetzlichen Maximalwert geklemmte Limits. */
  clampedMonthlyLimitCents: number | null;
  clampedYearlyLimitCents: number | null;
  /**
   * Wieviel Cent in DIESEM Fenster noch gebucht werden dürfen.
   * `Number.POSITIVE_INFINITY` = kein Cap (z.B. §45b, das einen
   * Jahrestopf statt eines Fenster-Caps führt).
   */
  capRemainingCents: number;
}

/**
 * Pure Cap-Berechnung. Aufrufer:
 *  - `server/storage/budget/cap-calculator.ts` (DB-Wrapper, ein Aufruf pro
 *    Termin-Buchung / Cost-Estimate).
 *  - Equality-Tests, die §45a/§39-Anzeige gegen die Buchung verifizieren.
 *  - Künftig: Frontend (Phase 2 Stats-V2-Forecast), falls die Anzeige eine
 *    eigene Vorab-Klemme braucht.
 */
export function computeCapRemaining(input: CapMathInput): CapMathResult {
  const clamped = clampToStatutoryMax({
    budgetType: input.budgetType,
    monthlyLimitCents: input.monthlyLimitCents,
    yearlyLimitCents: input.yearlyLimitCents,
    pflegegrad: input.pflegegrad,
  });

  let capRemainingCents: number;

  if (input.budgetType === "ersatzpflege_39_42a") {
    // Jahres-Cap (§39/§42a)
    capRemainingCents =
      clamped.yearlyLimitCents === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, clamped.yearlyLimitCents - input.netUsedInWindowCents);
  } else if (input.budgetType === "entlastungsbetrag_45b") {
    // §45b ist ein Jahrestopf mit monatlicher Aufstockung — KEIN harter
    // Monats-Cap. Die per-Kunde konfigurierbare „Unser Anteil"-Reduktion
    // (Task #603) wirkt NICHT als Buchungs-Cap, sondern reduziert die
    // monatliche Aufstockung in `calculateAllocated45b`. Verfügbarkeit
    // wird stattdessen über die aufgelaufene Allokation berechnet.
    capRemainingCents = Number.POSITIVE_INFINITY;
  } else {
    // §45a Monats-Cap, ggf. plus Carryover (für §45a aktuell 0).
    if (clamped.monthlyLimitCents === null) {
      capRemainingCents = Number.POSITIVE_INFINITY;
    } else {
      const effectiveLimit = clamped.monthlyLimitCents + input.carryoverCents;
      capRemainingCents = Math.max(0, effectiveLimit - input.netUsedInWindowCents);
    }
  }

  return {
    clampedMonthlyLimitCents: clamped.monthlyLimitCents,
    clampedYearlyLimitCents: clamped.yearlyLimitCents,
    capRemainingCents,
  };
}
