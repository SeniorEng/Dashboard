import {
  budgetTransactions,
  type BudgetTransaction,
  type InsertBudgetTransaction,
} from "@shared/schema";
import { eq, and, desc, gte, lte } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";

export async function createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction> {
  const result = await db.insert(budgetTransactions).values({
    ...transaction,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]> {
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

export async function getTransactionByAppointmentId(appointmentId: number, _tx?: DbClient): Promise<BudgetTransaction | undefined> {
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

export async function getTransactionsByAppointmentId(appointmentId: number): Promise<BudgetTransaction[]> {
  return db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption")
    ));
}

export async function reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined> {
  const d = txClient ?? db;
  const original = await d.select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.id, transactionId))
    .limit(1);

  if (!original[0]) return undefined;

  const existingReversal = await d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.reversedTransactionId, transactionId),
      eq(budgetTransactions.transactionType, "reversal")
    ))
    .limit(1);

  if (existingReversal.length > 0) return existingReversal[0];

  const reversal = await d.insert(budgetTransactions).values({
    customerId: original[0].customerId,
    budgetType: original[0].budgetType,
    transactionDate: todayISO(),
    transactionType: "reversal",
    amountCents: -original[0].amountCents,
    appointmentId: original[0].appointmentId,
    allocationId: original[0].allocationId,
    reversedTransactionId: transactionId,
    notes: `Storno von Transaktion #${transactionId}`,
    createdByUserId: userId,
  }).returning();

  return reversal[0];
}
