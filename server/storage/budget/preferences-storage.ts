import {
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  type CustomerBudgetPreferences,
  type InsertBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, asc, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";

export async function getBudgetPreferences(customerId: number, _tx?: DbClient): Promise<CustomerBudgetPreferences | undefined> {
  const d = _tx ?? db;
  const result = await d.select()
    .from(customerBudgetPreferences)
    .where(eq(customerBudgetPreferences.customerId, customerId))
    .limit(1);
  return result[0];
}

export async function upsertBudgetPreferences(preferences: InsertBudgetPreferences, userId?: number): Promise<CustomerBudgetPreferences> {
  const existing = await getBudgetPreferences(preferences.customerId);

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

export async function getBudgetTypeSettings(customerId: number, _tx?: DbClient): Promise<CustomerBudgetTypeSetting[]> {
  const d = _tx ?? db;
  return d.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId))
    .orderBy(asc(customerBudgetTypeSettings.priority));
}

export async function upsertBudgetTypeSettings(
  customerId: number,
  settings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null; validFrom?: string | null; validTo?: string | null }>,
  tx?: DbClient,
): Promise<CustomerBudgetTypeSetting[]> {
  if (settings.length === 0) {
    const executor = tx ?? db;
    await executor.delete(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));
    return [];
  }

  // Wenn bereits eine äußere Transaktion läuft (z.B. atomare Customer-Anlage),
  // delete + insert direkt auf dem übergebenen Executor — kein neues db.transaction,
  // weil neon-serverless verschachtelte Transaktionen nicht sauber unterstützt.
  if (tx) {
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
  }

  return await db.transaction(async (innerTx) => {
    await innerTx.delete(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    return await innerTx.insert(customerBudgetTypeSettings)
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
