import type {
  BudgetAllocation,
  InsertBudgetAllocation,
  BudgetTransaction,
  InsertBudgetTransaction,
  CustomerBudgetPreferences,
  InsertBudgetPreferences,
  CustomerBudgetTypeSetting,
} from "@shared/schema";

import type { DbClient, BudgetSummary, Budget45aSummary, Budget39_42aSummary, AllBudgetSummaries, CascadeResult } from "./budget/types";

import * as preferences from "./budget/preferences-storage";
import * as allocation from "./budget/allocation-storage";
import * as transaction from "./budget/transaction-storage";
import * as summary from "./budget/summary-queries";
import * as consumption from "./budget/consumption-engine";
import * as rebook from "./budget/rebook-storage";
import * as pricing from "./budget/appointment-cost-calculator";
import * as history from "./budget/history-aggregation";
import * as reservation from "./budget/reservation-storage";
import * as fifoBreakdown from "./budget/fifo-breakdown";
import type { MonthlyHistoryBucket } from "@shared/domain/budget/history-aggregation";

interface BudgetLedgerStorage {
  createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number, tx?: DbClient): Promise<BudgetAllocation>;
  getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]>;

  createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction>;
  getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]>;
  getTransactionsByAppointmentId(appointmentId: number, txClient?: DbClient): Promise<BudgetTransaction[]>;
  getTransactionByAppointmentId(appointmentId: number, _tx?: DbClient): Promise<BudgetTransaction | undefined>;
  reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined>;

  syncCarryoverAndExpiry(customerId: number, _tx?: DbClient): Promise<void>;
  getBudgetSummary(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[], asOfDate?: string): Promise<BudgetSummary>;
  getAllBudgetSummaries(customerId: number, asOfDate?: string): Promise<AllBudgetSummaries>;
  // Task #874 — Serving-Pfad (Phase 4): Verfügbarkeit aus dem EINEN unified
  // Reader. Legacy `getBudgetSummary*` bleiben der Shadow-/Compat-Pfad.
  // Task #911 — optionaler Stichtag (Default heute) für die date-korrekte Overview.
  getBudgetSummaryServed(customerId: number, asOfDate?: string): Promise<BudgetSummary>;
  getAllBudgetSummariesServed(customerId: number, asOfDate?: string): Promise<AllBudgetSummaries>;
  // Task #1129 — read-only §45b FIFO-Aufschlüsselung (Übertrag → laufendes Jahr).
  readBudget45bFifoBreakdown: typeof fifoBreakdown.readBudget45bFifoBreakdown;
  getPlannedCostCents(customerId: number): Promise<number>;
  // Task #727 — Phase 1.3: monatliche History-Aggregation (Allocations- und
  // Fenster-Cap-Sicht) über die pure `aggregateHistoryByMonth`.
  getMonthlyHistory(customerId: number, opts?: history.GetMonthlyHistoryOptions): Promise<MonthlyHistoryBucket[]>;

  getBudgetPreferences(customerId: number, _tx?: DbClient): Promise<CustomerBudgetPreferences | undefined>;
  upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number, tx?: DbClient): Promise<CustomerBudgetPreferences>;
  // Task #716 — Konsolidierter Lese-Einstiegspunkt (SSoT). Overload-Set
  // spiegelt die drei Modi 1:1 wider, damit Caller den exakten Element-Typ
  // bekommen (ohne Conditional-Type-Narrowing-Probleme).
  readBudgetTypeSettings(customerId: number, mode: { kind: "forDate"; asOfDate: string }, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]>;
  readBudgetTypeSettings(customerId: number, mode: { kind: "forEdit" }, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]>;
  readBudgetTypeSettings(customerId: number, mode: { kind: "withTransition" }, _tx?: DbClient): Promise<preferences.BudgetTypeSettingWithTransition[]>;
  getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]>;
  getLatestBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]>;
  getLatestBudgetTypeSettingsWithTransition(customerId: number, _tx?: DbClient): Promise<preferences.BudgetTypeSettingWithTransition[]>;
  upsertBudgetTypeSettings(customerId: number, settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; validFrom?: string | null; validTo?: string | null }>, tx?: DbClient, userId?: number): Promise<CustomerBudgetTypeSetting[]>;

  upsertInitialBalanceAllocation(params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string }, userId?: number): Promise<void>;
  upsertCarryoverAllocation(params: { customerId: number; budgetType: string; sourceYear: number; amountCents: number; notes?: string }, userId?: number): Promise<void>;
  getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]>;
  clearLegacyInitialBalanceFromSettings(customerId: number, budgetType: string, tx: DbClient, userId?: number): Promise<boolean>;
  // Task #876 — In-place-Aktivierung für den Initial-Balance-Flow (vorher
  // direkte db.*-Zugriffe in routes/budget.ts).
  ensureBudgetTypeEnabledInPlace(customerId: number, budgetType: string, validFrom: string): Promise<void>;

  calculateAppointmentCost(params: {
    customerId: number;
    hauswirtschaftMinutes: number;
    alltagsbegleitungMinutes: number;
    travelKilometers: number;
    customerKilometers: number;
    date: string;
  }): Promise<{
    hauswirtschaftCents: number;
    alltagsbegleitungCents: number;
    travelCents: number;
    customerKilometersCents: number;
    totalCents: number;
  }>;

  createConsumptionTransaction(params: {
    customerId: number;
    appointmentId: number;
    transactionDate: string;
    hauswirtschaftMinutes: number;
    alltagsbegleitungMinutes: number;
    travelKilometers: number;
    customerKilometers: number;
    userId?: number;
  }, outerTx?: DbClient): Promise<BudgetTransaction>;

  rebookSingleTransaction(customerId: number, transactionId: number, targetBudgetType: string, userId: number): Promise<{ reversalTransaction: BudgetTransaction; newTransaction: BudgetTransaction | null; amountCents: number }>;
  getRebookPreview(customerId: number): Promise<{ disabledTypes: string[]; affectedAppointments: number; totalAmountCents: number; transactions: Array<{ id: number; budgetType: string; amountCents: number; appointmentId: number | null; transactionDate: string }> }>;
  rebookDisabledBudgetTransactions(customerId: number, userId: number): Promise<{ reversedCount: number; rebookedCount: number; totalOldAmountCents: number; totalNewAmountCents: number; errors: Array<{ appointmentId: number; error: string }> }>;

  // Task #875 — Hard-hold reservations (gated via BUDGET_HARD_HOLDS).
  hardHoldsEnabled: typeof reservation.hardHoldsEnabled;
  planHold: typeof reservation.planHold;
  captureHolds: typeof reservation.captureHolds;
  releaseHolds: typeof reservation.releaseHolds;
  rescheduleHold: typeof reservation.rescheduleHold;
  sweepOrphanHolds: typeof reservation.sweepOrphanHolds;
}

export const budgetLedgerStorage: BudgetLedgerStorage = {
  createBudgetAllocation: allocation.createBudgetAllocation,
  getBudgetAllocations: allocation.getBudgetAllocations,

  createBudgetTransaction: transaction.createBudgetTransaction,
  getBudgetTransactions: transaction.getBudgetTransactions,
  getTransactionsByAppointmentId: transaction.getTransactionsByAppointmentId,
  getTransactionByAppointmentId: transaction.getTransactionByAppointmentId,
  reverseBudgetTransaction: transaction.reverseBudgetTransaction,

  syncCarryoverAndExpiry: allocation.syncCarryoverAndExpiry,
  getBudgetSummary: summary.getBudgetSummary,
  getAllBudgetSummaries: summary.getAllBudgetSummaries,
  getBudgetSummaryServed: summary.getBudgetSummaryServed,
  getAllBudgetSummariesServed: summary.getAllBudgetSummariesServed,
  readBudget45bFifoBreakdown: fifoBreakdown.readBudget45bFifoBreakdown,
  getPlannedCostCents: pricing.getPlannedCostCents,
  getMonthlyHistory: history.getMonthlyHistory,

  getBudgetPreferences: preferences.getBudgetPreferences,
  upsertBudgetPreferences: preferences.upsertBudgetPreferences,
  // Task #716 — Konsolidierter Lese-Einstiegspunkt (SSoT). Neue Caller
  // bitte ausschließlich diese Funktion verwenden — die drei alten
  // Read-Wrapper bleiben `@deprecated` für Bestandscode.
  readBudgetTypeSettings: preferences.readBudgetTypeSettings,
  /** @deprecated Task #716 — bitte `readBudgetTypeSettings({ kind: "forDate", asOfDate })`. */
  getBudgetTypeSettings: preferences.getBudgetTypeSettings,
  /** @deprecated Task #716 — bitte `readBudgetTypeSettings({ kind: "forEdit" })`. */
  getLatestBudgetTypeSettings: preferences.getLatestBudgetTypeSettings,
  /** @deprecated Task #716 — bitte `readBudgetTypeSettings({ kind: "withTransition" })`. */
  getLatestBudgetTypeSettingsWithTransition: preferences.getLatestBudgetTypeSettingsWithTransition,
  upsertBudgetTypeSettings: preferences.upsertBudgetTypeSettings,

  upsertInitialBalanceAllocation: allocation.upsertInitialBalanceAllocation,
  upsertCarryoverAllocation: allocation.upsertCarryoverAllocation,
  getInitialBalanceAllocations: allocation.getInitialBalanceAllocations,
  clearLegacyInitialBalanceFromSettings: preferences.clearLegacyInitialBalanceFromSettings,
  ensureBudgetTypeEnabledInPlace: preferences.ensureBudgetTypeEnabledInPlace,

  calculateAppointmentCost: pricing.calculateAppointmentCost,

  createConsumptionTransaction: consumption.createConsumptionTransaction,

  rebookSingleTransaction: rebook.rebookSingleTransaction,
  getRebookPreview: rebook.getRebookPreview,
  rebookDisabledBudgetTransactions: rebook.rebookDisabledBudgetTransactions,

  hardHoldsEnabled: reservation.hardHoldsEnabled,
  planHold: reservation.planHold,
  captureHolds: reservation.captureHolds,
  releaseHolds: reservation.releaseHolds,
  rescheduleHold: reservation.rescheduleHold,
  sweepOrphanHolds: reservation.sweepOrphanHolds,
};
