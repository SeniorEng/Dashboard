export type { BudgetSummary, Budget45aSummary, Budget39_42aSummary, AllBudgetSummaries, CascadeResult } from "./budget/types";
export type { DbClient } from "./budget/types";

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

export interface BudgetLedgerStorage {
  createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number): Promise<BudgetAllocation>;
  getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]>;

  createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction>;
  getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]>;
  getTransactionsByAppointmentId(appointmentId: number): Promise<BudgetTransaction[]>;
  reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined>;

  syncCarryoverAndExpiry(customerId: number, _tx?: DbClient): Promise<void>;
  getBudgetSummary(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetSummary>;
  getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries>;
  getPlannedCostCents(customerId: number): Promise<number>;

  getBudgetPreferences(customerId: number, _tx?: DbClient): Promise<CustomerBudgetPreferences | undefined>;
  upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number): Promise<CustomerBudgetPreferences>;
  getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]>;
  upsertBudgetTypeSettings(customerId: number, settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; validFrom?: string | null; validTo?: string | null }>): Promise<CustomerBudgetTypeSetting[]>;

  upsertInitialBalanceAllocation(params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string }, userId?: number): Promise<void>;
  getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]>;

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
}

export const budgetLedgerStorage: BudgetLedgerStorage = {
  createBudgetAllocation: allocation.createBudgetAllocation,
  getBudgetAllocations: allocation.getBudgetAllocations,

  createBudgetTransaction: transaction.createBudgetTransaction,
  getBudgetTransactions: transaction.getBudgetTransactions,
  getTransactionsByAppointmentId: transaction.getTransactionsByAppointmentId,
  reverseBudgetTransaction: transaction.reverseBudgetTransaction,

  syncCarryoverAndExpiry: allocation.syncCarryoverAndExpiry,
  getBudgetSummary: summary.getBudgetSummary,
  getAllBudgetSummaries: summary.getAllBudgetSummaries,
  getPlannedCostCents: pricing.getPlannedCostCents,

  getBudgetPreferences: preferences.getBudgetPreferences,
  upsertBudgetPreferences: preferences.upsertBudgetPreferences,
  getBudgetTypeSettings: preferences.getBudgetTypeSettings,
  upsertBudgetTypeSettings: preferences.upsertBudgetTypeSettings,

  upsertInitialBalanceAllocation: allocation.upsertInitialBalanceAllocation,
  getInitialBalanceAllocations: allocation.getInitialBalanceAllocations,

  calculateAppointmentCost: pricing.calculateAppointmentCost,

  createConsumptionTransaction: consumption.createConsumptionTransaction,

  rebookSingleTransaction: rebook.rebookSingleTransaction,
  getRebookPreview: rebook.getRebookPreview,
  rebookDisabledBudgetTransactions: rebook.rebookDisabledBudgetTransactions,
};
