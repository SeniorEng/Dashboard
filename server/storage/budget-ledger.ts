import { 
  budgetAllocations, 
  budgetTransactions, 
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  customerBudgets,
  customerPricingHistory,
  customers,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type BudgetTransaction,
  type InsertBudgetTransaction,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerBudgetTypeSetting,
  type CustomerPricing,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
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
  getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number }): Promise<BudgetTransaction[]>;
  getTransactionByAppointmentId(appointmentId: number): Promise<BudgetTransaction | undefined>;
  reverseBudgetTransaction(transactionId: number, userId?: number): Promise<BudgetTransaction | undefined>;
  
  ensureMonthlyAllocations(customerId: number): Promise<BudgetAllocation[]>;
  getBudgetSummary(customerId: number): Promise<BudgetSummary>;
  getMonthlyBudgetAmountCents(customerId: number): Promise<number>;
  
  getBudgetPreferences(customerId: number): Promise<CustomerBudgetPreferences | undefined>;
  upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number): Promise<CustomerBudgetPreferences>;
  
  getCurrentPricing(customerId: number, date?: string): Promise<CustomerPricing | undefined>;
  
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
  }): Promise<BudgetTransaction>;
  
  getCustomerBudgetAmounts(customerId: number): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }>;
  
  ensureAllocations45a(customerId: number): Promise<BudgetAllocation[]>;
  ensureAllocations39_42a(customerId: number): Promise<BudgetAllocation[]>;
  getBudgetSummary45a(customerId: number): Promise<Budget45aSummary>;
  getBudgetSummary39_42a(customerId: number): Promise<Budget39_42aSummary>;
  getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries>;
  
  getBudgetTypeSettings(customerId: number): Promise<CustomerBudgetTypeSetting[]>;
  upsertBudgetTypeSettings(customerId: number, settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; initialBalanceCents?: number | null; initialBalanceMonth?: string | null }>): Promise<CustomerBudgetTypeSetting[]>;
  upsertInitialBalanceAllocation(params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string }, userId?: number): Promise<void>;
  getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]>;
  
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
          eq(budgetAllocations.year, year)
        ))
        .orderBy(asc(budgetAllocations.month), asc(budgetAllocations.validFrom));
    }
    return await db.select()
      .from(budgetAllocations)
      .where(eq(budgetAllocations.customerId, customerId))
      .orderBy(desc(budgetAllocations.year), asc(budgetAllocations.month));
  }

  async createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction> {
    const result = await db.insert(budgetTransactions).values({
      ...transaction,
      createdByUserId: userId,
    }).returning();
    return result[0];
  }

  async getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number }): Promise<BudgetTransaction[]> {
    const conditions = [eq(budgetTransactions.customerId, customerId)];
    
    if (options?.year) {
      const yearStart = `${options.year}-01-01`;
      const yearEnd = `${options.year}-12-31`;
      conditions.push(gte(budgetTransactions.transactionDate, yearStart));
      conditions.push(lte(budgetTransactions.transactionDate, yearEnd));
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

  async reverseBudgetTransaction(transactionId: number, userId?: number): Promise<BudgetTransaction | undefined> {
    const original = await db.select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.id, transactionId))
      .limit(1);
    
    if (!original[0]) return undefined;
    
    const reversal = await db.insert(budgetTransactions).values({
      customerId: original[0].customerId,
      budgetType: original[0].budgetType,
      transactionDate: todayISO(),
      transactionType: "reversal",
      amountCents: -original[0].amountCents,
      appointmentId: original[0].appointmentId,
      notes: `Storno von Transaktion #${transactionId}`,
      createdByUserId: userId,
    }).returning();
    
    return reversal[0];
  }

  async getMonthlyBudgetAmountCents(customerId: number, _tx?: DbClient): Promise<number> {
    const d = _tx ?? db;
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

  async ensureMonthlyAllocations(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const preferences = await this.getBudgetPreferences(customerId, _tx);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;

    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.source, "monthly_auto")
      ));

    const existingSet = new Set(
      existingAllocations.map(a => `${a.year}-${a.month}`)
    );

    const monthlyAmount = await this.getMonthlyBudgetAmountCents(customerId, _tx);
    const created: BudgetAllocation[] = [];

    let year = startDate.getFullYear();
    let month = startDate.getMonth() + 1;

    while (year < currentYear || (year === currentYear && month <= currentMonth)) {
      const key = `${year}-${month}`;

      if (!existingSet.has(key)) {
        const validFrom = `${year}-${String(month).padStart(2, '0')}-01`;
        const result = await d.insert(budgetAllocations).values({
          customerId,
          budgetType: "entlastungsbetrag_45b",
          year,
          month,
          amountCents: monthlyAmount,
          source: "monthly_auto",
          validFrom,
          expiresAt: null,
          notes: `Automatische Zuweisung ${String(month).padStart(2, '0')}/${year}`,
        }).onConflictDoNothing().returning();
        if (result[0]) {
          created.push(result[0]);
        }
      }

      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }

    return created;
  }

  async getBudgetSummary(customerId: number): Promise<BudgetSummary> {
    await this.ensureMonthlyAllocations(customerId);
    await this.processExpiredCarryover(customerId);

    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;
    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;

    const allocBaseWhere = and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      lte(budgetAllocations.validFrom, today),
      or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
    );

    const [allocResult, txResult, currentYearResult, carryoverResult, currentMonthResult, preferences] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(allocBaseWhere),

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
        allocBaseWhere,
        eq(budgetAllocations.year, currentYear),
        sql`${budgetAllocations.source} != 'carryover'`
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
        expiresAt: sql<string | null>`MIN(${budgetAllocations.expiresAt})`,
      }).from(budgetAllocations).where(and(
        allocBaseWhere,
        eq(budgetAllocations.source, "carryover"),
        sql`${budgetAllocations.expiresAt} IS NOT NULL`
      )),

      db.select({
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, currentMonthStart)
      )),

      this.getBudgetPreferences(customerId),
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
    const currentMonthUsedCents = Number(currentMonthResult[0]?.total ?? 0);

    return {
      customerId,
      totalAllocatedCents,
      totalUsedCents: netUsedCents,
      availableCents: totalAllocatedCents - netUsedCents,
      carryoverCents,
      carryoverExpiresAt,
      currentYearAllocatedCents,
      monthlyLimitCents: preferences?.monthlyLimitCents ?? null,
      currentMonthUsedCents,
    };
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
    settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; initialBalanceCents?: number | null; initialBalanceMonth?: string | null }>
  ): Promise<CustomerBudgetTypeSetting[]> {
    const results: CustomerBudgetTypeSetting[] = [];
    for (const s of settings) {
      const result = await db.insert(customerBudgetTypeSettings)
        .values({
          customerId,
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents ?? null,
          yearlyLimitCents: s.yearlyLimitCents ?? null,
          initialBalanceCents: s.initialBalanceCents ?? null,
          initialBalanceMonth: s.initialBalanceMonth ?? null,
        })
        .onConflictDoUpdate({
          target: [customerBudgetTypeSettings.customerId, customerBudgetTypeSettings.budgetType],
          set: {
            enabled: sql`EXCLUDED.enabled`,
            priority: sql`EXCLUDED.priority`,
            monthlyLimitCents: sql`EXCLUDED.monthly_limit_cents`,
            yearlyLimitCents: sql`EXCLUDED.yearly_limit_cents`,
            initialBalanceCents: sql`EXCLUDED.initial_balance_cents`,
            initialBalanceMonth: sql`EXCLUDED.initial_balance_month`,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      results.push(result[0]);
    }
    return results;
  }

  async upsertInitialBalanceAllocation(
    params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string },
    userId?: number
  ): Promise<void> {
    const existing = await db.select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, params.customerId),
        eq(budgetAllocations.budgetType, params.budgetType),
        eq(budgetAllocations.source, "initial_balance"),
        eq(budgetAllocations.year, params.year),
        eq(budgetAllocations.month, params.month),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(budgetAllocations)
        .set({
          amountCents: params.amountCents,
          validFrom: params.validFrom,
          expiresAt: params.expiresAt,
          notes: params.notes ?? null,
        })
        .where(eq(budgetAllocations.id, existing[0].id));
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
        eq(budgetAllocations.source, "initial_balance"),
      ))
      .orderBy(desc(budgetAllocations.validFrom));
  }

  async getCurrentPricing(customerId: number, date?: string): Promise<CustomerPricing | undefined> {
    const targetDate = date || todayISO();
    
    const result = await db.select()
      .from(customerPricingHistory)
      .where(and(
        eq(customerPricingHistory.customerId, customerId),
        lte(customerPricingHistory.validFrom, targetDate),
        or(
          isNull(customerPricingHistory.validTo),
          gte(customerPricingHistory.validTo, targetDate)
        )
      ))
      .orderBy(desc(customerPricingHistory.validFrom))
      .limit(1);
    
    return result[0];
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

    const hauswirtschaftRateCents = (hwService?.isBillable !== false) ? (hwService?.defaultPriceCents || 0) : 0;
    const alltagsbegleitungRateCents = (abService?.isBillable !== false) ? (abService?.defaultPriceCents || 0) : 0;
    const travelKmRateCents = (travelKmService?.isBillable !== false) ? (travelKmService?.defaultPriceCents || 0) : 0;
    const customerKmRateCents = (customerKmService?.isBillable !== false) ? (customerKmService?.defaultPriceCents || 0) : 0;

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

  async createConsumptionTransaction(params: {
    customerId: number;
    appointmentId: number;
    transactionDate: string;
    hauswirtschaftMinutes: number;
    alltagsbegleitungMinutes: number;
    travelKilometers: number;
    customerKilometers: number;
    userId?: number;
  }): Promise<BudgetTransaction> {
    const costs = await this.calculateAppointmentCost({
      customerId: params.customerId,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      travelKilometers: params.travelKilometers,
      customerKilometers: params.customerKilometers,
      date: params.transactionDate,
    });

    const [customer] = await db.select({ acceptsPrivatePayment: customers.acceptsPrivatePayment })
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
      });
      return cascadeResult.transactions[0];
    }

    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(params.customerId))})`);

      if (!acceptsPrivatePayment) {
        const summaries = await this.getAllBudgetSummaries(params.customerId);
        const typeSettings = await this.getBudgetTypeSettings(params.customerId);

        let effective45b = summaries.entlastungsbetrag45b.availableCents;
        let effective45a = summaries.umwandlung45a.currentMonthAvailableCents;
        let effective39_42a = summaries.ersatzpflege39_42a.currentYearAvailableCents;

        if (typeSettings.length > 0) {
          const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));

          const s45b = settingsMap.get("entlastungsbetrag_45b");
          if (s45b && !s45b.enabled) effective45b = 0;
          if (s45b?.monthlyLimitCents !== null && s45b?.monthlyLimitCents !== undefined) {
            const carryoverAvailable = await this.getAvailableCarryoverCents(params.customerId, params.transactionDate);
            const effectiveLimit = s45b.monthlyLimitCents + carryoverAvailable;
            const monthlyRemaining45b = Math.max(0, effectiveLimit - summaries.entlastungsbetrag45b.currentMonthUsedCents);
            effective45b = Math.min(effective45b, monthlyRemaining45b);
          }

          const s45a = settingsMap.get("umwandlung_45a");
          if (s45a && !s45a.enabled) effective45a = 0;
          if (s45a?.monthlyLimitCents !== null && s45a?.monthlyLimitCents !== undefined) {
            const monthlyRemaining45a = Math.max(0, s45a.monthlyLimitCents - summaries.umwandlung45a.currentMonthUsedCents);
            effective45a = Math.min(effective45a, monthlyRemaining45a);
          }

          const s39 = settingsMap.get("ersatzpflege_39_42a");
          if (s39 && !s39.enabled) effective39_42a = 0;
          if (s39?.yearlyLimitCents !== null && s39?.yearlyLimitCents !== undefined) {
            const yearlyRemaining = Math.max(0, s39.yearlyLimitCents - summaries.ersatzpflege39_42a.currentYearUsedCents);
            effective39_42a = Math.min(effective39_42a, yearlyRemaining);
          }
        } else {
          const preferences = await this.getBudgetPreferences(params.customerId);
          if (preferences?.monthlyLimitCents !== null && preferences?.monthlyLimitCents !== undefined) {
            const carryoverAvailable = await this.getAvailableCarryoverCents(params.customerId, params.transactionDate);
            const effectiveLimit = preferences.monthlyLimitCents + carryoverAvailable;
            const monthlyRemaining45b = Math.max(0, effectiveLimit - summaries.entlastungsbetrag45b.currentMonthUsedCents);
            effective45b = Math.min(effective45b, monthlyRemaining45b);
          }
        }

        const totalAvailable = effective45a + effective45b + effective39_42a;

        if (costs.totalCents > totalAvailable) {
          throw new Error(
            `Budget reicht nicht aus. Kosten: ${(costs.totalCents / 100).toFixed(2)} €, ` +
            `verfügbar: ${(totalAvailable / 100).toFixed(2)} €. ` +
            `Kunde akzeptiert keine Privatzahlung.`
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
      });

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
        throw new Error(
          `Budget reicht nicht aus. Fehlbetrag: ${(cascadeResult.outstandingCents / 100).toFixed(2)} €. ` +
          `Kunde akzeptiert keine Privatzahlung.`
        );
      }

      return cascadeResult.transactions[0];
    });
  }

  async getCustomerBudgetAmounts(customerId: number, _tx?: DbClient): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }> {
    const d = _tx ?? db;
    const result = await d.select().from(customerBudgets).where(and(eq(customerBudgets.customerId, customerId), isNull(customerBudgets.validTo))).limit(1);
    if (result[0]) {
      return {
        pflegesachleistungen36: result[0].pflegesachleistungen36 ?? 0,
        verhinderungspflege39: result[0].verhinderungspflege39 ?? 0,
      };
    }
    return { pflegesachleistungen36: 0, verhinderungspflege39: 0 };
  }

  async ensureAllocations45a(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const preferences = await this.getBudgetPreferences(customerId, _tx);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const amounts = await this.getCustomerBudgetAmounts(customerId, _tx);
    if (!amounts.pflegesachleistungen36 || amounts.pflegesachleistungen36 === 0) {
      return [];
    }

    const monthlyAmount = amounts.pflegesachleistungen36;
    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;

    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "umwandlung_45a"),
        eq(budgetAllocations.source, "monthly_auto")
      ));

    const existingSet = new Set(
      existingAllocations.map(a => `${a.year}-${a.month}`)
    );

    const created: BudgetAllocation[] = [];

    let year = startDate.getFullYear();
    let month = startDate.getMonth() + 1;

    while (year < currentYear || (year === currentYear && month <= currentMonth)) {
      const key = `${year}-${month}`;

      if (!existingSet.has(key)) {
        const validFrom = `${year}-${String(month).padStart(2, '0')}-01`;
        const expires = lastDayOfMonth(year, month);
        const result = await d.insert(budgetAllocations).values({
          customerId,
          budgetType: "umwandlung_45a",
          year,
          month,
          amountCents: monthlyAmount,
          source: "monthly_auto",
          validFrom,
          expiresAt: expires,
          notes: `Automatische Zuweisung §45a ${String(month).padStart(2, '0')}/${year}`,
        }).onConflictDoNothing().returning();
        if (result[0]) {
          created.push(result[0]);
        }
      }

      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }

    return created;
  }

  async ensureAllocations39_42a(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
    const d = _tx ?? db;
    const preferences = await this.getBudgetPreferences(customerId, _tx);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const amounts = await this.getCustomerBudgetAmounts(customerId, _tx);
    if (!amounts.verhinderungspflege39 || amounts.verhinderungspflege39 === 0) {
      return [];
    }

    const yearlyAmount = amounts.verhinderungspflege39;
    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const startYear = startDate.getFullYear();

    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
        eq(budgetAllocations.source, "yearly_auto")
      ));

    const existingYears = new Set(
      existingAllocations.map(a => a.year)
    );

    const created: BudgetAllocation[] = [];

    for (let year = startYear; year <= currentYear; year++) {
      if (existingYears.has(year)) {
        continue;
      }

      const validFrom = (year === startYear)
        ? preferences.budgetStartDate
        : `${year}-01-01`;
      const expiresAt = `${year}-12-31`;

      const result = await d.insert(budgetAllocations).values({
        customerId,
        budgetType: "ersatzpflege_39_42a",
        year,
        month: null,
        amountCents: yearlyAmount,
        source: "yearly_auto",
        validFrom,
        expiresAt,
        notes: `Automatische Zuweisung §39/§42a ${year}`,
      }).onConflictDoNothing().returning();
      if (result[0]) {
        created.push(result[0]);
      }
    }

    return created;
  }

  async getBudgetSummary45a(customerId: number): Promise<Budget45aSummary> {
    await this.ensureAllocations45a(customerId);

    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;
    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const currentMonthLastDay = lastDayOfMonth(currentYear, currentMonth);

    const [allocResult, txResult, amounts] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "umwandlung_45a"),
        eq(budgetAllocations.year, currentYear),
        eq(budgetAllocations.month, currentMonth),
        lte(budgetAllocations.validFrom, today),
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

      this.getCustomerBudgetAmounts(customerId),
    ]);

    const currentMonthAllocatedCents = Number(allocResult[0]?.total ?? 0);
    const currentMonthUsedCents = Number(txResult[0]?.total ?? 0);

    return {
      customerId,
      monthlyBudgetCents: amounts.pflegesachleistungen36,
      currentMonthAllocatedCents,
      currentMonthUsedCents,
      currentMonthAvailableCents: currentMonthAllocatedCents - currentMonthUsedCents,
    };
  }

  async getBudgetSummary39_42a(customerId: number): Promise<Budget39_42aSummary> {
    await this.ensureAllocations39_42a(customerId);

    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const currentYear = todayDate.getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    const [allocResult, txResult, amounts] = await Promise.all([
      db.select({
        total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
      }).from(budgetAllocations).where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
        eq(budgetAllocations.year, currentYear),
        lte(budgetAllocations.validFrom, today),
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

      this.getCustomerBudgetAmounts(customerId),
    ]);

    const currentYearAllocatedCents = Number(allocResult[0]?.total ?? 0);
    const currentYearUsedCents = Number(txResult[0]?.total ?? 0);

    return {
      customerId,
      yearlyBudgetCents: amounts.verhinderungspflege39,
      currentYearAllocatedCents,
      currentYearUsedCents,
      currentYearAvailableCents: currentYearAllocatedCents - currentYearUsedCents,
    };
  }

  async getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries> {
    const [entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a] = await Promise.all([
      this.getBudgetSummary(customerId),
      this.getBudgetSummary45a(customerId),
      this.getBudgetSummary39_42a(customerId),
    ]);
    return { entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a };
  }

  async getAvailableCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
    const d = _tx ?? db;
    const carryoverAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
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

    const consumedMap = new Map(consumed.map(c => [c.allocationId, Number(c.total)]));

    let totalAvailable = 0;
    for (const alloc of carryoverAllocations) {
      const used = consumedMap.get(alloc.id) ?? 0;
      totalAvailable += Math.max(0, alloc.amountCents - used);
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
          eq(budgetTransactions.transactionType, "consumption")
        ));

      const consumed = Number(consumedFromAllocation[0]?.total ?? 0);
      const remaining = allocation.amountCents - consumed;

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
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ))
      .orderBy(asc(budgetAllocations.validFrom), asc(budgetAllocations.id));

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

    const consumedMap = new Map(consumptionByAllocation.map(c => [c.allocationId, Number(c.total)]));

    const allocationConsumption = allocations.map(a => {
      const consumed = consumedMap.get(a.id) ?? 0;
      return { allocation: a, consumed, available: Math.max(0, a.amountCents - consumed) };
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

      if (isFirstTransaction && params) {
        txData.hauswirtschaftMinutes = params.hauswirtschaftMinutes ?? null;
        txData.hauswirtschaftCents = params.hauswirtschaftCents ?? null;
        txData.alltagsbegleitungMinutes = params.alltagsbegleitungMinutes ?? null;
        txData.alltagsbegleitungCents = params.alltagsbegleitungCents ?? null;
        txData.travelKilometers = params.travelKilometers ?? null;
        txData.travelCents = params.travelCents ?? null;
        txData.customerKilometers = params.customerKilometers ?? null;
        txData.customerKilometersCents = params.customerKilometersCents ?? null;
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
  }): Promise<CascadeResult> {
    return await db.transaction(async (tx: DbClient) => {
      const existingTransaction = await this.getTransactionByAppointmentId(params.appointmentId, tx);
      if (existingTransaction) {
        throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
      }

      await this.ensureMonthlyAllocations(params.customerId, tx);
      await this.ensureAllocations45a(params.customerId, tx);
      await this.ensureAllocations39_42a(params.customerId, tx);
      await this.processExpiredCarryover(params.customerId, tx);

      const typeSettings = await this.getBudgetTypeSettings(params.customerId, tx);

      const defaultPriority: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null }> = [
        { budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: null },
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null },
      ];

      let priorityOrder: Array<{ budgetType: string; enabled: boolean; monthlyLimitCents: number | null; yearlyLimitCents: number | null }>;

      if (typeSettings.length > 0) {
        const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));
        priorityOrder = defaultPriority.map(d => {
          const s = settingsMap.get(d.budgetType);
          return {
            budgetType: d.budgetType,
            enabled: s ? s.enabled : d.enabled,
            monthlyLimitCents: s ? s.monthlyLimitCents : d.monthlyLimitCents,
            yearlyLimitCents: s?.yearlyLimitCents ?? null,
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

        let maxConsumable = remaining;

        const isMonthlyBudget = pot.budgetType === "entlastungsbetrag_45b" || pot.budgetType === "umwandlung_45a";
        if (isMonthlyBudget && pot.monthlyLimitCents !== null) {
          const txDate = parseLocalDate(params.transactionDate);
          const txYear = txDate.getFullYear();
          const txMonth = txDate.getMonth() + 1;
          const currentMonthStart = `${txYear}-${String(txMonth).padStart(2, '0')}-01`;

          const monthTransactions = await tx.select({
            total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
          })
            .from(budgetTransactions)
            .where(and(
              eq(budgetTransactions.customerId, params.customerId),
              eq(budgetTransactions.budgetType, pot.budgetType),
              eq(budgetTransactions.transactionType, "consumption"),
              gte(budgetTransactions.transactionDate, currentMonthStart)
            ));

          const alreadyUsedThisMonth = Number(monthTransactions[0]?.total ?? 0);

          let effectiveMonthlyLimit = pot.monthlyLimitCents;
          if (pot.budgetType === "entlastungsbetrag_45b") {
            const carryoverAvailable = await this.getAvailableCarryoverCents(params.customerId, params.transactionDate, tx);
            effectiveMonthlyLimit = pot.monthlyLimitCents + carryoverAvailable;
          }

          const monthlyRemaining = Math.max(0, effectiveMonthlyLimit - alreadyUsedThisMonth);
          maxConsumable = Math.min(remaining, monthlyRemaining);
        }

        if (pot.budgetType === "ersatzpflege_39_42a" && pot.yearlyLimitCents !== null) {
          const txDate = parseLocalDate(params.transactionDate);
          const txYear = txDate.getFullYear();
          const yearStart = `${txYear}-01-01`;
          const yearEnd = `${txYear}-12-31`;

          const yearTransactions = await tx.select({
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

          const alreadyUsedThisYear = Number(yearTransactions[0]?.total ?? 0);
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
    });
  }
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const budgetLedgerStorage = new DatabaseBudgetLedgerStorage();
