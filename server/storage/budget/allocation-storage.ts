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
import { eq, and, sql, lte, gte, isNull, isNotNull, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, currentYearAndMonth } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { formatEuroDE } from "@shared/utils/money";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { getBudgetPreferences, getBudgetTypeSettings, getActiveBudgetTypeSettings } from "./preferences-storage";
import { auditService } from "../../services/audit";

const DEFAULT_MONTHLY_BUDGET_CENTS = BUDGET_45B_MAX_MONTHLY_CENTS;

export async function createBudgetAllocation(allocation: InsertBudgetAllocation, userId?: number, tx?: DbClient): Promise<BudgetAllocation> {
  const executor = tx ?? db;
  const result = await executor.insert(budgetAllocations).values({
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
  const allExisting = await db.select({ id: budgetAllocations.id, deletedAt: budgetAllocations.deletedAt })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, params.customerId),
      eq(budgetAllocations.budgetType, params.budgetType),
      eq(budgetAllocations.source, "initial_balance"),
      eq(budgetAllocations.year, params.year),
      eq(budgetAllocations.month, params.month),
    ))
    .orderBy(desc(budgetAllocations.id));

  const active = allExisting.filter(e => !e.deletedAt);
  const deleted = allExisting.filter(e => !!e.deletedAt);

  if (active.length > 0) {
    await db.update(budgetAllocations)
      .set({
        amountCents: params.amountCents,
        month: params.month,
        validFrom: params.validFrom,
        expiresAt: params.expiresAt,
        notes: params.notes ?? null,
      })
      .where(eq(budgetAllocations.id, active[0].id));

    for (let i = 1; i < active.length; i++) {
      await db.update(budgetAllocations)
        .set({ deletedAt: new Date() })
        .where(eq(budgetAllocations.id, active[i].id));
      if (userId != null) {
        await auditService.log(userId, "budget_allocation_soft_deleted", "budget", params.customerId, {
          customerId: params.customerId,
          budgetType: params.budgetType,
          allocationId: active[i].id,
          reason: "GoBD: Duplikat-Bereinigung bei upsertInitialBalanceAllocation",
          keptAllocationId: active[0].id,
        });
      }
    }
  } else if (deleted.length > 0) {
    // GoBD (Task #440): soft-gelöschte Allokationen werden NICHT wiederbelebt
    // (kein `deletedAt = null`). Stattdessen wird eine frische Zeile angelegt;
    // die alte Soft-Delete-Historie bleibt unverändert nachvollziehbar. Der
    // partielle UNIQUE-Index `budget_allocations_auto_unique_idx`
    // (`WHERE deleted_at IS NULL`) lässt die Neuanlage zu.
    const inserted = await db.insert(budgetAllocations)
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
      })
      .returning({ id: budgetAllocations.id });

    if (userId != null) {
      await auditService.log(userId, "budget_allocation_resurrected", "budget", params.customerId, {
        customerId: params.customerId,
        budgetType: params.budgetType,
        year: params.year,
        month: params.month,
        amountCents: params.amountCents,
        replacedSoftDeletedAllocationId: deleted[0].id,
        newAllocationId: inserted[0]?.id ?? null,
        reason: "GoBD: Ersatz-Insert statt Resurrect der soft-gelöschten initial_balance-Allokation",
      });
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
  // Startwert-Historie darf ausschließlich manuelle initial_balance-Einträge enthalten.
  // Carryover-Einträge entstehen automatisch und gehören nicht in die Startwert-Sektion (Task #101).
  return db.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, budgetType),
      isNull(budgetAllocations.deletedAt),
      eq(budgetAllocations.source, "initial_balance"),
    ))
    .orderBy(desc(budgetAllocations.validFrom));
}

async function getMonthlyBudgetAmountCents(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<number> {
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

/**
 * Berechnet die für §45b (Entlastungsbetrag) zur Verfügung stehende Allocation in Cent.
 *
 * ## Auto-Renewal-Modell (virtuelle monatliche Allokation)
 *
 * §45b ist ein **kumulatives Jahresbudget mit monatlicher Aufstockung** (Default
 * 131 €/Monat = `BUDGET_45B_MAX_MONTHLY_CENTS`). Wir legen für die monatliche
 * Aufstockung **bewusst KEINE Datenbank-Zeilen** an. Stattdessen wird die Summe
 * pro Aufruf rein **rechnerisch** ermittelt:
 *
 *   1. Bestimme `allocStartYear/Month` (Startpunkt der Aufstockung) aus:
 *      - `preferences.budgetStartDate`,
 *      - frühestem `initial_balance.validFrom`,
 *      - frühestem persistierten `monthly_auto`/`monthly`/`carryover`,
 *      - bzw. `s45b.validFrom` (überschreibt nach oben).
 *      Liegt ein manueller Startwert vor, beginnt das Auto-Renewal erst im
 *      Folgemonat (siehe `latestIbMonth + 1`-Logik), damit der Stichmonat des
 *      Startwerts nicht doppelt gezählt wird.
 *
 *   2. Bestimme `endYear/Month = min(horizon, s45b.validTo)`. `horizon` ist
 *      `opts.asOfDate` falls in der Vergangenheit, sonst „heute". Termine in
 *      der Zukunft sehen damit nur Allokationen bis zum aktuellen Monat.
 *
 *   3. Iteriere Monat für Monat von Start bis Ende und addiere für jeden Monat
 *      `monthlyAmount`, sofern für diesen `(year, month)` KEIN expliziter
 *      `initial_balance` existiert (`initialBalanceSet` enthält auch gelöschte
 *      Startwerte, damit ein gelöschter Startwert nicht durch monatliche
 *      Auto-Allokation rückwirkend ersetzt wird → Task #101).
 *
 *   4. Addiere alle persistierten `initial_balance`-Einträge bis `ibDateLimit`.
 *
 *   5. Addiere alle persistierten `carryover`-Einträge — aber nur dann, wenn
 *      für das **Quelljahr** (carryover.year - 1) **kein** manueller Startwert
 *      existiert. Sonst Doppelzählung (Task #101). Das Cleanup-Skript
 *      `server/scripts/cleanup-duplicate-carryovers.ts` räumt obsolet
 *      gewordene Carryovers zusätzlich auf (Task #102).
 *
 * ## Warum virtuell statt gespeichert?
 *
 *  - **Kein periodischer Cron nötig** — die Aufstockung wirkt sofort, sobald
 *    der nächste Monat erreicht ist.
 *  - **Rückwirkende Importe** funktionieren konsistent: Ein im April
 *    importierter Januar-Termin sieht für die Allocation-Summe nur Monate
 *    bis zum aktuellen Datum, nicht etwa nur Januar (siehe
 *    `consumption-engine.ts: allocationAsOfDate = todayISO()` für §45b).
 *  - **Konsumtion** läuft hingegen über die echten `budget_transactions` —
 *    das Auto-Renewal ist also nur eine Berechnungs-Konvention für die
 *    Allocation-Seite.
 *
 * ## Wo das Modell zuschlägt
 *
 *  - Hier: Berechnung des Allocation-Headerwerts in Summary/UI.
 *  - `summary-queries.ts: getCustomerBudgetSummary` ruft das via
 *    `calculateAllocatedCents` auf.
 *  - `consumption-engine.ts: consumeFifo` benutzt es als Obergrenze für die
 *    FIFO-Buchung (mit `asOfDate = todayISO()` für §45b, sonst
 *    `transactionDate`).
 */
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

  const deletedIbEntries = await d.select({
    year: budgetAllocations.year,
    month: budgetAllocations.month,
  }).from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "initial_balance"),
      isNotNull(budgetAllocations.deletedAt)
    ));

  const initialBalanceMonths = existingAllocations
    .filter(a => a.source === "initial_balance" && a.month != null)
    .map(a => ({ year: a.year, month: a.month! }));

  const deletedIbMonths = deletedIbEntries
    .filter(e => e.month != null)
    .map(e => ({ year: e.year, month: e.month! }));

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
    [...initialBalanceMonths, ...deletedIbMonths].map(ib => `${ib.year}-${ib.month}`)
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

  // Carryover ignorieren, wenn für das *Quelljahr* (carryover.year - 1) ein manueller Startwert
  // existiert: Der Startwert bildet das Restguthaben bereits ab und der Carryover wäre
  // Doppelzählung (Task #101). Das Cleanup-Skript räumt solche obsoleten Einträge zusätzlich auf.
  const ibYears = new Set(
    existingAllocations.filter(a => a.source === "initial_balance").map(a => a.year)
  );
  const carryoverTotal = existingAllocations
    .filter(a => a.source === "carryover" &&
      a.validFrom <= (opts.asOfDate ?? `${curYear}-12-31`) &&
      (!a.expiresAt || a.expiresAt >= (opts.asOfDate ?? `${curYear}-01-01`)) &&
      !ibYears.has(a.year - 1))
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

  const initialBalances = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "ersatzpflege_39_42a"),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt)
    ));

  const amounts = await getCustomerBudgetAmounts(customerId, undefined, typeSettings);
  const yearlyLimitCents = amounts.verhinderungspflege39;

  if (!yearlyLimitCents && initialBalances.length === 0) return 0;

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
    const ibForYear = initialBalances
      .filter(a => a.year === opts.year)
      .reduce((sum, a) => sum + a.amountCents, 0);
    const yearlyAlloc = opts.year >= startYear && opts.year <= endYear ? yearlyLimitCents : 0;
    return yearlyAlloc + ibForYear;
  }

  if (opts.asOfDate) {
    const asOfYear = parseLocalDate(opts.asOfDate).getFullYear();
    const ibForYear = initialBalances
      .filter(a => a.year === asOfYear)
      .reduce((sum, a) => sum + a.amountCents, 0);
    const yearlyAlloc = asOfYear >= startYear && asOfYear <= endYear ? yearlyLimitCents : 0;
    return yearlyAlloc + ibForYear;
  }

  const ibTotal = initialBalances.reduce((sum, a) => sum + a.amountCents, 0);
  return Math.max(0, endYear - startYear + 1) * yearlyLimitCents + ibTotal;
}

async function ensureYearlyCarryover45b(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
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

  let eligibilityStartYear = curYear;

  let budgetStartDate = preferences?.budgetStartDate ?? null;
  if (!budgetStartDate) {
    const ibEntries = allAllocations.filter(a => a.source === "initial_balance" && a.validFrom);
    if (ibEntries.length > 0) {
      budgetStartDate = ibEntries.reduce((min, a) => a.validFrom < min.validFrom ? a : min).validFrom;
    }
  }
  if (!budgetStartDate) {
    const otherEntries = allAllocations.filter(a =>
      (a.source === "monthly_auto" || a.source === "monthly" || a.source === "carryover") && a.validFrom
    );
    if (otherEntries.length > 0) {
      budgetStartDate = otherEntries.reduce((min, a) => a.validFrom < min.validFrom ? a : min).validFrom;
    }
  }
  if (!budgetStartDate) {
    const s45bEnabled = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
    if (!s45bEnabled) return [];
    budgetStartDate = `${curYear}-01-01`;
  }
  eligibilityStartYear = parseLocalDate(budgetStartDate).getFullYear();

  const s45bSetting = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  if (s45bSetting?.validFrom) {
    const vfYear = parseLocalDate(s45bSetting.validFrom).getFullYear();
    if (vfYear > eligibilityStartYear) eligibilityStartYear = vfYear;
  }

  const years: number[] = [];
  for (let y = eligibilityStartYear; y <= curYear; y++) {
    years.push(y);
  }

  const created: BudgetAllocation[] = [];

  // Jahre mit manuellem Startwert (initial_balance) – für diese Jahre darf KEIN automatischer
  // Carryover ins Folgejahr erzeugt werden. Begründung (Task #101): Ein manuell gesetzter
  // Startwert bildet das Restguthaben ab seinem Stichmonat bereits ab. Würde zusätzlich ein
  // Carryover für das Folgejahr automatisch angelegt, käme es zur Doppelzählung. Die klassische
  // Übertrags-Logik bleibt erhalten für Jahre OHNE manuellen Startwert.
  const yearsWithInitialBalance = new Set(
    allAllocations.filter(a => a.source === "initial_balance").map(a => a.year)
  );

  // Bulk-Vorberechnung (Task #442): statt pro Jahr vier separate SUM-Queries
  // abzusetzen, sammeln wir alle relevanten Allocation-IDs sowie den Jahres-
  // bereich einmal vorab und feuern höchstens zwei aggregierte Queries.
  const yearsToProcess = years.filter(y =>
    y < curYear && !existingCarryoverYears.has(y + 1) && !yearsWithInitialBalance.has(y)
  );

  const linkedIdsByYear = new Map<number, number[]>();
  const allLinkedIdsSet = new Set<number>();
  for (const year of yearsToProcess) {
    const specialIds = allAllocations
      .filter(a => a.year === year && a.source !== "carryover")
      .map(a => a.id);
    const carryoverIds = carryoverAllocations
      .filter(a => a.year === year)
      .map(a => a.id);
    const ids = [...specialIds, ...carryoverIds];
    linkedIdsByYear.set(year, ids);
    for (const id of ids) allLinkedIdsSet.add(id);
  }
  const allLinkedIds = Array.from(allLinkedIdsSet);

  const linkedConsumptionByAlloc = new Map<number, number>();
  const linkedReversalByAlloc = new Map<number, number>();
  if (allLinkedIds.length > 0) {
    const linkedRows = await d.select({
      allocationId: budgetTransactions.allocationId,
      transactionType: budgetTransactions.transactionType,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off', 'reversal')`,
      inArray(budgetTransactions.allocationId, allLinkedIds)
    )).groupBy(budgetTransactions.allocationId, budgetTransactions.transactionType);

    for (const row of linkedRows) {
      if (row.allocationId == null) continue;
      const total = Number(row.total ?? 0);
      if (row.transactionType === "reversal") {
        linkedReversalByAlloc.set(row.allocationId, (linkedReversalByAlloc.get(row.allocationId) ?? 0) + total);
      } else {
        linkedConsumptionByAlloc.set(row.allocationId, (linkedConsumptionByAlloc.get(row.allocationId) ?? 0) + total);
      }
    }
  }

  const unlinkedConsumptionByYear = new Map<number, number>();
  const unlinkedReversalByYear = new Map<number, number>();
  if (yearsToProcess.length > 0) {
    const firstYear = Math.min(...yearsToProcess);
    const lastYear = Math.max(...yearsToProcess);
    const unlinkedRows = await d.select({
      year: sql<number>`EXTRACT(YEAR FROM ${budgetTransactions.transactionDate})::int`,
      transactionType: budgetTransactions.transactionType,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off', 'reversal')`,
      isNull(budgetTransactions.allocationId),
      gte(budgetTransactions.transactionDate, `${firstYear}-01-01`),
      lte(budgetTransactions.transactionDate, `${lastYear}-12-31`)
    )).groupBy(
      sql`EXTRACT(YEAR FROM ${budgetTransactions.transactionDate})`,
      budgetTransactions.transactionType
    );

    for (const row of unlinkedRows) {
      const y = Number(row.year);
      const total = Number(row.total ?? 0);
      if (row.transactionType === "reversal") {
        unlinkedReversalByYear.set(y, (unlinkedReversalByYear.get(y) ?? 0) + total);
      } else {
        unlinkedConsumptionByYear.set(y, (unlinkedConsumptionByYear.get(y) ?? 0) + total);
      }
    }
  }

  for (const year of yearsToProcess) {
    const targetYear = year + 1;

    const yearAllocatedCents = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year }, _tx, preferences, typeSettings);

    const carryoverIntoThisYear = carryoverAllocations.filter(a => a.year === year);
    const totalCarryoverIn = carryoverIntoThisYear.reduce((sum, a) => sum + a.amountCents, 0);

    const linkedIds = linkedIdsByYear.get(year) ?? [];

    let linkedConsumed = 0;
    let linkedReversed = 0;
    for (const id of linkedIds) {
      linkedConsumed += linkedConsumptionByAlloc.get(id) ?? 0;
      linkedReversed += linkedReversalByAlloc.get(id) ?? 0;
    }

    const totalConsumed = linkedConsumed + (unlinkedConsumptionByYear.get(year) ?? 0);
    const totalReversed = linkedReversed + (unlinkedReversalByYear.get(year) ?? 0);
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
      notes: `Übertrag aus ${year}: ${formatEuroDE(unused)} (verfällt 30.06.${targetYear})`,
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

  // Bulk-Aggregat (Task #442): eine GROUP-BY-Query über alle abgelaufenen
  // Allokationen statt 2N pro-Allocation-SUMs. Map-Lookup in der Schleife.
  const expiredIds = expiredAllocations.map(a => a.id);
  const consumedByAlloc = new Map<number, number>();
  const reversedByAlloc = new Map<number, number>();
  if (expiredIds.length > 0) {
    const totals = await d.select({
      allocationId: budgetTransactions.allocationId,
      transactionType: budgetTransactions.transactionType,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        inArray(budgetTransactions.allocationId, expiredIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off', 'reversal')`
      ))
      .groupBy(budgetTransactions.allocationId, budgetTransactions.transactionType);

    for (const row of totals) {
      if (row.allocationId == null) continue;
      const t = Number(row.total ?? 0);
      if (row.transactionType === "reversal") {
        reversedByAlloc.set(row.allocationId, (reversedByAlloc.get(row.allocationId) ?? 0) + t);
      } else {
        consumedByAlloc.set(row.allocationId, (consumedByAlloc.get(row.allocationId) ?? 0) + t);
      }
    }
  }

  for (const allocation of expiredAllocations) {
    if (writtenOffAllocationIds.has(allocation.id)) continue;

    const consumed = consumedByAlloc.get(allocation.id) ?? 0;
    const reversed = reversedByAlloc.get(allocation.id) ?? 0;
    const remaining = allocation.amountCents - Math.max(0, consumed - reversed);

    if (remaining <= 0) continue;

    // Idempotenter Write-Off: Die partielle UNIQUE auf
    // (customer_id, allocation_id) WHERE transaction_type='write_off'
    // schützt auf DB-Ebene gegen doppelte Verfalls-Buchungen pro Allokation.
    // Bei Konflikt liefert RETURNING ein leeres Array, ohne die Transaktion
    // zu poisonieren.
    const writeOff = await d.insert(budgetTransactions).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: allocation.expiresAt!,
      transactionType: "write_off",
      amountCents: -remaining,
      allocationId: allocation.id,
      notes: `Verfallenes Guthaben aus ${allocation.year}: ${formatEuroDE(remaining)} (Frist ${allocation.expiresAt})`,
    }).onConflictDoNothing().returning();

    if (writeOff[0]) created.push(writeOff[0]);
  }

  return created;
}

export async function syncCarryoverAndExpiry(customerId: number, _tx?: DbClient): Promise<void> {
  await ensureYearlyCarryover45b(customerId, _tx);
  await processExpiredCarryover(customerId, _tx);
}

