import { budgetTransactions } from "@shared/schema";
import { eq, and, sql, lte, gte } from "drizzle-orm";
import { parseLocalDate } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getBudgetTypeSettings, getBudgetPreferences } from "./preferences-storage";
import { getTotalCarryoverCents } from "./summary-queries";
import { calculateAllocatedCents, syncCarryoverAndExpiry } from "./allocation-storage";

export interface DateAwareAvailability {
  total45b: number;
  total45a: number;
  total39_42a: number;
  totalCents: number;
}

/**
 * Spiegelt exakt die Cap-Logik aus `createCascadeConsumption`:
 *   alreadyUsed = SUM(consumption[transactionDate ∈ range])
 *               - SUM(reversal   [transactionDate ∈ range])
 * Insbesondere wird `write_off` NICHT mitgezählt (nur consumption/reversal),
 * damit Vorschau und Buchung garantiert dieselben Cap-Werte liefern.
 */
async function netConsumedInRange(
  customerId: number,
  budgetType: string,
  fromDate: string,
  toDate: string,
  d: DbClient,
): Promise<number> {
  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "consumption"),
      gte(budgetTransactions.transactionDate, fromDate),
      lte(budgetTransactions.transactionDate, toDate),
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
      gte(budgetTransactions.transactionDate, fromDate),
      lte(budgetTransactions.transactionDate, toDate),
    )),
  ]);
  return Math.max(0, Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0));
}

async function netConsumedAllTime(
  customerId: number,
  budgetType: string,
  d: DbClient,
): Promise<number> {
  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
    )),
  ]);
  return Math.max(0, Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0));
}

/**
 * Computes the available budget cents for a given transaction date, applying
 * the SAME monthly/yearly cap logic used by createCascadeConsumption.
 *
 * - §45b: min(pot remaining, monthlyLimit + totalCarryover(asOf=transactionDate)
 *         - alreadyUsedThisMonth)
 * - §45a: min(pot remaining, monthlyLimit - usedThisMonth)
 * - §39/§42a: min(pot remaining, yearlyLimit - usedThisYear)
 *
 * Disabled budget types contribute 0. Out-of-range (validFrom/validTo) types
 * contribute 0.
 */
export async function getAvailableForDate(
  customerId: number,
  transactionDate: string,
  _tx?: DbClient,
): Promise<DateAwareAvailability> {
  const d = _tx ?? db;

  await syncCarryoverAndExpiry(customerId, _tx);

  const [typeSettings, preferences] = await Promise.all([
    getBudgetTypeSettings(customerId, _tx),
    getBudgetPreferences(customerId, _tx),
  ]);

  const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));

  const txDate = parseLocalDate(transactionDate);
  const txYear = txDate.getFullYear();
  const txMonth = txDate.getMonth() + 1;
  const monthStart = `${txYear}-${String(txMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(txYear, txMonth, 0).getDate();
  const monthEnd = `${txYear}-${String(txMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const yearStart = `${txYear}-01-01`;
  const yearEnd = `${txYear}-12-31`;

  // ---- §45b ----
  let total45b = 0;
  const s45b = settingsMap.get("entlastungsbetrag_45b");
  const enabled45b = s45b ? s45b.enabled : true;
  const inRange45b = !s45b
    ? true
    : (!s45b.validFrom || transactionDate >= s45b.validFrom) &&
      (!s45b.validTo || transactionDate <= s45b.validTo);

  if (enabled45b && inRange45b) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: transactionDate },
      _tx,
      preferences,
      typeSettings,
    );
    const netUsed = await netConsumedAllTime(customerId, "entlastungsbetrag_45b", d);
    const potRemaining = Math.max(0, allocated - netUsed);

    const monthlyLimit = s45b?.monthlyLimitCents ?? preferences?.monthlyLimitCents ?? null;
    if (monthlyLimit !== null) {
      const totalCarryover = await getTotalCarryoverCents(customerId, transactionDate, _tx);
      const usedThisMonth = await netConsumedInRange(customerId, "entlastungsbetrag_45b", monthStart, monthEnd, d);
      const monthlyRemaining = Math.max(0, monthlyLimit + totalCarryover - usedThisMonth);
      total45b = Math.min(potRemaining, monthlyRemaining);
    } else {
      total45b = potRemaining;
    }
  }

  // ---- §45a ----
  let total45a = 0;
  const s45a = settingsMap.get("umwandlung_45a");
  const enabled45a = s45a ? s45a.enabled : false;
  const inRange45a = !s45a
    ? true
    : (!s45a.validFrom || transactionDate >= s45a.validFrom) &&
      (!s45a.validTo || transactionDate <= s45a.validTo);

  if (enabled45a && inRange45a) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "umwandlung_45a",
      { asOfDate: transactionDate },
      _tx,
      preferences,
      typeSettings,
    );
    const usedThisMonth = await netConsumedInRange(customerId, "umwandlung_45a", monthStart, monthEnd, d);
    const potRemaining = Math.max(0, allocated - usedThisMonth);

    const monthlyLimit = s45a?.monthlyLimitCents ?? null;
    if (monthlyLimit !== null) {
      const monthlyRemaining = Math.max(0, monthlyLimit - usedThisMonth);
      total45a = Math.min(potRemaining, monthlyRemaining);
    } else {
      total45a = potRemaining;
    }
  }

  // ---- §39/§42a ----
  let total39_42a = 0;
  const s39 = settingsMap.get("ersatzpflege_39_42a");
  const enabled39 = s39 ? s39.enabled : false;
  const inRange39 = !s39
    ? true
    : (!s39.validFrom || transactionDate >= s39.validFrom) &&
      (!s39.validTo || transactionDate <= s39.validTo);

  if (enabled39 && inRange39) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "ersatzpflege_39_42a",
      { year: txYear },
      _tx,
      preferences,
      typeSettings,
    );
    const usedThisYear = await netConsumedInRange(customerId, "ersatzpflege_39_42a", yearStart, yearEnd, d);
    const potRemaining = Math.max(0, allocated - usedThisYear);

    const yearlyLimit = s39?.yearlyLimitCents ?? null;
    if (yearlyLimit !== null) {
      const yearlyRemaining = Math.max(0, yearlyLimit - usedThisYear);
      total39_42a = Math.min(potRemaining, yearlyRemaining);
    } else {
      total39_42a = potRemaining;
    }
  }

  return {
    total45b,
    total45a,
    total39_42a,
    totalCents: total45b + total45a + total39_42a,
  };
}
