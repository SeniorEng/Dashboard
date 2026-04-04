import {
  budgetAllocations,
  budgetTransactions,
  customerBudgets,
  customerBudgetTypeSettings,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type CustomerBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, currentYearAndMonth } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getBudgetPreferences, getBudgetTypeSettings } from "./preferences-storage";

const DEFAULT_MONTHLY_BUDGET_CENTS = BUDGET_45B_MAX_MONTHLY_CENTS;

export async function createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number): Promise<BudgetAllocation> {
  const result = await db.insert(budgetAllocations).values({
    ...allocation,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]> {
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

export async function upsertInitialBalanceAllocation(
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

export async function getInitialBalanceAllocations(customerId: number, budgetType: string): Promise<BudgetAllocation[]> {
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

export async function getMonthlyBudgetAmountCents(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<number> {
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

export async function getCustomerBudgetAmounts(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }> {
  const d = _tx ?? db;

  const typeSettings = _typeSettings ?? await getBudgetTypeSettings(customerId, _tx);
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

export async function calculateAllocatedCents(
  customerId: number,
  budgetType: string,
  opts: { year?: number; asOfDate?: string },
  _tx?: DbClient,
  _preferences?: CustomerBudgetPreferences | undefined,
  _typeSettings?: CustomerBudgetTypeSetting[]
): Promise<number> {
  const d = _tx ?? db;
  const typeSettings = _typeSettings ?? await getBudgetTypeSettings(customerId, _tx);
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId, _tx);

  let calculated = 0;
  if (budgetType === "entlastungsbetrag_45b") {
    calculated = await calculateAllocated45b(customerId, opts, d, preferences, typeSettings);
  } else if (budgetType === "umwandlung_45a") {
    calculated = await calculateAllocated45a(customerId, opts, d, preferences, typeSettings);
  } else if (budgetType === "ersatzpflege_39_42a") {
    calculated = await calculateAllocated39_42a(customerId, opts, d, preferences, typeSettings);
  }

  const manualAdjustments = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, budgetType),
      eq(budgetAllocations.source, "manual_adjustment"),
      isNull(budgetAllocations.deletedAt)
    ));

  if (manualAdjustments.length > 0) {
    if (opts.year != null) {
      calculated += manualAdjustments
        .filter(a => a.year === opts.year)
        .reduce((sum, a) => sum + a.amountCents, 0);
    } else if (opts.asOfDate) {
      calculated += manualAdjustments
        .filter(a => a.validFrom <= opts.asOfDate! && (!a.expiresAt || a.expiresAt >= opts.asOfDate!))
        .reduce((sum, a) => sum + a.amountCents, 0);
    } else {
      calculated += manualAdjustments.reduce((sum, a) => sum + a.amountCents, 0);
    }
  }

  return calculated;
}

async function calculateAllocated45b(
  customerId: number,
  opts: { year?: number; asOfDate?: string },
  d: Pick<typeof db, 'select'>,
  preferences: CustomerBudgetPreferences | undefined,
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<number> {
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  const existingAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

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
    const s45bEnabled = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
    if (!s45bEnabled) return 0;
    budgetStartDate = `${curYear}-01-01`;
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

  const initialBalanceSet = new Set(
    initialBalanceMonths.map(ib => `${ib.year}-${ib.month}`)
  );

  const monthlyAmount = await getMonthlyBudgetAmountCents(customerId, undefined, typeSettings);

  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);

  if (s45b?.validFrom) {
    const vfDate = parseLocalDate(s45b.validFrom);
    const vfYear = vfDate.getFullYear();
    const vfMonth = vfDate.getMonth() + 1;
    if (vfYear > allocStartYear || (vfYear === allocStartYear && vfMonth > allocStartMonth)) {
      allocStartYear = vfYear;
      allocStartMonth = vfMonth;
    }
  }

  let horizonYear = curYear;
  let horizonMonth = curMonth;
  if (opts.asOfDate) {
    const asOf = parseLocalDate(opts.asOfDate);
    const asOfYear = asOf.getFullYear();
    const asOfMonth = asOf.getMonth() + 1;
    if (asOfYear < curYear || (asOfYear === curYear && asOfMonth < curMonth)) {
      horizonYear = asOfYear;
      horizonMonth = asOfMonth;
    }
  }

  let endYear = horizonYear;
  let endMonth = horizonMonth;
  if (s45b?.validTo) {
    const vtDate = parseLocalDate(s45b.validTo);
    const vtYear = vtDate.getFullYear();
    const vtMonth = vtDate.getMonth() + 1;
    if (vtYear < endYear || (vtYear === endYear && vtMonth < endMonth)) {
      endYear = vtYear;
      endMonth = vtMonth;
    }
  }

  if (opts.year != null) {
    if (allocStartYear > opts.year) return sumInitialBalancesForYear(existingAllocations, opts.year);
    if (endYear < opts.year) return sumInitialBalancesForYear(existingAllocations, opts.year);
    const yearStart = opts.year === allocStartYear ? allocStartMonth : 1;
    const yearEnd = opts.year === endYear ? endMonth : 12;
    let calculatedCents = 0;
    for (let m = yearStart; m <= yearEnd; m++) {
      if (!initialBalanceSet.has(`${opts.year}-${m}`)) {
        calculatedCents += monthlyAmount;
      }
    }
    calculatedCents += sumInitialBalancesForYear(existingAllocations, opts.year);
    return calculatedCents;
  }

  let totalCalculated = 0;
  let y = allocStartYear, m = allocStartMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    if (!initialBalanceSet.has(`${y}-${m}`)) {
      totalCalculated += monthlyAmount;
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }

  const ibDateLimit = opts.asOfDate ?? `${curYear}-12-31`;
  const initialBalanceTotal = existingAllocations
    .filter(a => a.source === "initial_balance" && a.validFrom <= ibDateLimit)
    .reduce((sum, a) => sum + a.amountCents, 0);

  const carryoverTotal = existingAllocations
    .filter(a => a.source === "carryover" &&
      a.validFrom <= (opts.asOfDate ?? `${curYear}-12-31`) &&
      (!a.expiresAt || a.expiresAt >= (opts.asOfDate ?? `${curYear}-01-01`)))
    .reduce((sum, a) => sum + a.amountCents, 0);

  return totalCalculated + initialBalanceTotal + carryoverTotal;
}

function sumInitialBalancesForYear(allocations: { source: string; year: number; amountCents: number }[], year: number): number {
  return allocations
    .filter(a => a.source === "initial_balance" && a.year === year)
    .reduce((sum, a) => sum + a.amountCents, 0);
}

async function calculateAllocated45a(
  customerId: number,
  opts: { year?: number; asOfDate?: string },
  d: Pick<typeof db, 'select'>,
  preferences: CustomerBudgetPreferences | undefined,
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<number> {
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  let startDateStr = preferences?.budgetStartDate ?? null;

  const existingAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "umwandlung_45a"),
      isNull(budgetAllocations.deletedAt)
    ));

  if (!startDateStr) {
    const ibEntries = existingAllocations.filter(a => a.source === "initial_balance" && a.validFrom);
    if (ibEntries.length > 0) {
      startDateStr = ibEntries.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
    }
  }

  if (!startDateStr) {
    const otherEntries = existingAllocations.filter(a =>
      (a.source === "monthly_auto" || a.source === "monthly" || a.source === "carryover") && a.validFrom
    );
    if (otherEntries.length > 0) {
      startDateStr = otherEntries.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
    }
  }

  if (!startDateStr) {
    const enabled = typeSettings.find(s => s.budgetType === "umwandlung_45a" && s.enabled);
    if (!enabled) return 0;
    startDateStr = `${curYear}-01-01`;
  }

  const amounts = await getCustomerBudgetAmounts(customerId, undefined, typeSettings);
  const monthlyAmount = amounts.pflegesachleistungen36;

  const s45a = typeSettings.find(s => s.budgetType === "umwandlung_45a" && s.enabled);

  const initialBalances = existingAllocations.filter(a => a.source === "initial_balance");

  if (!monthlyAmount && initialBalances.length === 0) return 0;

  const startDate = parseLocalDate(startDateStr);
  let startYear = startDate.getFullYear();
  let startMonth = startDate.getMonth() + 1;

  if (s45a?.validFrom) {
    const vfDate = parseLocalDate(s45a.validFrom);
    const vfYear = vfDate.getFullYear();
    const vfMonth = vfDate.getMonth() + 1;
    if (vfYear > startYear || (vfYear === startYear && vfMonth > startMonth)) {
      startYear = vfYear;
      startMonth = vfMonth;
    }
  }

  let endYear = curYear;
  let endMonth = curMonth;
  if (s45a?.validTo) {
    const vtDate = parseLocalDate(s45a.validTo);
    const vtYear = vtDate.getFullYear();
    const vtMonth = vtDate.getMonth() + 1;
    if (vtYear < curYear || (vtYear === curYear && vtMonth < curMonth)) {
      endYear = vtYear;
      endMonth = vtMonth;
    }
  }

  if (opts.year != null) {
    if (startYear > opts.year || endYear < opts.year) return 0;
    const yearStartMonth = opts.year === startYear ? startMonth : 1;
    const yearEndMonth = opts.year === endYear ? endMonth : 12;
    const ibForYear = initialBalances
      .filter(a => a.year === opts.year)
      .reduce((sum, a) => sum + a.amountCents, 0);
    return Math.max(0, yearEndMonth - yearStartMonth + 1) * monthlyAmount + ibForYear;
  }

  if (opts.asOfDate) {
    const asOf = parseLocalDate(opts.asOfDate);
    const asOfYear = asOf.getFullYear();
    const asOfMonth = asOf.getMonth() + 1;
    const inRange = (asOfYear > startYear || (asOfYear === startYear && asOfMonth >= startMonth)) &&
                    (asOfYear < endYear || (asOfYear === endYear && asOfMonth <= endMonth));
    if (!inRange) return 0;
    const ibForMonth = initialBalances
      .filter(a => a.year === asOfYear && a.month === asOfMonth)
      .reduce((sum, a) => sum + a.amountCents, 0);
    return monthlyAmount + ibForMonth;
  }

  let count = 0;
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    count++;
    m++;
    if (m > 12) { m = 1; y++; }
  }

  const ibTotal = initialBalances.reduce((sum, a) => sum + a.amountCents, 0);
  return count * monthlyAmount + ibTotal;
}

async function calculateAllocated39_42a(
  customerId: number,
  opts: { year?: number; asOfDate?: string },
  d: Pick<typeof db, 'select'>,
  preferences: CustomerBudgetPreferences | undefined,
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<number> {
  const { year: curYear } = currentYearAndMonth();

  let startDateStr = preferences?.budgetStartDate ?? null;

  if (!startDateStr) {
    const existingAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
        isNull(budgetAllocations.deletedAt)
      ));
    const initialBalances = existingAllocations.filter(a => a.source === "initial_balance" && a.validFrom);
    if (initialBalances.length > 0) {
      startDateStr = initialBalances.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
    }
    if (!startDateStr) {
      const otherEntries = existingAllocations.filter(a =>
        (a.source === "monthly_auto" || a.source === "monthly" || a.source === "carryover") && a.validFrom
      );
      if (otherEntries.length > 0) {
        startDateStr = otherEntries.reduce((min, a) =>
          a.validFrom < min.validFrom ? a : min
        ).validFrom;
      }
    }
  }

  if (!startDateStr) {
    const enabled = typeSettings.find(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);
    if (!enabled) return 0;
    startDateStr = `${curYear}-01-01`;
  }

  const amounts = await getCustomerBudgetAmounts(customerId, undefined, typeSettings);
  if (!amounts.verhinderungspflege39) return 0;

  const s39 = typeSettings.find(s => s.budgetType === "ersatzpflege_39_42a" && s.enabled);

  const startDate = parseLocalDate(startDateStr);
  let startYear = startDate.getFullYear();

  if (s39?.validFrom) {
    const vfYear = parseLocalDate(s39.validFrom).getFullYear();
    if (vfYear > startYear) startYear = vfYear;
  }

  let endYear = curYear;
  if (s39?.validTo) {
    const vtYear = parseLocalDate(s39.validTo).getFullYear();
    if (vtYear < curYear) endYear = vtYear;
  }

  if (opts.year != null) {
    return opts.year >= startYear && opts.year <= endYear ? amounts.verhinderungspflege39 : 0;
  }

  if (opts.asOfDate) {
    const asOfYear = parseLocalDate(opts.asOfDate).getFullYear();
    return asOfYear >= startYear && asOfYear <= endYear ? amounts.verhinderungspflege39 : 0;
  }

  return Math.max(0, endYear - startYear + 1) * amounts.verhinderungspflege39;
}

export async function ensureYearlyCarryover45b(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;
  const { year: curYear } = currentYearAndMonth();

  const carryoverAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt)
    ));

  const existingCarryoverYears = new Set(carryoverAllocations.map(a => a.year));

  const preferences = await getBudgetPreferences(customerId, _tx);
  const typeSettings = await getBudgetTypeSettings(customerId, _tx);

  const allAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

  if (allAllocations.length === 0) {
    const totalAllocatedCurrentYear = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year: curYear }, _tx, preferences, typeSettings);
    if (totalAllocatedCurrentYear === 0) return [];
  }

  const yearSet = new Set(allAllocations.map(a => a.year));
  const allocatedCurYear = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year: curYear }, _tx, preferences, typeSettings);
  if (allocatedCurYear > 0) yearSet.add(curYear);
  const years = Array.from(yearSet).sort((a, b) => a - b);

  const created: BudgetAllocation[] = [];

  for (const year of years) {
    if (year >= curYear) continue;
    const targetYear = year + 1;
    if (existingCarryoverYears.has(targetYear)) continue;

    const yearAllocatedCents = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year }, _tx, preferences, typeSettings);

    const carryoverIntoThisYear = carryoverAllocations.filter(a => a.year === year);
    const totalCarryoverIn = carryoverIntoThisYear.reduce((sum, a) => sum + a.amountCents, 0);

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const consumptionResult = await d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
        gte(budgetTransactions.transactionDate, yearStart),
        lte(budgetTransactions.transactionDate, yearEnd)
      ));

    const reversalResult = await d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        eq(budgetTransactions.transactionType, "reversal"),
        gte(budgetTransactions.transactionDate, yearStart),
        lte(budgetTransactions.transactionDate, yearEnd)
      ));

    const totalConsumed = Number(consumptionResult[0]?.total ?? 0);
    const totalReversed = Number(reversalResult[0]?.total ?? 0);
    const netConsumed = Math.max(0, totalConsumed - totalReversed);
    const totalPool = yearAllocatedCents + totalCarryoverIn;
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

export async function processExpiredCarryover(customerId: number, _tx?: DbClient): Promise<import("@shared/schema").BudgetTransaction[]> {
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

  const created: import("@shared/schema").BudgetTransaction[] = [];

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

export async function syncCarryoverAndExpiry(customerId: number, _tx?: DbClient): Promise<void> {
  await ensureYearlyCarryover45b(customerId, _tx);
  await processExpiredCarryover(customerId, _tx);
}

