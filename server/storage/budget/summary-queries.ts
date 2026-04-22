import {
  budgetAllocations,
  budgetTransactions,
  type CustomerBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, lastDayOfMonth } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient, BudgetSummary, Budget45aSummary, Budget39_42aSummary, AllBudgetSummaries } from "./types";
import { getBudgetPreferences, getBudgetTypeSettings } from "./preferences-storage";
import { getCustomerBudgetAmounts, syncCarryoverAndExpiry, calculateAllocatedCents } from "./allocation-storage";
import { getPlannedCostCents } from "./appointment-cost-calculator";

async function getEffectiveMonthlyLimitCents(customerId: number, _typeSettings?: CustomerBudgetTypeSetting[], _preferences?: CustomerBudgetPreferences | undefined): Promise<number | null> {
  const typeSettings = _typeSettings ?? await getBudgetTypeSettings(customerId);
  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  if (s45b?.monthlyLimitCents != null) {
    return s45b.monthlyLimitCents;
  }
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);
  return preferences?.monthlyLimitCents ?? null;
}

export async function getTotalCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
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

async function getAvailableCarryoverCents(customerId: number, asOfDate: string, _tx?: DbClient): Promise<number> {
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

export async function getBudgetSummary(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetSummary> {
  const [preferences, typeSettings] = await Promise.all([
    _preferences !== undefined ? _preferences : getBudgetPreferences(customerId),
    _typeSettings ?? getBudgetTypeSettings(customerId),
  ]);

  const today = todayISO();
  const todayDate = parseLocalDate(today);
  const currentYear = todayDate.getFullYear();
  const currentMonth = todayDate.getMonth() + 1;
  const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(currentYear, currentMonth, 0).getDate();
  const currentMonthEnd = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const allocValidWhere = and(
    eq(budgetAllocations.customerId, customerId),
    eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
    lte(budgetAllocations.validFrom, today),
    isNull(budgetAllocations.deletedAt),
    or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, today))
  );

  const [totalAllocatedCents, currentYearAllocatedCents, txResult, carryoverResult, currentMonthResult, currentMonthReversalResult] = await Promise.all([
    calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { asOfDate: today }, undefined, preferences, typeSettings),

    calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year: currentYear }, undefined, preferences, typeSettings),

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

  const txMap = new Map<string, { absTotal: number; rawTotal: number }>();
  for (const row of txResult) {
    txMap.set(row.transactionType, { absTotal: Number(row.absTotal), rawTotal: Number(row.rawTotal) });
  }
  const consumptionCents = txMap.get("consumption")?.absTotal ?? 0;
  const writeOffCents = txMap.get("write_off")?.absTotal ?? 0;
  const manualAdjustmentCents = txMap.get("manual_adjustment")?.absTotal ?? 0;
  const reversalsCents = txMap.get("reversal")?.rawTotal ?? 0;
  const netUsedCents = consumptionCents + writeOffCents + manualAdjustmentCents - reversalsCents;

  const carryoverCents = Number(carryoverResult[0]?.total ?? 0);
  const carryoverExpiresAt = carryoverCents > 0 ? (carryoverResult[0]?.expiresAt ?? null) : null;
  const currentMonthConsumption = Number(currentMonthResult[0]?.total ?? 0);
  const currentMonthReversals = Number(currentMonthReversalResult[0]?.total ?? 0);
  const currentMonthUsedCents = Math.max(0, currentMonthConsumption - currentMonthReversals);

  const availableCents = totalAllocatedCents - netUsedCents;
  const plannedCents = await getPlannedCostCents(customerId);

  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  const isCurrentlyActive = !s45b
    ? true
    : (!s45b.validFrom || today >= s45b.validFrom) && (!s45b.validTo || today <= s45b.validTo);

  return {
    customerId,
    totalAllocatedCents,
    totalUsedCents: netUsedCents,
    availableCents: isCurrentlyActive ? availableCents : 0,
    plannedCents: isCurrentlyActive ? plannedCents : 0,
    availableAfterPlannedCents: isCurrentlyActive ? availableCents - plannedCents : 0,
    carryoverCents,
    carryoverExpiresAt,
    currentYearAllocatedCents,
    monthlyLimitCents: await getEffectiveMonthlyLimitCents(customerId, typeSettings, preferences),
    currentMonthUsedCents,
    isCurrentlyActive,
  };
}

async function getBudgetSummary45a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<Budget45aSummary> {
  const today = todayISO();
  const todayDate = parseLocalDate(today);
  const currentYear = todayDate.getFullYear();
  const currentMonth = todayDate.getMonth() + 1;
  const currentMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
  const currentMonthLastDay = lastDayOfMonth(currentYear, currentMonth);

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId);
  const typeSettings = _typeSettings ?? await getBudgetTypeSettings(customerId);
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);
  const s45a = typeSettings.find(s => s.budgetType === "umwandlung_45a" && s.enabled);
  const isCurrentlyActive = !s45a
    ? true
    : (!s45a.validFrom || today >= s45a.validFrom) && (!s45a.validTo || today <= s45a.validTo);

  const [currentMonthAllocatedCents, txConsumptionResult, txReversalResult] = await Promise.all([
    calculateAllocatedCents(customerId, "umwandlung_45a", { asOfDate: today }, undefined, preferences, typeSettings),

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

  const currentMonthUsedCents = Math.max(0, Number(txConsumptionResult[0]?.total ?? 0) - Number(txReversalResult[0]?.total ?? 0));

  return {
    customerId,
    monthlyBudgetCents: amounts.pflegesachleistungen36,
    currentMonthAllocatedCents,
    currentMonthUsedCents,
    currentMonthAvailableCents: isCurrentlyActive ? currentMonthAllocatedCents - currentMonthUsedCents : 0,
    isCurrentlyActive,
  };
}

async function getBudgetSummary39_42a(customerId: number, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<Budget39_42aSummary> {
  const today = todayISO();
  const todayDate = parseLocalDate(today);
  const currentYear = todayDate.getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId);
  const typeSettings = _typeSettings ?? await getBudgetTypeSettings(customerId);
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);

  const [currentYearAllocatedCents, txConsumptionResult, txReversalResult] = await Promise.all([
    calculateAllocatedCents(customerId, "ersatzpflege_39_42a", { year: currentYear }, undefined, preferences, typeSettings),

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

  const currentYearUsedCents = Math.max(0, Number(txConsumptionResult[0]?.total ?? 0) - Number(txReversalResult[0]?.total ?? 0));

  return {
    customerId,
    yearlyBudgetCents: amounts.verhinderungspflege39,
    currentYearAllocatedCents,
    currentYearUsedCents,
    currentYearAvailableCents: currentYearAllocatedCents - currentYearUsedCents,
  };
}

export async function getAllBudgetSummaries(customerId: number): Promise<AllBudgetSummaries> {
  await syncCarryoverAndExpiry(customerId);

  const [preferences, typeSettings] = await Promise.all([
    getBudgetPreferences(customerId),
    getBudgetTypeSettings(customerId),
  ]);
  const amounts = await getCustomerBudgetAmounts(customerId, undefined, typeSettings);

  const is45aEnabled = typeSettings.some(s => s.budgetType === "umwandlung_45a" && s.enabled);
  const is39Enabled = typeSettings.some(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);

  const [entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a] = await Promise.all([
    getBudgetSummary(customerId, preferences, typeSettings),
    is45aEnabled
      ? getBudgetSummary45a(customerId, preferences, amounts, typeSettings)
      : { customerId, monthlyBudgetCents: 0, currentMonthAllocatedCents: 0, currentMonthUsedCents: 0, currentMonthAvailableCents: 0, isCurrentlyActive: false } as Budget45aSummary,
    is39Enabled
      ? getBudgetSummary39_42a(customerId, preferences, amounts, typeSettings)
      : { customerId, yearlyBudgetCents: 0, currentYearAllocatedCents: 0, currentYearUsedCents: 0, currentYearAvailableCents: 0 } as Budget39_42aSummary,
  ]);
  return { entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a };
}
