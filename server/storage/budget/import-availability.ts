import { budgetTransactions } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getActiveBudgetTypeSettings, getBudgetPreferences } from "./preferences-storage";
import { calculateAllocatedCents, syncCarryoverAndExpiry } from "./allocation-storage";
import { computeCapSlot } from "./cap-calculator";

interface DateAwareAvailability {
  total45b: number;
  total45a: number;
  total39_42a: number;
  totalCents: number;
}

async function netConsumedUpToDate(
  customerId: number,
  budgetType: string,
  asOfDate: string,
  d: DbClient,
): Promise<number> {
  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
      sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
    )),
  ]);
  return Math.max(0, Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0));
}

/**
 * Computes the available budget cents for a given transaction date, applying
 * the SAME monthly/yearly cap logic used by createCascadeConsumption.
 *
 * The cap math (limit + carryover - usedInWindow) lives in
 * `cap-calculator.computeCapSlot` and is shared with the booking path.
 *
 * - §45b: min(pot remaining, monthlyLimit + totalCarryover - usedThisMonth)
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
    getActiveBudgetTypeSettings(customerId, transactionDate, _tx),
    getBudgetPreferences(customerId, _tx),
  ]);

  const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));

  const txYear = parseInt(transactionDate.slice(0, 4), 10);

  // ---- §45b ----
  let total45b = 0;
  const s45b = settingsMap.get("entlastungsbetrag_45b");
  const enabled45b = s45b ? s45b.enabled : true;
  const inRange45b = !s45b
    ? true
    : (!s45b.validFrom || transactionDate >= s45b.validFrom) &&
      (!s45b.validTo || transactionDate <= s45b.validTo);

  if (enabled45b && inRange45b) {
    // §45b ist seit Task #425 ein Jahrestopf ohne Monats-Cap. Verfügbar = bis
    // zum transactionDate aufgelaufene Allocation minus bereits gebuchter
    // Beträge.
    const allocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate: transactionDate },
      _tx,
      preferences,
      typeSettings,
    );
    const netUsed = await netConsumedUpToDate(customerId, "entlastungsbetrag_45b", transactionDate, d);
    total45b = Math.max(0, allocated - netUsed);
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
    const cap = await computeCapSlot({
      customerId,
      budgetType: "umwandlung_45a",
      transactionDate,
      monthlyLimitCents: s45a?.monthlyLimitCents ?? null,
      yearlyLimitCents: null,
    }, _tx);
    const potRemaining = Math.max(0, allocated - cap.netUsedInWindowCents);
    total45a = Math.min(potRemaining, cap.capRemainingCents);
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
    const cap = await computeCapSlot({
      customerId,
      budgetType: "ersatzpflege_39_42a",
      transactionDate,
      monthlyLimitCents: null,
      yearlyLimitCents: s39?.yearlyLimitCents ?? null,
    }, _tx);
    const potRemaining = Math.max(0, allocated - cap.netUsedInWindowCents);
    total39_42a = Math.min(potRemaining, cap.capRemainingCents);
  }

  return {
    total45b,
    total45a,
    total39_42a,
    totalCents: total45b + total45a + total39_42a,
  };
}
