import type { db } from "../../lib/db";

export type DbClient = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'>;

export interface BudgetSummary {
  customerId: number;
  totalAllocatedCents: number;
  totalUsedCents: number;
  availableCents: number;
  plannedCents: number;
  availableAfterPlannedCents: number;
  carryoverCents: number;
  /**
   * Der vom Startwert-Reset ERSETZTE Uebertrag (E4: verdraengen, nicht
   * loeschen). `0`, solange die Inventur-Lesart nicht greift.
   *
   * Steht NEBEN `carryoverCents`, nicht darin: der ersetzte Betrag faellt aus
   * dem Anspruch, soll aber sichtbar bleiben. Ohne dieses Feld faellt die
   * Uebertrags-Karte beim Default-Umschwung kommentarlos auf 0 — und genau
   * die Frage „wo ist mein Uebertrag hin?" sollte E4 beantworten.
   */
  carryoverVerdraengtCents: number;
  /** `MM/JJJJ` des Startwerts, der ihn ersetzt hat. `null` = keiner. */
  carryoverErsetztDurchStartwertMonat: string | null;
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
  /** Geplante (scheduled/documenting) Kosten im laufenden Monat. */
  currentMonthPlannedCents: number;
  /**
   * Im laufenden Monat noch buchbar, unter Berücksichtigung des Monats-Caps.
   * Ohne Cap = `availableCents`; mit Cap = `min(availableCents, monthlyLimit + carryover - currentMonthUsed)`.
   */
  currentMonthAvailableCents: number;
  isCurrentlyActive: boolean;
  /**
   * Task #704 — Erster Monat (YYYY-MM), in dem die zeitliche §45b-Projektion
   * (kumulative Monatsaufstockungen + ablaufende Carryover-Beträge) gegen die
   * bis dahin geplanten Termine ins Minus läuft. `null` = keine Lücke
   * prognostiziert. Wird vom Warnbanner als Erklärung herangezogen.
   */
  plannedShortfallMonth: string | null;
}

export interface Budget45aSummary {
  customerId: number;
  monthlyBudgetCents: number;
  currentMonthAllocatedCents: number;
  currentMonthUsedCents: number;
  currentMonthAvailableCents: number;
  isCurrentlyActive: boolean;
}

export interface Budget39_42aSummary {
  customerId: number;
  yearlyBudgetCents: number;
  currentYearAllocatedCents: number;
  currentYearUsedCents: number;
  currentYearAvailableCents: number;
}

export interface AllBudgetSummaries {
  entlastungsbetrag45b: BudgetSummary;
  umwandlung45a: Budget45aSummary;
  ersatzpflege39_42a: Budget39_42aSummary;
}

export interface CascadeResult {
  transactions: import("@shared/schema").BudgetTransaction[];
  totalConsumedCents: number;
  outstandingCents: number;
  breakdown: Array<{
    budgetType: string;
    consumedCents: number;
  }>;
}
