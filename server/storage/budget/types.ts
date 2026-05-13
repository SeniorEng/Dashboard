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
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
  /**
   * Tatsächlich im laufenden Kalendermonat noch buchbar.
   *
   * Ohne `monthlyLimitCents`: identisch zu `availableCents` (kein Cap aktiv).
   * Mit `monthlyLimitCents` gesetzt: `max(0, monthlyLimit + carryover - currentMonthUsed)`,
   * gedeckelt durch `availableCents` (kann nie mehr buchbar sein als der gesamte Topf hergibt).
   *
   * Single source of truth für "wieviel kann jetzt im aktuellen Monat noch
   * verbraucht werden?" — verwendet von Cost-Estimate und vom
   * `createCascadeConsumption`-Vorab-Check, damit Anzeige und Buchung
   * niemals auseinanderlaufen (siehe Task #423).
   */
  currentMonthAvailableCents: number;
  isCurrentlyActive: boolean;
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
