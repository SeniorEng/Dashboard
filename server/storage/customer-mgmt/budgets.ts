import {
  type CustomerBudget,
  type InsertCustomerBudget,
  customerBudgets,
} from "@shared/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../../lib/db";

export async function getCustomerCurrentBudget(customerId: number): Promise<CustomerBudget | undefined> {
  const result = await db
    .select()
    .from(customerBudgets)
    .where(and(
      eq(customerBudgets.customerId, customerId),
      isNull(customerBudgets.validTo)
    ))
    .limit(1);
  return result[0];
}

export async function getCustomerBudgetHistory(customerId: number): Promise<CustomerBudget[]> {
  return await db
    .select()
    .from(customerBudgets)
    .where(eq(customerBudgets.customerId, customerId))
    .orderBy(desc(customerBudgets.validFrom));
}

export async function addCustomerBudget(data: InsertCustomerBudget, userId?: number, tx?: DbOrTx): Promise<CustomerBudget> {
  const executor = tx ?? db;
  const today = todayISO();

  await executor
    .update(customerBudgets)
    .set({ validTo: today })
    .where(and(
      eq(customerBudgets.customerId, data.customerId),
      isNull(customerBudgets.validTo)
    ));

  const result = await executor.insert(customerBudgets).values({
    ...data,
    createdByUserId: userId,
  }).returning();

  return result[0];
}
