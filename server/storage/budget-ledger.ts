import { 
  budgetAllocations, 
  budgetTransactions, 
  customerBudgetPreferences,
  customerBudgets,
  customerPricingHistory,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type BudgetTransaction,
  type InsertBudgetTransaction,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerPricing,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { db } from "../lib/db";

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

  async getTransactionByAppointmentId(appointmentId: number): Promise<BudgetTransaction | undefined> {
    const result = await db.select()
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

  async getMonthlyBudgetAmountCents(customerId: number): Promise<number> {
    const customerBudget = await db.select()
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

  async ensureMonthlyAllocations(customerId: number): Promise<BudgetAllocation[]> {
    const preferences = await this.getBudgetPreferences(customerId);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;

    const existingAllocations = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.source, "monthly_auto")
      ));

    const existingSet = new Set(
      existingAllocations.map(a => `${a.year}-${a.month}`)
    );

    const monthlyAmount = await this.getMonthlyBudgetAmountCents(customerId);
    const created: BudgetAllocation[] = [];

    let year = startDate.getFullYear();
    let month = startDate.getMonth() + 1;

    while (year < currentYear || (year === currentYear && month <= currentMonth)) {
      const key = `${year}-${month}`;

      if (!existingSet.has(key)) {
        const validFrom = `${year}-${String(month).padStart(2, '0')}-01`;
        const result = await db.insert(budgetAllocations).values({
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

    const allocations = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ));

    const transactions = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b")
      ));

    const totalAllocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);
    
    const consumptionCents = transactions
      .filter(t => t.transactionType === "consumption")
      .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    const writeOffCents = transactions
      .filter(t => t.transactionType === "write_off")
      .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    const manualAdjustmentCents = transactions
      .filter(t => t.transactionType === "manual_adjustment")
      .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    const reversalsCents = transactions
      .filter(t => t.transactionType === "reversal")
      .reduce((sum, t) => sum + t.amountCents, 0);
    
    const netUsedCents = consumptionCents + writeOffCents + manualAdjustmentCents + reversalsCents;
    
    const currentYearAllocations = allocations.filter(a => a.year === currentYear && a.source !== "carryover");
    const currentYearAllocatedCents = currentYearAllocations.reduce((sum, a) => sum + a.amountCents, 0);
    
    const carryoverAllocations = allocations.filter(a => 
      a.source === "carryover" && 
      a.expiresAt !== null
    );
    const carryoverCents = carryoverAllocations.reduce((sum, a) => sum + a.amountCents, 0);
    const carryoverExpiresAt = carryoverAllocations.length > 0 
      ? carryoverAllocations[0].expiresAt 
      : null;

    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const currentMonthTransactions = transactions.filter(t => 
      t.transactionDate >= currentMonthStart && 
      t.transactionType === "consumption"
    );
    const currentMonthUsedCents = currentMonthTransactions.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

    const preferences = await this.getBudgetPreferences(customerId);

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

  async getBudgetPreferences(customerId: number): Promise<CustomerBudgetPreferences | undefined> {
    const result = await db.select()
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
    const pricing = await this.getCurrentPricing(params.customerId, params.date);
    
    if (!pricing) {
      throw new Error(`Keine Preisvereinbarung für Kunde ${params.customerId} zum Datum ${params.date} gefunden`);
    }

    const hauswirtschaftRateCents = pricing.hauswirtschaftRateCents || 0;
    const alltagsbegleitungRateCents = pricing.alltagsbegleitungRateCents || 0;
    const kilometerRateCents = pricing.kilometerRateCents || 0;

    const hauswirtschaftCents = Math.round((params.hauswirtschaftMinutes / 60) * hauswirtschaftRateCents);
    const alltagsbegleitungCents = Math.round((params.alltagsbegleitungMinutes / 60) * alltagsbegleitungRateCents);
    const travelCents = Math.round(params.travelKilometers * kilometerRateCents);
    const customerKilometersCents = Math.round(params.customerKilometers * kilometerRateCents);

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

    if (cascadeResult.transactions.length === 0) {
      throw new Error("Kein Budget verfügbar für diese Buchung");
    }

    return cascadeResult.transactions[0];
  }

  async getCustomerBudgetAmounts(customerId: number): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }> {
    const result = await db.select().from(customerBudgets).where(and(eq(customerBudgets.customerId, customerId), isNull(customerBudgets.validTo))).limit(1);
    if (result[0]) {
      return {
        pflegesachleistungen36: result[0].pflegesachleistungen36 ?? 0,
        verhinderungspflege39: result[0].verhinderungspflege39 ?? 0,
      };
    }
    return { pflegesachleistungen36: 0, verhinderungspflege39: 0 };
  }

  async ensureAllocations45a(customerId: number): Promise<BudgetAllocation[]> {
    const preferences = await this.getBudgetPreferences(customerId);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const amounts = await this.getCustomerBudgetAmounts(customerId);
    if (!amounts.pflegesachleistungen36 || amounts.pflegesachleistungen36 === 0) {
      return [];
    }

    const monthlyAmount = amounts.pflegesachleistungen36;
    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const currentMonth = todayDate.getMonth() + 1;

    const existingAllocations = await db.select()
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
        const result = await db.insert(budgetAllocations).values({
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

  async ensureAllocations39_42a(customerId: number): Promise<BudgetAllocation[]> {
    const preferences = await this.getBudgetPreferences(customerId);
    if (!preferences?.budgetStartDate) {
      return [];
    }

    const amounts = await this.getCustomerBudgetAmounts(customerId);
    if (!amounts.verhinderungspflege39 || amounts.verhinderungspflege39 === 0) {
      return [];
    }

    const yearlyAmount = amounts.verhinderungspflege39;
    const startDate = parseLocalDate(preferences.budgetStartDate);
    const todayDate = parseLocalDate(todayISO());
    const currentYear = todayDate.getFullYear();
    const startYear = startDate.getFullYear();

    const existingAllocations = await db.select()
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

      const result = await db.insert(budgetAllocations).values({
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

    const allocations = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "umwandlung_45a"),
        eq(budgetAllocations.year, currentYear),
        eq(budgetAllocations.month, currentMonth),
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ));

    const currentMonthAllocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);

    const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextMonthYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    const currentMonthEnd = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const transactions = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "umwandlung_45a"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, currentMonthStart),
        lte(budgetTransactions.transactionDate, lastDayOfMonth(currentYear, currentMonth))
      ));

    const currentMonthUsedCents = transactions.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

    const amounts = await this.getCustomerBudgetAmounts(customerId);

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

    const allocations = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
        eq(budgetAllocations.year, currentYear),
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ));

    const currentYearAllocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);

    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    const transactions = await db.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
        eq(budgetTransactions.transactionType, "consumption"),
        gte(budgetTransactions.transactionDate, yearStart),
        lte(budgetTransactions.transactionDate, yearEnd)
      ));

    const currentYearUsedCents = transactions.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

    const amounts = await this.getCustomerBudgetAmounts(customerId);

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

  async processExpiredCarryover(customerId: number): Promise<BudgetTransaction[]> {
    const today = todayISO();

    const expiredAllocations = await db.select()
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

    const existingWriteOffs = await db.select()
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

      const consumedFromAllocation = await db.select({
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

      const writeOff = await db.insert(budgetTransactions).values({
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
    }
  ): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }> {
    const today = transactionDate;

    const allocations = await db.select()
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
      ? await db.select({
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

      const result = await db.insert(budgetTransactions).values(txData).returning();
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
    const existingTransaction = await this.getTransactionByAppointmentId(params.appointmentId);
    if (existingTransaction) {
      throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
    }

    await this.ensureMonthlyAllocations(params.customerId);
    await this.ensureAllocations45a(params.customerId);
    await this.processExpiredCarryover(params.customerId);

    const preferences = await this.getBudgetPreferences(params.customerId);
    const monthlyLimit45b = preferences?.monthlyLimitCents ?? null;

    const priorityOrder: string[] = ["umwandlung_45a", "entlastungsbetrag_45b"];

    let remaining = params.totalAmountCents;
    const allTransactions: BudgetTransaction[] = [];
    const breakdown: Array<{ budgetType: string; consumedCents: number }> = [];

    for (const budgetType of priorityOrder) {
      if (remaining <= 0) break;

      let maxConsumable = remaining;

      if (budgetType === "entlastungsbetrag_45b" && monthlyLimit45b !== null) {
        const txDate = parseLocalDate(params.transactionDate);
        const txYear = txDate.getFullYear();
        const txMonth = txDate.getMonth() + 1;
        const currentMonthStart = `${txYear}-${String(txMonth).padStart(2, '0')}-01`;

        const monthTransactions = await db.select({
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, params.customerId),
            eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
            eq(budgetTransactions.transactionType, "consumption"),
            gte(budgetTransactions.transactionDate, currentMonthStart)
          ));

        const alreadyUsedThisMonth = Number(monthTransactions[0]?.total ?? 0);
        const monthlyRemaining = Math.max(0, monthlyLimit45b - alreadyUsedThisMonth);
        maxConsumable = Math.min(remaining, monthlyRemaining);
      }

      if (maxConsumable <= 0) {
        breakdown.push({ budgetType, consumedCents: 0 });
        continue;
      }

      const isFirstPot = allTransactions.length === 0;
      const fifoResult = await this.consumeFifo(
        params.customerId,
        budgetType,
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
        }
      );

      allTransactions.push(...fifoResult.transactions);
      remaining -= fifoResult.consumedCents;
      breakdown.push({ budgetType, consumedCents: fifoResult.consumedCents });
    }

    return {
      transactions: allTransactions,
      totalConsumedCents: params.totalAmountCents - remaining,
      outstandingCents: remaining,
      breakdown,
    };
  }
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const budgetLedgerStorage = new DatabaseBudgetLedgerStorage();
