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
import { todayISO, parseLocalDate, firstDayOfMonth, lastDayOfMonth, lastDayOfYear, currentYearAndMonth } from "@shared/utils/datetime";
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

async function ensureAllocationsGeneric(config: {
  customerId: number;
  budgetType: string;
  frequency: 'monthly' | 'yearly';
  source: string;
  amountCents: number;
  getExpiresAt: (year: number, month: number) => string | null;
  getNotes: (year: number, month: number) => string;
  startYear: number;
  startMonth: number;
  startDateStr?: string;
  skipKeys?: Set<string>;
  endYear?: number;
  endMonth?: number;
}, d: Pick<typeof db, 'select' | 'insert'>): Promise<BudgetAllocation[]> {
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  const existingAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, config.customerId),
      eq(budgetAllocations.budgetType, config.budgetType),
      eq(budgetAllocations.source, config.source),
      isNull(budgetAllocations.deletedAt)
    ));

  const existingSet = new Set(
    config.frequency === 'monthly'
      ? existingAllocations.map(a => `${a.year}-${a.month}`)
      : existingAllocations.map(a => `${a.year}`)
  );

  const created: BudgetAllocation[] = [];

  let finalEndYear = curYear;
  let finalEndMonth = curMonth;
  if (config.endYear != null && config.endMonth != null) {
    if (config.endYear < curYear || (config.endYear === curYear && config.endMonth < curMonth)) {
      finalEndYear = config.endYear;
      finalEndMonth = config.endMonth;
    }
  }

  if (config.frequency === 'monthly') {
    let year = config.startYear;
    let month = config.startMonth;
    while (year < finalEndYear || (year === finalEndYear && month <= finalEndMonth)) {
      const key = `${year}-${month}`;
      if (!existingSet.has(key) && !config.skipKeys?.has(key)) {
        const result = await d.insert(budgetAllocations).values({
          customerId: config.customerId,
          budgetType: config.budgetType,
          year,
          month,
          amountCents: config.amountCents,
          source: config.source,
          validFrom: firstDayOfMonth(year, month),
          expiresAt: config.getExpiresAt(year, month),
          notes: config.getNotes(year, month),
        }).onConflictDoNothing().returning();
        if (result[0]) created.push(result[0]);
      }
      month++;
      if (month > 12) { month = 1; year++; }
    }
  } else {
    for (let year = config.startYear; year <= finalEndYear; year++) {
      if (!existingSet.has(`${year}`)) {
        const validFrom = year === config.startYear
          ? (config.startDateStr ?? firstDayOfMonth(config.startYear, config.startMonth))
          : `${year}-01-01`;
        const result = await d.insert(budgetAllocations).values({
          customerId: config.customerId,
          budgetType: config.budgetType,
          year,
          month: null,
          amountCents: config.amountCents,
          source: config.source,
          validFrom,
          expiresAt: config.getExpiresAt(year, 0),
          notes: config.getNotes(year, 0),
        }).onConflictDoNothing().returning();
        if (result[0]) created.push(result[0]);
      }
    }
  }

  return created;
}

async function resolveStartDate(customerId: number, budgetType: string, d: Pick<typeof db, 'select'>, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<string | null> {
  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId);
  if (preferences?.budgetStartDate) return preferences.budgetStartDate;

  const typeSettings = _typeSettings ?? await d.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
  const enabled = typeSettings.find(s => s.budgetType === budgetType && s.enabled);
  if (!enabled) return null;

  const { year } = currentYearAndMonth();
  return `${year}-01-01`;
}

export async function ensureMonthlyAllocations(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;

  const existingAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

  const preferences = _preferences !== undefined ? _preferences : await getBudgetPreferences(customerId, _tx);
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
    const typeSettings = _typeSettings ?? await d.select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));
    const s45bEnabled = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
    if (!s45bEnabled) return [];
    const { year } = currentYearAndMonth();
    budgetStartDate = `${year}-01-01`;
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

  const existingMonthlySet = new Set(
    existingAllocations
      .filter(a => a.source === "monthly_auto" || a.source === "monthly")
      .map(a => `${a.year}-${a.month}`)
  );
  const initialBalanceSet = new Set(
    initialBalanceMonths.map(ib => `${ib.year}-${ib.month}`)
  );
  const skipKeys = new Set([...existingMonthlySet, ...initialBalanceSet]);

  const monthlyAmount = await getMonthlyBudgetAmountCents(customerId, _tx, _typeSettings);

  const typeSettings = _typeSettings ?? await d.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
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

  let endYear: number | undefined;
  let endMonth: number | undefined;
  if (s45b?.validTo) {
    const vtDate = parseLocalDate(s45b.validTo);
    endYear = vtDate.getFullYear();
    endMonth = vtDate.getMonth() + 1;
  }

  return ensureAllocationsGeneric({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    frequency: 'monthly',
    source: "monthly_auto",
    amountCents: monthlyAmount,
    getExpiresAt: () => null,
    getNotes: (y, m) => `Automatische Zuweisung ${String(m).padStart(2, '0')}/${y}`,
    startYear: allocStartYear,
    startMonth: allocStartMonth,
    skipKeys,
    endYear,
    endMonth,
  }, d);
}

export async function ensureAllocations45a(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;
  const startDateStr = await resolveStartDate(customerId, "umwandlung_45a", d, _preferences);
  if (!startDateStr) return [];

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId, _tx);
  if (!amounts.pflegesachleistungen36) return [];

  const typeSettings = _typeSettings ?? await d.select()
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.customerId, customerId));
  const s45a = typeSettings.find(s => s.budgetType === "umwandlung_45a" && s.enabled);

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

  let endYear: number | undefined;
  let endMonth: number | undefined;
  if (s45a?.validTo) {
    const vtDate = parseLocalDate(s45a.validTo);
    endYear = vtDate.getFullYear();
    endMonth = vtDate.getMonth() + 1;
  }

  return ensureAllocationsGeneric({
    customerId,
    budgetType: "umwandlung_45a",
    frequency: 'monthly',
    source: "monthly_auto",
    amountCents: amounts.pflegesachleistungen36,
    getExpiresAt: (y, m) => lastDayOfMonth(y, m),
    getNotes: (y, m) => `Automatische Zuweisung §45a ${String(m).padStart(2, '0')}/${y}`,
    startYear,
    startMonth,
    endYear,
    endMonth,
  }, d);
}

export async function ensureAllocations39_42a(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _amounts?: { pflegesachleistungen36: number; verhinderungspflege39: number }): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;
  const startDateStr = await resolveStartDate(customerId, "ersatzpflege_39_42a", d, _preferences);
  if (!startDateStr) return [];

  const amounts = _amounts ?? await getCustomerBudgetAmounts(customerId, _tx);
  if (!amounts.verhinderungspflege39) return [];

  const startDate = parseLocalDate(startDateStr);
  return ensureAllocationsGeneric({
    customerId,
    budgetType: "ersatzpflege_39_42a",
    frequency: 'yearly',
    source: "yearly_auto",
    amountCents: amounts.verhinderungspflege39,
    getExpiresAt: (y) => lastDayOfYear(y),
    getNotes: (y) => `Automatische Zuweisung §39/§42a ${y}`,
    startYear: startDate.getFullYear(),
    startMonth: startDate.getMonth() + 1,
    startDateStr,
  }, d);
}

export async function ensureYearlyCarryover45b(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;
  const { year: curYear } = currentYearAndMonth();

  const allAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

  if (allAllocations.length === 0) return [];

  const existingCarryoverYears = new Set(
    allAllocations
      .filter(a => a.source === "carryover")
      .map(a => a.year)
  );

  const yearSet = new Set(allAllocations.map(a => a.year));
  const years = Array.from(yearSet).sort((a, b) => a - b);

  const created: BudgetAllocation[] = [];

  for (const year of years) {
    if (year >= curYear) continue;
    const targetYear = year + 1;
    if (existingCarryoverYears.has(targetYear)) continue;

    const yearAllocations = allAllocations.filter(a =>
      a.year === year &&
      a.source !== "carryover"
    );
    if (yearAllocations.length === 0) continue;

    const totalAllocated = yearAllocations.reduce((sum, a) => sum + a.amountCents, 0);

    const yearAllocIds = yearAllocations.map(a => a.id);

    const carryoverIntoThisYear = allAllocations.filter(a =>
      a.year === year && a.source === "carryover"
    );
    const totalCarryoverIn = carryoverIntoThisYear.reduce((sum, a) => sum + a.amountCents, 0);
    const allAllocIds = [...yearAllocIds, ...carryoverIntoThisYear.map(a => a.id)];

    if (allAllocIds.length === 0) continue;

    const consumptionResult = await d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        inArray(budgetTransactions.allocationId, allAllocIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
      ));

    const reversalResult = await d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        inArray(budgetTransactions.allocationId, allAllocIds),
        eq(budgetTransactions.transactionType, "reversal")
      ));

    const totalConsumed = Number(consumptionResult[0]?.total ?? 0);
    const totalReversed = Number(reversalResult[0]?.total ?? 0);
    const netConsumed = Math.max(0, totalConsumed - totalReversed);
    const totalPool = totalAllocated + totalCarryoverIn;
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

function isAllocationOutOfRange(
  alloc: { year: number | null; month: number | null },
  setting: { validFrom: string | null; validTo: string | null }
): boolean {
  if (alloc.year == null) return false;
  if (!setting.validFrom && !setting.validTo) return false;

  if (alloc.month != null) {
    const allocMonthStr = `${alloc.year}-${String(alloc.month).padStart(2, '0')}`;

    if (setting.validFrom) {
      const vfDate = parseLocalDate(setting.validFrom);
      const vfMonthStr = `${vfDate.getFullYear()}-${String(vfDate.getMonth() + 1).padStart(2, '0')}`;
      if (allocMonthStr < vfMonthStr) return true;
    }

    if (setting.validTo) {
      const vtDate = parseLocalDate(setting.validTo);
      const vtMonthStr = `${vtDate.getFullYear()}-${String(vtDate.getMonth() + 1).padStart(2, '0')}`;
      if (allocMonthStr > vtMonthStr) return true;
    }
  } else {
    if (setting.validFrom) {
      const vfDate = parseLocalDate(setting.validFrom);
      if (alloc.year < vfDate.getFullYear()) return true;
    }
    if (setting.validTo) {
      const vtDate = parseLocalDate(setting.validTo);
      if (alloc.year > vtDate.getFullYear()) return true;
    }
  }

  return false;
}

async function softDeleteOutOfRangeAllocations(
  customerId: number,
  typeSettings: CustomerBudgetTypeSetting[],
  d: Pick<typeof db, 'select' | 'update'>
): Promise<void> {
  for (const setting of typeSettings) {
    if (!setting.enabled) continue;

    const allAutoAllocations = await d.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, setting.budgetType),
        or(
          eq(budgetAllocations.source, "monthly_auto"),
          eq(budgetAllocations.source, "yearly_auto")
        )
      ));

    for (const alloc of allAutoAllocations) {
      const outOfRange = isAllocationOutOfRange(alloc, setting);

      if (outOfRange && !alloc.deletedAt) {
        await d.update(budgetAllocations)
          .set({ deletedAt: new Date() })
          .where(eq(budgetAllocations.id, alloc.id));
      } else if (!outOfRange && alloc.deletedAt) {
        await d.update(budgetAllocations)
          .set({ deletedAt: null })
          .where(eq(budgetAllocations.id, alloc.id));
      }
    }
  }
}

export async function syncBudgetAllocations(customerId: number, _tx?: DbClient, _preferences?: CustomerBudgetPreferences | undefined, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<void> {
  const d = _tx ?? db;
  const [preferences, typeSettings] = await Promise.all([
    _preferences !== undefined ? _preferences : getBudgetPreferences(customerId, _tx),
    _typeSettings ?? getBudgetTypeSettings(customerId, _tx),
  ]);
  const amounts = await getCustomerBudgetAmounts(customerId, _tx, typeSettings);

  await Promise.all([
    ensureMonthlyAllocations(customerId, _tx, preferences, typeSettings),
    ensureAllocations45a(customerId, _tx, preferences, amounts, typeSettings),
    ensureAllocations39_42a(customerId, _tx, preferences, amounts),
  ]);
  await ensureYearlyCarryover45b(customerId, _tx);
  await processExpiredCarryover(customerId, _tx);

  await softDeleteOutOfRangeAllocations(customerId, typeSettings, d);
}
