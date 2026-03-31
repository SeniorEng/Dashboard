import { 
  budgetAllocations, 
  budgetTransactions, 
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  customerBudgets,
  customers,
  customerServicePrices,
  services,
  appointments,
  appointmentServices,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type BudgetTransaction,
  type InsertBudgetTransaction,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, lastDayOfMonth, firstDayOfMonth, lastDayOfYear, currentYearAndMonth } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { db } from "../lib/db";
import { serviceCatalogStorage } from "./service-catalog";

type DbClient = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'transaction'>;

const DEFAULT_MONTHLY_BUDGET_CENTS = BUDGET_45B_MAX_MONTHLY_CENTS;

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
}

export interface Budget45aSummary {
  customerId: number;
  monthlyBudgetCents: number;
  currentMonthAllocatedCents: number;
  currentMonthUsedCents: number;
  currentMonthAvailableCents: number;
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

export interface BudgetLedgerStorage {
  createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number): Promise<BudgetAllocation>;
  getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]>;
  
  createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction>;
  getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]>;
  getTransactionByAppointmentId(appointmentId: number): Promise<BudgetTransaction | undefined>;
  reverseBudgetTransaction(transactionId: number, userId?: number): Promise<BudgetTransaction | undefined>;
  
  ensureMonthlyAllocations(customerId: number): Promise<BudgetAllocation[]>;
  syncBudgetAllocations(customerId: number): Promise<void>;
  getBudgetSummary(customerId: number): Promise<BudgetSummary>;
  getMonthlyBudgetAmountCents(customerId: number): Promise<number>;
  
  getBudgetPreferences(customerId: number): Promise<CustomerBudgetPreferences | undefined>;
  upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number): Promise<CustomerBudgetPreferences>;
  
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
  
  getCustomerBudgetAmounts(customerId: number): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }>;
  
  ensureAllocations45a(customerId: number): Promise<BudgetAllocation[]>;
  ensureAllocations39_42a(customerId: number): Promise<BudgetAllocation[]>;
  getBudgetSummary45a(customerId: number): Promise<Budget45aSummary>;
  getBudgetSummary39_42a(customerId: number): Promise<Budget39_42aSummary>;
  getPlannedCostCents(customerId: number): Promise<number>;
  getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries>;
  
  getBudgetTypeSettings(customerId: number): Promise<CustomerBudgetTypeSetting[]>;
  upsertBudgetTypeSettings(customerId: number, settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; validFrom?: string | null; validTo?: string | null }>): Promise<CustomerBudgetTypeSetting[]>;
  upsertInitialBalanceAllocation(params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string }, userId?: number): Promise<void>;
  getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]>;
  
  rebookSingleTransaction(customerId: number, transactionId: number, targetBudgetType: string, userId: number): Promise<{
    reversalTransaction: BudgetTransaction;
    newTransaction: BudgetTransaction | null;
    amountCents: number;
  }>;
  
  processExpiredCarryover(customerId: number): Promise<BudgetTransaction[]>;
  
  consumeFifo(customerId: number, budgetType: string, amountCents: number, transactionDate: string, params?: {
    appointmentId?: number;
    notes?: string;
    userId?: number;
    hauswirtschaftMinutes?: number;
    hauswirtschaftCents?: number;
    alltagsbegleitungMinutes?: number;
    alltagsbegleitungCents?: number;
    travelKilometers?: number;
    travelCents?: number;
    customerKilometers?: number;
    customerKilometersCents?: number;
  }): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }>;

  createCascadeConsumption(params: {
    customerId: number;
    appointmentId: number;
    transactionDate: string;
    totalAmountCents: number;
    hauswirtschaftMinutes: number;
    hauswirtschaftCents: number;
    alltagsbegleitungMinutes: number;
    alltagsbegleitungCents: number;
    travelKilometers: number;
    travelCents: number;
    customerKilometers: number;
    customerKilometersCents: number;
    userId?: number;
  }): Promise<CascadeResult>;
}

export interface CascadeResult {
  transactions: BudgetTransaction[];
  totalConsumedCents: number;
  outstandingCents: number;
  breakdown: Array<{
    budgetType: string;
    consumedCents: number;
  }>;
}

export class DatabaseBudgetLedgerStorage implements BudgetLedgerStorage {
  
  async createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number): Promise<BudgetAllocation> {
    const result = await db.insert(budgetAllocations).values({
      ...allocation,
      createdByUserId: userId,
    }).returning();
    return result[0];
  }

  async getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]> {
    if (year) {
      return await db.select()
        .from(budgetAllocations)
        .where(and(
          eq(budgetAllocations.customerId, customerId),
          eq(budgetAllocations.year, year),
          isNull(budgetAllocations.deletedAt)
        ))
        .orderBy(asc(budgetAllocations.month), asc(budgetAllocations.validFrom));
    }
    return await db.select()
      .from(budgetAllocations)
      .where(and(eq(budgetAllocations.customerId, customerId), isNull(budgetAllocations.deletedAt)))
      .orderBy(desc(budgetAllocations.year), asc(budgetAllocations.month));
  }

  async createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction> {
    const result = await db.insert(budgetTransactions).values({
      ...transaction,
      createdByUserId: userId,
    }).returning();
    return result[0];
  }

  async getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]> {
    const conditions = [eq(budgetTransactions.customerId, customerId)];
    
    if (options?.year) {
      const yearStart = `${options.year}-01-01`;
      const yearEnd = `${options.year}-12-31`;
      conditions.push(gte(budgetTransactions.transactionDate, yearStart));
      conditions.push(lte(budgetTransactions.transactionDate, yearEnd));
    }

    if (options?.budgetType) {
      conditions.push(eq(budgetTransactions.budgetType, options.budgetType));
    }

    let query = db.select()
      .from(budgetTransactions)
      .where(and(...conditions))
      .orderBy(desc(budgetTransactions.transactionDate), desc(budgetTransactions.createdAt));

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    return await query;
  }

  async getTransactionByAppointmentId(appointmentId: number, _tx?: DbClient): Promise<BudgetTransaction | undefined> {
    const d = _tx ?? db;
    const result = await d.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption")
      ))
      .limit(1);
    return result[0];
  }

  async getTransactionsByAppointmentId(appointmentId: number): Promise<BudgetTransaction[]> {
    return db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption")
      ));
  }

  async reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined> {
    const d = txClient ?? db;
    const original = await d.select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.id, transactionId))
      .limit(1);
    
    if (!original[0]) return undefined;
    
    const reversal = await d.insert(budgetTransactions).values({
      customerId: original[0].customerId,
      budgetType: original[0].budgetType,
      transactionDate: todayISO(),
      transactionType: "reversal",
      amountCents: -original[0].amountCents,
      appointmentId: original[0].appointmentId,
      allocationId: original[0].allocationId,
      notes: `Storno von Transaktion #${transactionId}`,
      createdByUserId: userId,
    }).returning();
    
    return reversal[0];
  }

  async getMonthlyBudgetAmountCents(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<number> {
    const d = _tx ?? db;

    const settings = _typeSettings ?? await d.select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    const s45b = settings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
    if (s45b?.monthlyLimitCents != null) {
      return s45b.monthlyLimitCents;
    }

    const customerBudget = await d.select()
      .from(customerBudgets)
      .where(and(
        eq(customerBudgets.customerId, customerId),
        isNull(customerBudgets.validTo)
      ))
      .limit(1);

    if (customerBudget[0]?.entlastungsbetrag45b) {
      return customerBudget[0].entlastungsbetrag45b;
    }

    return DEFAULT_MONTHLY_BUDGET_CENTS;
  }

  private async ensureAllocationsGeneric(config: {
    customerId: number;
    budgetType: string;
    frequency: 'monthly' | 'yearly';
    source: string;
    amountCents: number;
    getExpiresAt: (year: number, month: number) => string | null;
    getNotes: (year: number, month: number) => string;
    startYear: number;
    startMonth: number;
    startDateStr?: string;
    skipKeys?: Set<string>;
  }, d: Pick<typeof db, 'select' | 'insert'>): Promise<BudgetAllocation[]> {
    const { year: curYear, month: curMonth } = currentYearAndMonth();

    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, config.customerId),
        eq(budgetAllocations.budgetType, config.budgetType),
        eq(budgetAllocations.source, config.source),
        isNull(budgetAllocations.deletedAt)
      ));

    const existingSet = new Set(
      config.frequency === 'monthly'
        ? existingAllocations.map(a => `${a.year}-${a.month}`)
        : existingAllocations.map(a => `${a.year}`)
    );

    const created: BudgetAllocation[] = [];

    if (config.frequency === 'monthly') {
      let year = config.startYear;
      let month = config.startMonth;
      while (year < curYear || (year === curYear && month <= curMonth)) {
        const key = `${year}-${month}`;
        if (!existingSet.has(key) && !config.skipKeys?.has(key)) {
          const result = await d.insert(budgetAllocations).values({
            customerId: config.customerId,
            budgetType: config.budgetType,
            year,
            month,
            amountCents: config.amountCents,
            source: config.source,
            validFrom: firstDayOfMonth(year, month),
            expiresAt: config.getExpiresAt(year, month),
            notes: config.getNotes(year, month),
          }).onConflictDoNothing().returning();
          if (result[0]) created.push(result[0]);
        }
        month++;
        if (month > 12) { month = 1; year++; }
      }
    } else {
      for (let year = config.startYear; year <= curYear; year++) {
        if (!existingSet.has(`${year}`)) {
          const validFrom = year === config.startYear
            ? (config.startDateStr ?? firstDayOfMonth(config.startYear, config.startMonth))
            : `${year}-01-01`;
          const result = await d.insert(budgetAllocations).values({
            customerId: config.customerId,
            budgetType: config.budgetType,
            year,
            month: null,
            amountCents: config.amountCents,
            source: config.source,
            validFrom,
            expiresAt: config.getExpiresAt(year, 0),
            notes: config.getNotes(year, 0),
          }).onConflictDoNothing().returning();
          if (result[0]) created.push(result[0]);
        }
      }
    }

    return created;
  }

  private async resolveStartDate(customerId: number, budgetType: string, d: Pick<typeof db, 'select'>, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<string | null> {
    const preferences = _preferences !== undefined ? _preferences : await this.getBudgetPreferences(customerId);
    if (preferences?.budgetStartDate) return preferences.budgetStartDate;

    const typeSettings = _typeSettings ?? await d.select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));
    const enabled = typeSettings.find(s => s.budgetType === budgetType && s.enabled);
    if (!enabled) return null;

    const { year } = currentYearAndMonth();
    return `${year}-01-01`;
  }

  async ensureMonthlyAllocations(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;

    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        isNull(budgetAllocations.deletedAt)
      ));

    const preferences = _preferences !== undefined ? _preferences : await this.getBudgetPreferences(customerId, _tx);
    let budgetStartDate = preferences?.budgetStartDate ?? null;

    if (!budgetStartDate) {
      const initialBalances = existingAllocations
        .filter(a => a.source === "initial_balance" && a.validFrom);
      if (initialBalances.length > 0) {
        budgetStartDate = initialBalances.reduce((min, a) =>
          a.validFrom < min.validFrom ? a : min
        ).validFrom;
      }
    }

    if (!budgetStartDate) {
      const monthlyEntries = existingAllocations
        .filter(a => (a.source === "monthly_auto" || a.source === "monthly" || a.source === "carryover") && a.validFrom);
      if (monthlyEntries.length > 0) {
        budgetStartDate = monthlyEntries.reduce((min, a) =>
          a.validFrom < min.validFrom ? a : min
        ).validFrom;
      }
    }

    if (!budgetStartDate) {
      const typeSettings = _typeSettings ?? await d.select()
        .from(customerBudgetTypeSettings)
        .where(eq(customerBudgetTypeSettings.customerId, customerId));
      const s45bEnabled = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
      if (!s45bEnabled) return [];
      const { year } = currentYearAndMonth();
      budgetStartDate = `${year}-01-01`;
    }

    const startDate = parseLocalDate(budgetStartDate);
    let allocStartYear = startDate.getFullYear();
    let allocStartMonth = startDate.getMonth() + 1;

    const initialBalanceMonths = existingAllocations
      .filter(a => a.source === "initial_balance" && a.month != null)
      .map(a => ({ year: a.year, month: a.month! }));

    if (initialBalanceMonths.length > 0) {
      let latestIbYear = 0, latestIbMonth = 0;
      for (const ib of initialBalanceMonths) {
        if (ib.year > latestIbYear || (ib.year === latestIbYear && ib.month > latestIbMonth)) {
          latestIbYear = ib.year;
          latestIbMonth = ib.month;
        }
      }
      let afterMonth = latestIbMonth + 1, afterYear = latestIbYear;
      if (afterMonth > 12) { afterMonth = 1; afterYear++; }
      if (afterYear > allocStartYear || (afterYear === allocStartYear && afterMonth > allocStartMonth)) {
        allocStartYear = afterYear;
        allocStartMonth = afterMonth;
      }
    }

    const existingMonthlySet = new Set(
      existingAllocations
        .filter(a => a.source === "monthly_auto" || a.source === "monthly")
        .map(a => `${a.year}-${a.month}`)
    );
    const initialBalanceSet = new Set(
      initialBalanceMonths.map(ib => `${ib.year}-${ib.month}`)
    );
    const skipKeys = new Set([...existingMonthlySet, ...initialBalanceSet]);

    const monthlyAmount = await this.getMonthlyBudgetAmountCents(customerId, _tx, _typeSettings);

    return this.ensureAllocationsGeneric({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      frequency: 'monthly',
      source: "monthly_auto",
      amountCents: monthlyAmount,
      getExpiresAt: () => null,
      getNotes: (y, m) => `Automatische Zuweisung ${String(m).padStart(2, '0')}/${y}`,
      startYear: allocStartYear,
      startMonth: allocStartMonth,
      skipKeys,
    }, d);
  }

  async syncBudgetAllocations(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<void> {
    const [preferences, typeSettings] = await Promise.all([
      _preferences !== undefined ? _preferences : this.getBudgetPreferences(customerId, _tx),
      _typeSettings ?? this.getBudgetTypeSettings(customerId, _tx),
    ]);
    const amounts = await this.getCustomerBudgetAmounts(customerId, _tx, typeSettings);

    await Promise.all([
      this.ensureMonthlyAllocations(customerId, _tx, preferences, typeSettings),
      this.ensureAllocations45a(customerId, _tx, preferences, amounts),
      this.ensureAllocations39_42a(customerId, _tx, preferences, amounts),
    ]);
    await this.ensureYearlyCarryover45b(customerId, _tx);
    await this.processExpiredCarryover(customerId, _tx);
  }

  async ensureYearlyCarryover45b(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const { year: curYear } = currentYearAndMonth();

    const allAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        isNull(budgetAllocations.deletedAt)
      ));

    if (allAllocations.length === 0) return [];

    const existingCarryoverYears = new Set(
      allAllocations
        .filter(a => a.source === "carryover")
        .map(a => a.year)
    );

    const yearSet = new Set(allAllocations.map(a => a.year));
    const years = Array.from(yearSet).sort((a, b) => a - b);

    const created: BudgetAllocation[] = [];

    for (const year of years) {
      if (year >= curYear) continue;
      const targetYear = year + 1;
      if (existingCarryoverYears.has(targetYear)) continue;

      const yearAllocations = allAllocations.filter(a =>
        a.year === year &&
        a.source !== "carryover"
      );
      if (yearAllocations.length === 0) continue;

      const totalAllocated = yearAllocations.reduce((sum, a) => sum + a.amountCents, 0);

      const yearAllocIds = yearAllocations.map(a => a.id);

      const carryoverIntoThisYear = allAllocations.filter(a =>
        a.year === year && a.source === "carryover"
      );
      const totalCarryoverIn = carryoverIntoThisYear.reduce((sum, a) => sum + a.amountCents, 0);
      const allAllocIds = [...yearAllocIds, ...carryoverIntoThisYear.map(a => a.id)];

      if (allAllocIds.length === 0) continue;

      const consumptionResult = await d.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
          inArray(budgetTransactions.allocationId, allAllocIds),
          sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
        ));

      const reversalResult = await d.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
          inArray(budgetTransactions.allocationId, allAllocIds),
          eq(budgetTransactions.transactionType, "reversal")
        ));

      const totalConsumed = Number(consumptionResult[0]?.total ?? 0);
      const totalReversed = Number(reversalResult[0]?.total ?? 0);
      const netConsumed = Math.max(0, totalConsumed - totalReversed);
      const totalPool = totalAllocated + totalCarryoverIn;
      const unused = Math.max(0, totalPool - netConsumed);

      if (unused <= 0) continue;

      const result = await d.insert(budgetAllocations).values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: targetYear,
        month: null,
        amountCents: unused,
        source: "carryover",
        validFrom: `${targetYear}-01-01`,
        expiresAt: `${targetYear}-06-30`,
        notes: `Übertrag aus ${year}: ${(unused / 100).toFixed(2)} € (verfällt 30.06.${targetYear})`,
      }).onConflictDoNothing().returning();

      if (result[0]) created.push(result[0]);
    }

    return created;
  }

  async getBudgetSummary(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetSummary> {
    const [preferences, typeSettings] = await Promise.all([
      _preferences !== undefined ? _preferences : this.getBudgetPreferences(customerId),
      _typeSettings ?? this.getBudgetTypeSettings(customerId),
    ]);

    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;
    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const lastDayOfMonth = new Date(currentYear, currentMonth, 0).getDate();
    const currentMonthEnd = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

    const allocValidWhere = and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      lte(budgetAllocations.validFrom, today),
      isNull(budgetAllocations.deletedAt),
      or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
    );

    const allocAllWhere = and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      lte(budgetAllocations.validFrom, today),
      isNull(budgetAllocations.deletedAt)
    );

    const [allocResult, txResult, currentYearResult, carryoverResult, currentMonthResult, currentMonthReversalResult] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(allocAllWhere),

      db.select({
        transactionType: budgetTransactions.transactionType,
        absTotal: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        rawTotal: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b")
      )).groupBy(budgetTransactions.transactionType),

      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(and(
        allocValidWhere,
        eq(budgetAllocations.year, currentYear),
        sql`${budgetAllocations.source} != 'carryover'`
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
        expiresAt: sql<string | null>`MIN(${budgetAllocations.expiresAt})`,
      }).from(budgetAllocations).where(and(
        allocValidWhere,
        eq(budgetAllocations.source, "carryover"),
        sql`${budgetAllocations.expiresAt} IS NOT NULL`
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, currentMonthStart),
        lte(budgetTransactions.transactionDate, currentMonthEnd)
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        eq(budgetTransactions.transactionType, "reversal"),
        gte(budgetTransactions.transactionDate, currentMonthStart),
        lte(budgetTransactions.transactionDate, currentMonthEnd)
      )),
    ]);

    const totalAllocatedCents = Number(allocResult[0]?.total ?? 0);

    const txMap = new Map<string, { absTotal: number; rawTotal: number }>();
    for (const row of txResult) {
      txMap.set(row.transactionType, { absTotal: Number(row.absTotal), rawTotal: Number(row.rawTotal) });
    }
    const consumptionCents = txMap.get("consumption")?.absTotal ?? 0;
    const writeOffCents = txMap.get("write_off")?.absTotal ?? 0;
    const manualAdjustmentCents = txMap.get("manual_adjustment")?.absTotal ?? 0;
    const reversalsCents = txMap.get("reversal")?.rawTotal ?? 0;
    const netUsedCents = consumptionCents + writeOffCents + manualAdjustmentCents - reversalsCents;

    const currentYearAllocatedCents = Number(currentYearResult[0]?.total ?? 0);
    const carryoverCents = Number(carryoverResult[0]?.total ?? 0);
    const carryoverExpiresAt = carryoverCents > 0 ? (carryoverResult[0]?.expiresAt ?? null) : null;
    const currentMonthConsumption = Number(currentMonthResult[0]?.total ?? 0);
    const currentMonthReversals = Number(currentMonthReversalResult[0]?.total ?? 0);
    const currentMonthUsedCents = Math.max(0, currentMonthConsumption - currentMonthReversals);

    const availableCents = totalAllocatedCents - netUsedCents;
    const plannedCents = await this.getPlannedCostCents(customerId);

    return {
      customerId,
      totalAllocatedCents,
      totalUsedCents: netUsedCents,
      availableCents,
      plannedCents,
      availableAfterPlannedCents: availableCents - plannedCents,
      carryoverCents,
      carryoverExpiresAt,
      currentYearAllocatedCents,
      monthlyLimitCents: await this.getEffectiveMonthlyLimitCents(customerId, typeSettings, preferences),
      currentMonthUsedCents,
    };
  }

  private async getEffectiveMonthlyLimitCents(customerId: number, _typeSettings?: CustomerBudgetTypeSetting[], _preferences?: CustomerBudgetPreferences | undefined): Promise<number | null> {
    const typeSettings = _typeSettings ?? await this.getBudgetTypeSettings(customerId);
    const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
    if (s45b?.monthlyLimitCents != null) {
      return s45b.monthlyLimitCents;
    }
    const preferences = _preferences !== undefined ? _preferences : await this.getBudgetPreferences(customerId);
    return preferences?.monthlyLimitCents ?? null;
  }

  async getBudgetPreferences(customerId: number, _tx?: DbClient): Promise<CustomerBudgetPreferences | undefined> {
    const d = _tx ?? db;
    const result = await d.select()
      .from(customerBudgetPreferences)
      .where(eq(customerBudgetPreferences.customerId, customerId))
      .limit(1);
    return result[0];
  }

  async upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number): Promise<CustomerBudgetPreferences> {
    const existing = await this.getBudgetPreferences(preferences.customerId);
    
    if (existing) {
      const result = await db.update(customerBudgetPreferences)
        .set({
          monthlyLimitCents: preferences.monthlyLimitCents,
          budgetStartDate: preferences.budgetStartDate,
          notes: preferences.notes,
          updatedAt: sql`now()`,
        })
        .where(eq(customerBudgetPreferences.customerId, preferences.customerId))
        .returning();
      return result[0];
    }
    
    const result = await db.insert(customerBudgetPreferences)
      .values(preferences)
      .returning();
    return result[0];
  }

  async getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]> {
    const d = _tx ?? db;
    return d.select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId))
      .orderBy(asc(customerBudgetTypeSettings.priority));
  }

  async upsertBudgetTypeSettings(
    customerId: number,
    settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; validFrom?: string | null; validTo?: string | null }>
  ): Promise<CustomerBudgetTypeSetting[]> {
    if (settings.length === 0) {
      await db.delete(customerBudgetTypeSettings)
        .where(eq(customerBudgetTypeSettings.customerId, customerId));
      return [];
    }

    return await db.transaction(async (tx) => {
      await tx.delete(customerBudgetTypeSettings)
        .where(eq(customerBudgetTypeSettings.customerId, customerId));

      return await tx.insert(customerBudgetTypeSettings)
        .values(settings.map(s => ({
          customerId,
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents ?? null,
          yearlyLimitCents: s.yearlyLimitCents ?? null,
          validFrom: s.validFrom ?? null,
          validTo: s.validTo ?? null,
        })))
        .returning();
    });
  }

  async upsertInitialBalanceAllocation(
    params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string },
    userId?: number
  ): Promise<void> {
    const existing = await db.select({ id: budgetAllocations.id, deletedAt: budgetAllocations.deletedAt })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, params.customerId),
        eq(budgetAllocations.budgetType, params.budgetType),
        eq(budgetAllocations.source, "initial_balance"),
        eq(budgetAllocations.year, params.year),
        eq(budgetAllocations.month, params.month),
      ))
      .orderBy(desc(budgetAllocations.id));

    if (existing.length > 0) {
      await db.update(budgetAllocations)
        .set({
          amountCents: params.amountCents,
          month: params.month,
          validFrom: params.validFrom,
          expiresAt: params.expiresAt,
          notes: params.notes ?? null,
          deletedAt: null,
        })
        .where(eq(budgetAllocations.id, existing[0].id));

      if (existing.length > 1) {
        for (let i = 1; i < existing.length; i++) {
          await db.update(budgetAllocations)
            .set({ deletedAt: new Date() })
            .where(eq(budgetAllocations.id, existing[i].id));
        }
      }
    } else {
      await db.insert(budgetAllocations)
        .values({
          customerId: params.customerId,
          budgetType: params.budgetType,
          year: params.year,
          month: params.month,
          amountCents: params.amountCents,
          source: "initial_balance",
          validFrom: params.validFrom,
          expiresAt: params.expiresAt,
          notes: params.notes ?? null,
          createdByUserId: userId,
        });
    }
  }

  async getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]> {
    return db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, budgetType),
        isNull(budgetAllocations.deletedAt),
        or(
          eq(budgetAllocations.source, "initial_balance"),
          eq(budgetAllocations.source, "carryover"),
        ),
      ))
      .orderBy(desc(budgetAllocations.validFrom));
  }

  async calculateAppointmentCost(params: {
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
  }> {
    const [hwService, abService, travelKmService, customerKmService] = await Promise.all([
      serviceCatalogStorage.getServiceByCode("hauswirtschaft"),
      serviceCatalogStorage.getServiceByCode("alltagsbegleitung"),
      serviceCatalogStorage.getServiceByCode("travel_km"),
      serviceCatalogStorage.getServiceByCode("customer_km"),
    ]);

    if (!hwService && !abService && !travelKmService && !customerKmService) {
      throw new Error(`Keine Preisvereinbarung für Kunde ${params.customerId} zum Datum ${params.date} gefunden`);
    }

    const customerPrices = await db.execute(sql`
      SELECT s.code AS "serviceCode", csp.price_cents AS "priceCents"
      FROM customer_service_prices csp
      INNER JOIN services s ON s.id = csp.service_id
      WHERE csp.customer_id = ${params.customerId}
        AND csp.valid_from::date <= ${params.date}::date
        AND (csp.valid_to IS NULL OR csp.valid_to::date >= ${params.date}::date)
    `);

    const cpMap = new Map(customerPrices.rows.map((cp: any) => [cp.serviceCode, cp.priceCents]));

    const hauswirtschaftRateCents = cpMap.get("hauswirtschaft")
      ?? ((hwService?.isBillable !== false) ? (hwService?.defaultPriceCents || 0) : 0);
    const alltagsbegleitungRateCents = cpMap.get("alltagsbegleitung")
      ?? ((abService?.isBillable !== false) ? (abService?.defaultPriceCents || 0) : 0);
    const travelKmRateCents = cpMap.get("travel_km")
      ?? ((travelKmService?.isBillable !== false) ? (travelKmService?.defaultPriceCents || 0) : 0);
    const customerKmRateCents = cpMap.get("customer_km")
      ?? ((customerKmService?.isBillable !== false) ? (customerKmService?.defaultPriceCents || 0) : 0);

    const hauswirtschaftCents = Math.round((params.hauswirtschaftMinutes / 60) * hauswirtschaftRateCents);
    const alltagsbegleitungCents = Math.round((params.alltagsbegleitungMinutes / 60) * alltagsbegleitungRateCents);
    const travelCents = Math.round(params.travelKilometers * travelKmRateCents);
    const customerKilometersCents = Math.round(params.customerKilometers * customerKmRateCents);

    const totalCents = hauswirtschaftCents + alltagsbegleitungCents + travelCents + customerKilometersCents;

    return {
      hauswirtschaftCents,
      alltagsbegleitungCents,
      travelCents,
      customerKilometersCents,
      totalCents,
    };
  }

  async getPlannedCostCents(customerId: number): Promise<number> {
    const rows = await db.execute(sql`
      SELECT 
        a.id AS "appointmentId",
        s.lohnart_kategorie AS "lohnartKategorie",
        aps.planned_duration_minutes AS "plannedMinutes",
        a.date AS "appointmentDate",
        a.travel_kilometers AS "travelKm",
        a.customer_kilometers AS "customerKm"
      FROM appointments a
      INNER JOIN appointment_services aps ON aps.appointment_id = a.id
      INNER JOIN services s ON s.id = aps.service_id
      WHERE a.customer_id = ${customerId}
        AND a.appointment_type = 'Kundentermin'
        AND a.status IN ('scheduled', 'in_progress', 'documenting')
        AND a.deleted_at IS NULL
    `);

    if (rows.rows.length === 0) {
      return 0;
    }

    const perAppointment = new Map<number, { date: string; hwMinutes: number; abMinutes: number; travelKm: number; customerKm: number }>();

    for (const row of rows.rows as any[]) {
      const apptId = row.appointmentId as number;
      if (!perAppointment.has(apptId)) {
        perAppointment.set(apptId, {
          date: `${row.appointmentDate}`,
          hwMinutes: 0,
          abMinutes: 0,
          travelKm: row.travelKm || 0,
          customerKm: row.customerKm || 0,
        });
      }
      const data = perAppointment.get(apptId)!;
      const minutes = row.plannedMinutes || 0;
      if (row.lohnartKategorie === "hauswirtschaft") {
        data.hwMinutes += minutes;
      } else if (row.lohnartKategorie === "alltagsbegleitung") {
        data.abMinutes += minutes;
      }
    }

    let totalPlannedCents = 0;

    for (const [, data] of perAppointment) {
      const costs = await this.calculateAppointmentCost({
        customerId,
        hauswirtschaftMinutes: data.hwMinutes,
        alltagsbegleitungMinutes: data.abMinutes,
        travelKilometers: data.travelKm,
        customerKilometers: data.customerKm,
        date: data.date,
      });
      totalPlannedCents += costs.totalCents;
    }

    return totalPlannedCents;
  }

  async createConsumptionTransaction(params: {
    customerId: number;
    appointmentId: number;
    transactionDate: string;
    hauswirtschaftMinutes: number;
    alltagsbegleitungMinutes: number;
    travelKilometers: number;
    customerKilometers: number;
    userId?: number;
  }, outerTx?: DbClient): Promise<BudgetTransaction> {
    const client = outerTx || db;
    const costs = await this.calculateAppointmentCost({
      customerId: params.customerId,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      travelKilometers: params.travelKilometers,
      customerKilometers: params.customerKilometers,
      date: params.transactionDate,
    });

    const [customer] = await client.select({ acceptsPrivatePayment: customers.acceptsPrivatePayment })
      .from(customers).where(eq(customers.id, params.customerId)).limit(1);
    const acceptsPrivatePayment = customer?.acceptsPrivatePayment ?? false;

    const hasUsage = costs.totalCents > 0;
    if (!hasUsage) {
      const cascadeResult = await this.createCascadeConsumption({
        customerId: params.customerId,
        appointmentId: params.appointmentId,
        transactionDate: params.transactionDate,
        totalAmountCents: 0,
        hauswirtschaftMinutes: params.hauswirtschaftMinutes,
        hauswirtschaftCents: 0,
        alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
        alltagsbegleitungCents: 0,
        travelKilometers: 0,
        travelCents: 0,
        customerKilometers: 0,
        customerKilometersCents: 0,
        userId: params.userId,
      }, outerTx);
      return cascadeResult.transactions[0];
    }

    const doWork = async (tx: DbClient) => {
      await (tx as typeof db).execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(params.customerId))})`);

      if (!acceptsPrivatePayment) {
        const summaries = await this.getAllBudgetSummaries(params.customerId);
        const typeSettings = await this.getBudgetTypeSettings(params.customerId);

        let total45b = summaries.entlastungsbetrag45b.availableCents;
        let total45a = summaries.umwandlung45a.currentMonthAvailableCents;
        let total39_42a = summaries.ersatzpflege39_42a.currentYearAvailableCents;

        if (typeSettings.length > 0) {
          const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));
          const s45b = settingsMap.get("entlastungsbetrag_45b");
          if (s45b && !s45b.enabled) total45b = 0;
          const s45a = settingsMap.get("umwandlung_45a");
          if (s45a && !s45a.enabled) total45a = 0;
          const s39 = settingsMap.get("ersatzpflege_39_42a");
          if (s39 && !s39.enabled) total39_42a = 0;
        }

        const totalAvailable = total45a + total45b + total39_42a;

        if (costs.totalCents > totalAvailable) {
          const shortfall = costs.totalCents - totalAvailable;
          const shortfallEuro = (shortfall / 100).toFixed(2).replace(".", ",");
          throw new Error(
            `Budget reicht nicht — es fehlen ${shortfallEuro} €. Kunde akzeptiert keine Privatzahlung.`
          );
        }
      }

      const cascadeResult = await this.createCascadeConsumption({
        customerId: params.customerId,
        appointmentId: params.appointmentId,
        transactionDate: params.transactionDate,
        totalAmountCents: costs.totalCents,
        hauswirtschaftMinutes: params.hauswirtschaftMinutes,
        hauswirtschaftCents: costs.hauswirtschaftCents,
        alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
        alltagsbegleitungCents: costs.alltagsbegleitungCents,
        travelKilometers: Math.round(params.travelKilometers * 10),
        travelCents: costs.travelCents,
        customerKilometers: Math.round(params.customerKilometers * 10),
        customerKilometersCents: costs.customerKilometersCents,
        userId: params.userId,
      }, tx);

      if (cascadeResult.outstandingCents > 0) {
        if (acceptsPrivatePayment) {
          const privateRatio = costs.totalCents > 0 ? cascadeResult.outstandingCents / costs.totalCents : 1;
          const [privateTransaction] = await tx.insert(budgetTransactions).values({
            customerId: params.customerId,
            budgetType: "private",
            transactionDate: params.transactionDate,
            transactionType: "consumption",
            amountCents: -cascadeResult.outstandingCents,
            appointmentId: params.appointmentId,
            hauswirtschaftMinutes: Math.round(params.hauswirtschaftMinutes * privateRatio),
            hauswirtschaftCents: Math.round(costs.hauswirtschaftCents * privateRatio),
            alltagsbegleitungMinutes: Math.round(params.alltagsbegleitungMinutes * privateRatio),
            alltagsbegleitungCents: Math.round(costs.alltagsbegleitungCents * privateRatio),
            travelKilometers: Math.round(Math.round(params.travelKilometers * 10) * privateRatio),
            travelCents: Math.round(costs.travelCents * privateRatio),
            customerKilometers: Math.round(Math.round(params.customerKilometers * 10) * privateRatio),
            customerKilometersCents: Math.round(costs.customerKilometersCents * privateRatio),
            createdByUserId: params.userId,
            notes: `Privatzahlung: ${(cascadeResult.outstandingCents / 100).toFixed(2)} €`,
          }).returning();
          return cascadeResult.transactions[0] ?? privateTransaction;
        }
        const shortfallEuro = (cascadeResult.outstandingCents / 100).toFixed(2).replace(".", ",");
        throw new Error(
          `Budget reicht nicht — es fehlen ${shortfallEuro} €. Kunde akzeptiert keine Privatzahlung.`
        );
      }

      return cascadeResult.transactions[0];
    };

    if (outerTx) {
      return await doWork(outerTx);
    }
    return await db.transaction(async (tx) => doWork(tx));
  }

  async getCustomerBudgetAmounts(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }> {
    const d = _tx ?? db;

    const typeSettings = _typeSettings ?? await this.getBudgetTypeSettings(customerId, _tx);
    const setting45a = typeSettings.find(s => s.budgetType === "umwandlung_45a");
    const setting39 = typeSettings.find(s => s.budgetType === "ersatzpflege_39_42a");

    if (setting45a?.monthlyLimitCents != null || setting39?.yearlyLimitCents != null) {
      return {
        pflegesachleistungen36: setting45a?.monthlyLimitCents ?? 0,
        verhinderungspflege39: setting39?.yearlyLimitCents ?? 0,
      };
    }

    const result = await d.select().from(customerBudgets).where(and(eq(customerBudgets.customerId, customerId), isNull(customerBudgets.validTo))).limit(1);
    if (result[0]) {
      return {
        pflegesachleistungen36: result[0].pflegesachleistungen36 ?? 0,
        verhinderungspflege39: result[0].verhinderungspflege39 ?? 0,
      };
    }
    return { pflegesachleistungen36: 0, verhinderungspflege39: 0 };
  }

  async ensureAllocations45a(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const startDateStr = await this.resolveStartDate(customerId, "umwandlung_45a", d, _preferences);
    if (!startDateStr) return [];

    const amounts = _amounts ?? await this.getCustomerBudgetAmounts(customerId, _tx);
    if (!amounts.pflegesachleistungen36) return [];

    const startDate = parseLocalDate(startDateStr);
    return this.ensureAllocationsGeneric({
      customerId,
      budgetType: "umwandlung_45a",
      frequency: 'monthly',
      source: "monthly_auto",
      amountCents: amounts.pflegesachleistungen36,
      getExpiresAt: (y, m) => lastDayOfMonth(y, m),
      getNotes: (y, m) => `Automatische Zuweisung §45a ${String(m).padStart(2, '0')}/${y}`,
      startYear: startDate.getFullYear(),
      startMonth: startDate.getMonth() + 1,
    }, d);
  }

  async ensureAllocations39_42a(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const startDateStr = await this.resolveStartDate(customerId, "ersatzpflege_39_42a", d, _preferences);
    if (!startDateStr) return [];

    const amounts = _amounts ?? await this.getCustomerBudgetAmounts(customerId, _tx);
    if (!amounts.verhinderungspflege39) return [];

    const startDate = parseLocalDate(startDateStr);
    return this.ensureAllocationsGeneric({
      customerId,
      budgetType: "ersatzpflege_39_42a",
      frequency: 'yearly',
      source: "yearly_auto",
      amountCents: amounts.verhinderungspflege39,
      getExpiresAt: (y) => lastDayOfYear(y),
      getNotes: (y) => `Automatische Zuweisung §39/§42a ${y}`,
      startYear: startDate.getFullYear(),
      startMonth: startDate.getMonth() + 1,
      startDateStr,
    }, d);
  }

  async getBudgetSummary45a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }): Promise<Budget45aSummary> {
    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;
    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const currentMonthLastDay = lastDayOfMonth(currentYear, currentMonth);

    const amounts = _amounts ?? await this.getCustomerBudgetAmounts(customerId);

    const [allocResult, txConsumptionResult, txReversalResult] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "umwandlung_45a"),
        eq(budgetAllocations.year, currentYear),
        eq(budgetAllocations.month, currentMonth),
        lte(budgetAllocations.validFrom, today),
        isNull(budgetAllocations.deletedAt),
        or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "umwandlung_45a"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, currentMonthStart),
        lte(budgetTransactions.transactionDate, currentMonthLastDay)
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "umwandlung_45a"),
        eq(budgetTransactions.transactionType, "reversal"),
        gte(budgetTransactions.transactionDate, currentMonthStart),
        lte(budgetTransactions.transactionDate, currentMonthLastDay)
      )),
    ]);

    const currentMonthAllocatedCents = Number(allocResult[0]?.total ?? 0);
    const currentMonthUsedCents = Math.max(0, Number(txConsumptionResult[0]?.total ?? 0) - Number(txReversalResult[0]?.total ?? 0));

    return {
      customerId,
      monthlyBudgetCents: amounts.pflegesachleistungen36,
      currentMonthAllocatedCents,
      currentMonthUsedCents,
      currentMonthAvailableCents: currentMonthAllocatedCents - currentMonthUsedCents,
    };
  }

  async getBudgetSummary39_42a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }): Promise<Budget39_42aSummary> {
    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    const amounts = _amounts ?? await this.getCustomerBudgetAmounts(customerId);

    const [allocResult, txConsumptionResult, txReversalResult] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
        eq(budgetAllocations.year, currentYear),
        lte(budgetAllocations.validFrom, today),
        isNull(budgetAllocations.deletedAt),
        or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, yearStart),
        lte(budgetTransactions.transactionDate, yearEnd)
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
        eq(budgetTransactions.transactionType, "reversal"),
        gte(budgetTransactions.transactionDate, yearStart),
        lte(budgetTransactions.transactionDate, yearEnd)
      )),
    ]);

    const currentYearAllocatedCents = Number(allocResult[0]?.total ?? 0);
    const currentYearUsedCents = Math.max(0, Number(txConsumptionResult[0]?.total ?? 0) - Number(txReversalResult[0]?.total ?? 0));

    return {
      customerId,
      yearlyBudgetCents: amounts.verhinderungspflege39,
      currentYearAllocatedCents,
      currentYearUsedCents,
      currentYearAvailableCents: currentYearAllocatedCents - currentYearUsedCents,
    };
  }

  async getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries> {
    await this.syncBudgetAllocations(customerId);

    const [preferences, typeSettings] = await Promise.all([
      this.getBudgetPreferences(customerId),
      this.getBudgetTypeSettings(customerId),
    ]);
    const amounts = await this.getCustomerBudgetAmounts(customerId, undefined, typeSettings);

    const is45aEnabled = typeSettings.some(s => s.budgetType === "umwandlung_45a" && s.enabled);
    const is39Enabled = typeSettings.some(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);

    const [entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a] = await Promise.all([
      this.getBudgetSummary(customerId, preferences, typeSettings),
      is45aEnabled
        ? this.getBudgetSummary45a(customerId, preferences, amounts)
        : { customerId, monthlyBudgetCents: 0, currentMonthAllocatedCents: 0, currentMonthUsedCents: 0, currentMonthAvailableCents: 0 } as Budget45aSummary,
      is39Enabled
        ? this.getBudgetSummary39_42a(customerId, preferences, amounts)
        : { customerId, yearlyBudgetCents: 0, currentYearAllocatedCents: 0, currentYearUsedCents: 0, currentYearAvailableCents: 0 } as Budget39_42aSummary,
    ]);
    return { entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a };
  }

  async getTotalCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
    const d = _tx ?? db;
    const carryoverAllocations = await d.select({
      total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
    })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
        lte(budgetAllocations.validFrom, asOfDate),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, asOfDate)
        )
      ));

    return Number(carryoverAllocations[0]?.total ?? 0);
  }

  async getAvailableCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
    const d = _tx ?? db;
    const carryoverAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
        lte(budgetAllocations.validFrom, asOfDate),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, asOfDate)
        )
      ));

    if (carryoverAllocations.length === 0) return 0;

    const allocationIds = carryoverAllocations.map(a => a.id);
    const consumed = await d.select({
      allocationId: budgetTransactions.allocationId,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        inArray(budgetTransactions.allocationId, allocationIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
      ))
      .groupBy(budgetTransactions.allocationId);

    const reversed = await d.select({
      allocationId: budgetTransactions.allocationId,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        inArray(budgetTransactions.allocationId, allocationIds),
        eq(budgetTransactions.transactionType, "reversal")
      ))
      .groupBy(budgetTransactions.allocationId);

    const consumedMap = new Map(consumed.map(c => [c.allocationId, Number(c.total)]));
    const reversalMap = new Map(reversed.map(r => [r.allocationId, Number(r.total)]));

    let totalAvailable = 0;
    for (const alloc of carryoverAllocations) {
      const used = consumedMap.get(alloc.id) ?? 0;
      const rev = reversalMap.get(alloc.id) ?? 0;
      totalAvailable += Math.max(0, alloc.amountCents - Math.max(0, used - rev));
    }

    return totalAvailable;
  }

  async processExpiredCarryover(customerId: number, _tx?: DbClient): Promise<BudgetTransaction[]> {
    const d = _tx ?? db;
    const today = todayISO();

    const expiredAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
        sql`${budgetAllocations.expiresAt} IS NOT NULL`,
        sql`${budgetAllocations.expiresAt} < ${today}`
      ))
      .orderBy(asc(budgetAllocations.validFrom));

    if (expiredAllocations.length === 0) return [];

    const existingWriteOffs = await d.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        eq(budgetTransactions.transactionType, "write_off")
      ));

    const writtenOffAllocationIds = new Set(
      existingWriteOffs.filter(t => t.allocationId !== null).map(t => t.allocationId)
    );

    const created: BudgetTransaction[] = [];

    for (const allocation of expiredAllocations) {
      if (writtenOffAllocationIds.has(allocation.id)) continue;

      const consumedFromAllocation = await d.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.allocationId, allocation.id),
          sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
        ));

      const reversedFromAllocation = await d.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.allocationId, allocation.id),
          eq(budgetTransactions.transactionType, "reversal")
        ));

      const consumed = Number(consumedFromAllocation[0]?.total ?? 0);
      const reversed = Number(reversedFromAllocation[0]?.total ?? 0);
      const remaining = allocation.amountCents - Math.max(0, consumed - reversed);

      if (remaining <= 0) continue;

      const writeOff = await d.insert(budgetTransactions).values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: allocation.expiresAt!,
        transactionType: "write_off",
        amountCents: -remaining,
        allocationId: allocation.id,
        notes: `Verfallenes Guthaben aus ${allocation.year}: ${(remaining / 100).toFixed(2)} € (Frist ${allocation.expiresAt})`,
      }).returning();

      if (writeOff[0]) created.push(writeOff[0]);
    }

    return created;
  }

  async consumeFifo(
    customerId: number,
    budgetType: string,
    amountCents: number,
    transactionDate: string,
    params?: {
      appointmentId?: number;
      notes?: string;
      userId?: number;
      hauswirtschaftMinutes?: number;
      hauswirtschaftCents?: number;
      alltagsbegleitungMinutes?: number;
      alltagsbegleitungCents?: number;
      travelKilometers?: number;
      travelCents?: number;
      customerKilometers?: number;
      customerKilometersCents?: number;
    },
    _tx?: DbClient
  ): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }> {
    const d = _tx ?? db;
    const today = transactionDate;

    const allocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, budgetType),
        isNull(budgetAllocations.deletedAt),
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ))
      .orderBy(
        sql`CASE WHEN ${budgetAllocations.source} = 'carryover' THEN 0 ELSE 1 END`,
        asc(budgetAllocations.validFrom),
        asc(budgetAllocations.id)
      );

    if (allocations.length === 0) {
      return { consumedCents: 0, transactions: [], remainingCents: amountCents };
    }

    const allocationIds = allocations.map(a => a.id);
    const consumptionByAllocation = allocationIds.length > 0
      ? await d.select({
          allocationId: budgetTransactions.allocationId,
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            inArray(budgetTransactions.allocationId, allocationIds),
            sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
          ))
          .groupBy(budgetTransactions.allocationId)
      : [];

    const reversalByAllocation = allocationIds.length > 0
      ? await d.select({
          allocationId: budgetTransactions.allocationId,
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            inArray(budgetTransactions.allocationId, allocationIds),
            eq(budgetTransactions.transactionType, "reversal")
          ))
          .groupBy(budgetTransactions.allocationId)
      : [];

    const consumedMap = new Map(consumptionByAllocation.map(c => [c.allocationId, Number(c.total)]));
    const reversalMap = new Map(reversalByAllocation.map(r => [r.allocationId, Number(r.total)]));

    const allocationConsumption = allocations.map(a => {
      const consumed = consumedMap.get(a.id) ?? 0;
      const reversed = reversalMap.get(a.id) ?? 0;
      const netConsumed = Math.max(0, consumed - reversed);
      return { allocation: a, consumed: netConsumed, available: Math.max(0, a.amountCents - netConsumed) };
    });

    let remaining = amountCents;
    let totalConsumed = 0;
    const transactions: BudgetTransaction[] = [];
    let isFirstTransaction = true;

    for (const { allocation, available } of allocationConsumption) {
      if (remaining <= 0 || available <= 0) continue;

      const consumeAmount = Math.min(remaining, available);

      const txData: any = {
        customerId,
        budgetType,
        transactionDate,
        transactionType: "consumption" as const,
        amountCents: -consumeAmount,
        allocationId: allocation.id,
        appointmentId: params?.appointmentId ?? null,
        notes: params?.notes ?? null,
        createdByUserId: params?.userId,
      };

      if (params) {
        const ratio = amountCents > 0 ? consumeAmount / amountCents : (isFirstTransaction ? 1 : 0);
        txData.hauswirtschaftMinutes = params.hauswirtschaftMinutes != null ? Math.round(params.hauswirtschaftMinutes * ratio) : null;
        txData.hauswirtschaftCents = params.hauswirtschaftCents != null ? Math.round(params.hauswirtschaftCents * ratio) : null;
        txData.alltagsbegleitungMinutes = params.alltagsbegleitungMinutes != null ? Math.round(params.alltagsbegleitungMinutes * ratio) : null;
        txData.alltagsbegleitungCents = params.alltagsbegleitungCents != null ? Math.round(params.alltagsbegleitungCents * ratio) : null;
        txData.travelKilometers = params.travelKilometers != null ? Math.round(params.travelKilometers * ratio) : null;
        txData.travelCents = params.travelCents != null ? Math.round(params.travelCents * ratio) : null;
        txData.customerKilometers = params.customerKilometers != null ? Math.round(params.customerKilometers * ratio) : null;
        txData.customerKilometersCents = params.customerKilometersCents != null ? Math.round(params.customerKilometersCents * ratio) : null;
      }

      const result = await d.insert(budgetTransactions).values(txData).returning();
      if (result[0]) transactions.push(result[0]);

      remaining -= consumeAmount;
      totalConsumed += consumeAmount;
      isFirstTransaction = false;
    }

    return { consumedCents: totalConsumed, transactions, remainingCents: remaining };
  }

  async createCascadeConsumption(params: {
    customerId: number;
    appointmentId: number;
    transactionDate: string;
    totalAmountCents: number;
    hauswirtschaftMinutes: number;
    hauswirtschaftCents: number;
    alltagsbegleitungMinutes: number;
    alltagsbegleitungCents: number;
    travelKilometers: number;
    travelCents: number;
    customerKilometers: number;
    customerKilometersCents: number;
    userId?: number;
    skipExistingCheck?: boolean;
  }, outerTx?: DbClient): Promise<CascadeResult> {
    const doWork = async (tx: DbClient) => {
      if (!params.skipExistingCheck) {
        const existingTransaction = await this.getTransactionByAppointmentId(params.appointmentId, tx);
        if (existingTransaction) {
          throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
        }
      }

      const typeSettings = await this.getBudgetTypeSettings(params.customerId, tx);

      await this.syncBudgetAllocations(params.customerId, tx, undefined, typeSettings);

      const defaultPriority: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null }> = [
        { budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: null },
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null },
      ];

      let priorityOrder: Array<{ budgetType: string; enabled: boolean; monthlyLimitCents: number | null; yearlyLimitCents: number | null; validFrom: string | null; validTo: string | null }>;

      if (typeSettings.length > 0) {
        const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));
        priorityOrder = defaultPriority.map(d => {
          const s = settingsMap.get(d.budgetType);
          return {
            budgetType: d.budgetType,
            enabled: s ? s.enabled : d.enabled,
            monthlyLimitCents: s ? s.monthlyLimitCents : d.monthlyLimitCents,
            yearlyLimitCents: s?.yearlyLimitCents ?? null,
            validFrom: s?.validFrom ?? null,
            validTo: s?.validTo ?? null,
          };
        });
        priorityOrder.sort((a, b) => {
          const aPrio = settingsMap.get(a.budgetType)?.priority ?? defaultPriority.find(d => d.budgetType === a.budgetType)!.priority;
          const bPrio = settingsMap.get(b.budgetType)?.priority ?? defaultPriority.find(d => d.budgetType === b.budgetType)!.priority;
          return aPrio - bPrio;
        });
      } else {
        const preferences = await this.getBudgetPreferences(params.customerId, tx);
        priorityOrder = defaultPriority.map(d => ({
          ...d,
          monthlyLimitCents: d.budgetType === "entlastungsbetrag_45b" ? (preferences?.monthlyLimitCents ?? null) : null,
          yearlyLimitCents: null,
          validFrom: null,
          validTo: null,
        }));
      }

      let remaining = params.totalAmountCents;
      const allTransactions: BudgetTransaction[] = [];
      const breakdown: Array<{ budgetType: string; consumedCents: number }> = [];

      for (const pot of priorityOrder) {
        if (remaining <= 0) break;
        if (!pot.enabled) {
          breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
          continue;
        }

        if (pot.validFrom && params.transactionDate < pot.validFrom) {
          breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
          continue;
        }
        if (pot.validTo && params.transactionDate > pot.validTo) {
          breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
          continue;
        }

        let maxConsumable = remaining;

        const isMonthlyBudget = pot.budgetType === "entlastungsbetrag_45b" || pot.budgetType === "umwandlung_45a";
        if (isMonthlyBudget && pot.monthlyLimitCents !== null) {
          const txDate = parseLocalDate(params.transactionDate);
          const txYear = txDate.getFullYear();
          const txMonth = txDate.getMonth() + 1;
          const currentMonthStart = `${txYear}-${String(txMonth).padStart(2, '0')}-01`;
          const lastDay = new Date(txYear, txMonth, 0).getDate();
          const currentMonthEnd = `${txYear}-${String(txMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

          const monthConsumptions = await tx.select({
            total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
          })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, params.customerId),
              eq(budgetTransactions.budgetType, pot.budgetType),
              eq(budgetTransactions.transactionType, "consumption"),
              gte(budgetTransactions.transactionDate, currentMonthStart),
              lte(budgetTransactions.transactionDate, currentMonthEnd)
            ));

          const monthReversals = await tx.select({
            total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
          })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, params.customerId),
              eq(budgetTransactions.budgetType, pot.budgetType),
              eq(budgetTransactions.transactionType, "reversal"),
              gte(budgetTransactions.transactionDate, currentMonthStart),
              lte(budgetTransactions.transactionDate, currentMonthEnd)
            ));

          const alreadyUsedThisMonth = Math.max(0, Number(monthConsumptions[0]?.total ?? 0) - Number(monthReversals[0]?.total ?? 0));

          let effectiveMonthlyLimit = pot.monthlyLimitCents;
          if (pot.budgetType === "entlastungsbetrag_45b") {
            const totalCarryover = await this.getTotalCarryoverCents(params.customerId, params.transactionDate, tx);
            effectiveMonthlyLimit = pot.monthlyLimitCents + totalCarryover;
          }

          const monthlyRemaining = Math.max(0, effectiveMonthlyLimit - alreadyUsedThisMonth);
          maxConsumable = Math.min(remaining, monthlyRemaining);
        }

        if (pot.budgetType === "ersatzpflege_39_42a" && pot.yearlyLimitCents !== null) {
          const txDate = parseLocalDate(params.transactionDate);
          const txYear = txDate.getFullYear();
          const yearStart = `${txYear}-01-01`;
          const yearEnd = `${txYear}-12-31`;

          const yearConsumptions = await tx.select({
            total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
          })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, params.customerId),
              eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
              eq(budgetTransactions.transactionType, "consumption"),
              gte(budgetTransactions.transactionDate, yearStart),
              lte(budgetTransactions.transactionDate, yearEnd)
            ));

          const yearReversals = await tx.select({
            total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
          })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, params.customerId),
              eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
              eq(budgetTransactions.transactionType, "reversal"),
              gte(budgetTransactions.transactionDate, yearStart),
              lte(budgetTransactions.transactionDate, yearEnd)
            ));

          const alreadyUsedThisYear = Math.max(0, Number(yearConsumptions[0]?.total ?? 0) - Number(yearReversals[0]?.total ?? 0));
          const yearlyRemaining = Math.max(0, pot.yearlyLimitCents - alreadyUsedThisYear);
          maxConsumable = Math.min(maxConsumable, yearlyRemaining);
        }

        if (maxConsumable <= 0) {
          breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
          continue;
        }

        const isFirstPot = allTransactions.length === 0;
        const fifoResult = await this.consumeFifo(
          params.customerId,
          pot.budgetType,
          maxConsumable,
          params.transactionDate,
          isFirstPot ? {
            appointmentId: params.appointmentId,
            userId: params.userId,
            hauswirtschaftMinutes: params.hauswirtschaftMinutes,
            hauswirtschaftCents: params.hauswirtschaftCents,
            alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
            alltagsbegleitungCents: params.alltagsbegleitungCents,
            travelKilometers: params.travelKilometers,
            travelCents: params.travelCents,
            customerKilometers: params.customerKilometers,
            customerKilometersCents: params.customerKilometersCents,
          } : {
            appointmentId: params.appointmentId,
            userId: params.userId,
          },
          tx
        );

        allTransactions.push(...fifoResult.transactions);
        remaining -= fifoResult.consumedCents;
        breakdown.push({ budgetType: pot.budgetType, consumedCents: fifoResult.consumedCents });
      }

      return {
        transactions: allTransactions,
        totalConsumedCents: params.totalAmountCents - remaining,
        outstandingCents: remaining,
        breakdown,
      };
    };

    if (outerTx) {
      return await doWork(outerTx);
    }
    return await db.transaction(async (tx: DbClient) => doWork(tx));
  }
  async rebookSingleTransaction(
    customerId: number,
    transactionId: number,
    targetBudgetType: string,
    userId: number
  ): Promise<{ reversalTransaction: BudgetTransaction; newTransaction: BudgetTransaction | null; amountCents: number }> {
    return await db.transaction(async (tx) => {
      const [original] = await tx.select()
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.id, transactionId),
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.transactionType, "consumption"),
        ))
        .limit(1);

      if (!original) {
        throw new Error("Transaktion nicht gefunden oder keine Verbrauchsbuchung");
      }

      if (original.budgetType === targetBudgetType) {
        throw new Error("Ziel-Topf ist gleich dem aktuellen Topf");
      }

      const existingReversal = await tx.select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.customerId, customerId),
          eq(budgetTransactions.transactionType, "reversal"),
          eq(budgetTransactions.appointmentId, original.appointmentId!),
          eq(budgetTransactions.budgetType, original.budgetType),
        ))
        .limit(1);

      if (existingReversal.length > 0) {
        throw new Error("Diese Buchung wurde bereits storniert oder umgebucht");
      }

      const absAmount = Math.abs(original.amountCents);

      const [reversalTransaction] = await tx.insert(budgetTransactions)
        .values({
          customerId,
          budgetType: original.budgetType,
          transactionDate: original.transactionDate,
          transactionType: "reversal",
          amountCents: absAmount,
          appointmentId: original.appointmentId,
          allocationId: original.allocationId,
          notes: `Storno für Umbuchung nach ${targetBudgetType} (Transaktion #${transactionId})`,
          createdByUserId: userId,
        })
        .returning();

      const fifoResult = await this.consumeFifo(
        customerId,
        targetBudgetType,
        absAmount,
        original.transactionDate,
        {
          appointmentId: original.appointmentId ?? undefined,
          userId,
          hauswirtschaftMinutes: original.hauswirtschaftMinutes ?? undefined,
          hauswirtschaftCents: original.hauswirtschaftCents ?? undefined,
          alltagsbegleitungMinutes: original.alltagsbegleitungMinutes ?? undefined,
          alltagsbegleitungCents: original.alltagsbegleitungCents ?? undefined,
          travelKilometers: original.travelKilometers ?? undefined,
          travelCents: original.travelCents ?? undefined,
          customerKilometers: original.customerKilometers ?? undefined,
          customerKilometersCents: original.customerKilometersCents ?? undefined,
          notes: `Umbuchung von ${original.budgetType} (Transaktion #${transactionId})`,
        },
        tx
      );

      if (fifoResult.consumedCents < absAmount) {
        throw new Error(`Ziel-Topf hat nicht genug Budget. Verfügbar: ${(fifoResult.consumedCents / 100).toFixed(2)} €, benötigt: ${(absAmount / 100).toFixed(2)} €`);
      }

      return {
        reversalTransaction,
        newTransaction: fifoResult.transactions[0] ?? null,
        amountCents: absAmount,
      };
    });
  }

  async getRebookPreview(customerId: number): Promise<{
    disabledTypes: string[];
    affectedAppointments: number;
    totalAmountCents: number;
    transactions: Array<{ id: number; budgetType: string; amountCents: number; appointmentId: number | null; transactionDate: string }>;
  }> {
    const typeSettings = await this.getBudgetTypeSettings(customerId);
    const disabledTypes = typeSettings.filter(s => !s.enabled).map(s => s.budgetType);

    if (disabledTypes.length === 0) {
      return { disabledTypes: [], affectedAppointments: 0, totalAmountCents: 0, transactions: [] };
    }

    const consumptions = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "consumption"),
        inArray(budgetTransactions.budgetType, disabledTypes),
      ));

    const reversals = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "reversal"),
        inArray(budgetTransactions.budgetType, disabledTypes),
      ));

    const reversedIds = new Set(
      reversals
        .map(r => r.notes?.match(/Storno von Transaktion #(\d+)/)?.[1])
        .filter(Boolean)
        .map(Number)
    );

    const unreversed = consumptions.filter(c => !reversedIds.has(c.id));

    const appointmentIds = new Set(unreversed.filter(c => c.appointmentId).map(c => c.appointmentId!));
    const totalAmountCents = unreversed.reduce((sum, c) => sum + Math.abs(c.amountCents), 0);

    return {
      disabledTypes,
      affectedAppointments: appointmentIds.size,
      totalAmountCents,
      transactions: unreversed.map(c => ({
        id: c.id,
        budgetType: c.budgetType,
        amountCents: c.amountCents,
        appointmentId: c.appointmentId,
        transactionDate: c.transactionDate,
      })),
    };
  }

  async rebookDisabledBudgetTransactions(customerId: number, userId: number): Promise<{
    reversedCount: number;
    rebookedCount: number;
    totalOldAmountCents: number;
    totalNewAmountCents: number;
    errors: Array<{ appointmentId: number; error: string }>;
  }> {
    const preview = await this.getRebookPreview(customerId);
    if (preview.transactions.length === 0) {
      return { reversedCount: 0, rebookedCount: 0, totalOldAmountCents: 0, totalNewAmountCents: 0, errors: [] };
    }

    const byAppointment = new Map<number, typeof preview.transactions>();
    for (const tx of preview.transactions) {
      if (!tx.appointmentId) continue;
      const existing = byAppointment.get(tx.appointmentId) || [];
      existing.push(tx);
      byAppointment.set(tx.appointmentId, existing);
    }

    let reversedCount = 0;
    let rebookedCount = 0;
    let totalOldAmountCents = 0;
    let totalNewAmountCents = 0;
    const errors: Array<{ appointmentId: number; error: string }> = [];

    for (const [appointmentId] of byAppointment) {
      try {
        const txResult = await db.transaction(async (tx) => {
          await (tx as unknown as typeof db).execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(customerId))})`);

          const allConsumptions = await tx.select()
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, customerId),
              eq(budgetTransactions.appointmentId, appointmentId),
              eq(budgetTransactions.transactionType, "consumption"),
            ));

          const allReversals = await tx.select()
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, customerId),
              eq(budgetTransactions.appointmentId, appointmentId),
              eq(budgetTransactions.transactionType, "reversal"),
            ));

          const alreadyReversedIds = new Set(
            allReversals
              .map(r => r.notes?.match(/Storno von Transaktion #(\d+)/)?.[1])
              .filter(Boolean)
              .map(Number)
          );

          const unreversedConsumptions = allConsumptions.filter(c => !alreadyReversedIds.has(c.id));

          let localReversedCount = 0;
          let localOldAmountCents = 0;

          for (const oldTx of unreversedConsumptions) {
            await tx.insert(budgetTransactions).values({
              customerId,
              budgetType: oldTx.budgetType,
              transactionDate: oldTx.transactionDate,
              transactionType: "reversal",
              amountCents: -oldTx.amountCents,
              appointmentId: oldTx.appointmentId,
              allocationId: oldTx.allocationId,
              notes: `Storno von Transaktion #${oldTx.id} (Umbuchung)`,
              createdByUserId: userId,
            });
            localReversedCount++;
            localOldAmountCents += Math.abs(oldTx.amountCents);
          }

          const [appt] = await tx.select({
            customerId: appointments.customerId,
            date: appointments.date,
            travelKilometers: appointments.travelKilometers,
            customerKilometers: appointments.customerKilometers,
          }).from(appointments).where(eq(appointments.id, appointmentId)).limit(1);

          if (!appt) throw new Error(`Termin #${appointmentId} nicht gefunden`);

          const apptServices = await tx.select({
            serviceId: appointmentServices.serviceId,
            actualDurationMinutes: appointmentServices.actualDurationMinutes,
          }).from(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));

          const allServices = await tx.select({
            id: services.id,
            code: services.code,
          }).from(services);

          const serviceCodeMap = new Map(allServices.map(s => [s.id, s.code]));

          let hwMinutes = 0;
          let abMinutes = 0;
          for (const as of apptServices) {
            const code = serviceCodeMap.get(as.serviceId);
            const mins = as.actualDurationMinutes ?? 0;
            if (code === "hauswirtschaft") hwMinutes += mins;
            else if (code === "alltagsbegleitung") abMinutes += mins;
          }

          const travelKm = appt.travelKilometers ?? 0;
          const customerKm = appt.customerKilometers ?? 0;
          const txDate = typeof appt.date === "string" ? appt.date : String(appt.date);

          const costs = await this.calculateAppointmentCost({
            customerId,
            hauswirtschaftMinutes: hwMinutes,
            alltagsbegleitungMinutes: abMinutes,
            travelKilometers: travelKm,
            customerKilometers: customerKm,
            date: txDate,
          });

          let localNewAmountCents = 0;
          if (costs.totalCents > 0) {
            const cascadeResult = await this.createCascadeConsumption({
              customerId,
              appointmentId,
              transactionDate: txDate,
              totalAmountCents: costs.totalCents,
              hauswirtschaftMinutes: hwMinutes,
              hauswirtschaftCents: costs.hauswirtschaftCents,
              alltagsbegleitungMinutes: abMinutes,
              alltagsbegleitungCents: costs.alltagsbegleitungCents,
              travelKilometers: Math.round(travelKm * 10),
              travelCents: costs.travelCents,
              customerKilometers: Math.round(customerKm * 10),
              customerKilometersCents: costs.customerKilometersCents,
              userId,
              skipExistingCheck: true,
            }, tx);

            if (cascadeResult.outstandingCents > 0) {
              throw new Error(
                `Ziel-Budget reicht nicht aus. ${(cascadeResult.outstandingCents / 100).toFixed(2)} € konnten nicht gebucht werden.`
              );
            }

            localNewAmountCents = cascadeResult.totalConsumedCents;
          }

          return { localReversedCount, localOldAmountCents, localNewAmountCents };
        });

        reversedCount += txResult.localReversedCount;
        totalOldAmountCents += txResult.localOldAmountCents;
        totalNewAmountCents += txResult.localNewAmountCents;
        rebookedCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ appointmentId, error: msg });
      }
    }

    return { reversedCount, rebookedCount, totalOldAmountCents, totalNewAmountCents, errors };
  }
}

export const budgetLedgerStorage = new DatabaseBudgetLedgerStorage();
