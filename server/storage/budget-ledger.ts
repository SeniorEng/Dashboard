import { 
  budgetAllocations, 
  budgetTransactions, 
  customerBudgetPreferences,
  customerPricingHistory,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type BudgetTransaction,
  type InsertBudgetTransaction,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerPricing,
} from "@shared/schema";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, sql, lte, gte, isNull, or, desc, asc } from "drizzle-orm";

const sqlClient = neon(process.env.DATABASE_URL!);
const db = drizzle(sqlClient);

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

export interface BudgetLedgerStorage {
  createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number): Promise<BudgetAllocation>;
  getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]>;
  
  createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction>;
  getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number }): Promise<BudgetTransaction[]>;
  getTransactionByAppointmentId(appointmentId: number): Promise<BudgetTransaction | undefined>;
  reverseBudgetTransaction(transactionId: number, userId?: number): Promise<BudgetTransaction | undefined>;
  
  getBudgetSummary(customerId: number): Promise<BudgetSummary>;
  
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
    let query = db.select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId))
      .orderBy(desc(budgetTransactions.transactionDate), desc(budgetTransactions.createdAt));

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    const results = await query;
    
    if (options?.year) {
      return results.filter(t => t.transactionDate.startsWith(String(options.year)));
    }
    
    return results;
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
      transactionDate: new Date().toISOString().slice(0, 10),
      transactionType: "reversal",
      amountCents: -original[0].amountCents,
      appointmentId: original[0].appointmentId,
      notes: `Storno von Transaktion #${transactionId}`,
      createdByUserId: userId,
    }).returning();
    
    return reversal[0];
  }

  async getBudgetSummary(customerId: number): Promise<BudgetSummary> {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const today = now.toISOString().slice(0, 10);
    const carryoverDeadline = `${currentYear}-06-30`;

    const allocations = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        lte(budgetAllocations.validFrom, today),
        or(
          isNull(budgetAllocations.expiresAt),
          gte(budgetAllocations.expiresAt, today)
        )
      ));

    const transactions = await db.select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));

    const totalAllocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);
    const totalUsedCents = transactions
      .filter(t => t.transactionType !== "reversal")
      .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    const reversalsCents = transactions
      .filter(t => t.transactionType === "reversal")
      .reduce((sum, t) => sum + t.amountCents, 0);
    
    const netUsedCents = totalUsedCents + reversalsCents;
    
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
          updatedAt: new Date(),
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
    const targetDate = date || new Date().toISOString().slice(0, 10);
    
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
    const existingTransaction = await this.getTransactionByAppointmentId(params.appointmentId);
    if (existingTransaction) {
      throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
    }

    const costs = await this.calculateAppointmentCost({
      customerId: params.customerId,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      travelKilometers: params.travelKilometers,
      customerKilometers: params.customerKilometers,
      date: params.transactionDate,
    });

    return await this.createBudgetTransaction({
      customerId: params.customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: params.transactionDate,
      transactionType: "consumption",
      amountCents: -costs.totalCents,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      hauswirtschaftCents: costs.hauswirtschaftCents,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      alltagsbegleitungCents: costs.alltagsbegleitungCents,
      travelKilometers: Math.round(params.travelKilometers * 10),
      travelCents: costs.travelCents,
      customerKilometers: Math.round(params.customerKilometers * 10),
      customerKilometersCents: costs.customerKilometersCents,
      appointmentId: params.appointmentId,
    }, params.userId);
  }
}

export const budgetLedgerStorage = new DatabaseBudgetLedgerStorage();
