import {
  budgetAllocations,
  budgetTransactions,
  customers,
  type BudgetTransaction,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, asc, inArray } from "drizzle-orm";
import { parseLocalDate } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient, CascadeResult } from "./types";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { getTransactionByAppointmentId } from "./transaction-storage";
import { getBudgetPreferences, getBudgetTypeSettings } from "./preferences-storage";
import { syncCarryoverAndExpiry, calculateAllocatedCents } from "./allocation-storage";
import { getAllBudgetSummaries, getTotalCarryoverCents } from "./summary-queries";

export async function consumeFifo(
  customerId: number,
  budgetType: string,
  amountCents: number,
  transactionDate: string,
  params?: {
    appointmentId?: number;
    notes?: string;
    userId?: number;
    hauswirtschaftMinutes?: number;
    hauswirtschaftCents?: number;
    alltagsbegleitungMinutes?: number;
    alltagsbegleitungCents?: number;
    travelKilometers?: number;
    travelCents?: number;
    customerKilometers?: number;
    customerKilometersCents?: number;
  },
  _tx?: DbClient
): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }> {
  const d = _tx ?? db;
  const today = transactionDate;

  const specialAllocations = await d.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, budgetType),
      isNull(budgetAllocations.deletedAt),
      lte(budgetAllocations.validFrom, today),
      or(
        isNull(budgetAllocations.expiresAt),
        gte(budgetAllocations.expiresAt, today)
      ),
      sql`${budgetAllocations.source} IN ('carryover', 'initial_balance', 'manual_adjustment')`
    ))
    .orderBy(
      sql`CASE WHEN ${budgetAllocations.source} = 'carryover' THEN 0 ELSE 1 END`,
      asc(budgetAllocations.validFrom),
      asc(budgetAllocations.id)
    );

  const totalAllocated = await calculateAllocatedCents(customerId, budgetType, { asOfDate: today }, _tx);
  const manualAdjTotal = specialAllocations
    .filter(a => a.source === "manual_adjustment")
    .reduce((sum, a) => sum + a.amountCents, 0);
  const effectiveAllocated = totalAllocated + manualAdjTotal;

  if (effectiveAllocated <= 0 && specialAllocations.length === 0) {
    return { consumedCents: 0, transactions: [], remainingCents: amountCents };
  }

  const allSpecialIds = specialAllocations.map(a => a.id);
  let consumedBySpecial = new Map<number, number>();
  let reversalBySpecial = new Map<number, number>();

  if (allSpecialIds.length > 0) {
    const consumptionResult = await d.select({
      allocationId: budgetTransactions.allocationId,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        inArray(budgetTransactions.allocationId, allSpecialIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`
      ))
      .groupBy(budgetTransactions.allocationId);

    const reversalResult = await d.select({
      allocationId: budgetTransactions.allocationId,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    })
      .from(budgetTransactions)
      .where(and(
        inArray(budgetTransactions.allocationId, allSpecialIds),
        eq(budgetTransactions.transactionType, "reversal")
      ))
      .groupBy(budgetTransactions.allocationId);

    consumedBySpecial = new Map(consumptionResult.map(c => [c.allocationId!, Number(c.total)]));
    reversalBySpecial = new Map(reversalResult.map(r => [r.allocationId!, Number(r.total)]));
  }

  const txDateFilters = [];
  if (budgetType === "umwandlung_45a") {
    const txDate = parseLocalDate(today);
    const monthStart = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}-01`;
    const daysInMonth = new Date(txDate.getFullYear(), txDate.getMonth() + 1, 0).getDate();
    const monthEnd = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    txDateFilters.push(gte(budgetTransactions.transactionDate, monthStart));
    txDateFilters.push(lte(budgetTransactions.transactionDate, monthEnd));
  } else if (budgetType === "ersatzpflege_39_42a") {
    const txDate = parseLocalDate(today);
    txDateFilters.push(gte(budgetTransactions.transactionDate, `${txDate.getFullYear()}-01-01`));
    txDateFilters.push(lte(budgetTransactions.transactionDate, `${txDate.getFullYear()}-12-31`));
  }

  const totalConsumedResult = await d.select({
    total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
  })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      ...txDateFilters
    ));

  const totalReversalsResult = await d.select({
    total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
  })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
      ...txDateFilters
    ));

  const totalNetConsumed = Math.max(0, Number(totalConsumedResult[0]?.total ?? 0) - Number(totalReversalsResult[0]?.total ?? 0));
  const totalAvailable = Math.max(0, effectiveAllocated - totalNetConsumed);

  if (totalAvailable <= 0) {
    return { consumedCents: 0, transactions: [], remainingCents: amountCents };
  }

  let remaining = Math.min(amountCents, totalAvailable);
  let totalConsumedAmount = 0;
  const transactions: BudgetTransaction[] = [];
  let isFirstTransaction = true;

  for (const allocation of specialAllocations) {
    if (remaining <= 0) break;

    const consumed = consumedBySpecial.get(allocation.id) ?? 0;
    const reversed = reversalBySpecial.get(allocation.id) ?? 0;
    const netConsumed = Math.max(0, consumed - reversed);
    const available = Math.max(0, allocation.amountCents - netConsumed);

    if (available <= 0) continue;

    const consumeAmount = Math.min(remaining, available);
    const ratio = params && amountCents > 0 ? consumeAmount / amountCents : (isFirstTransaction ? 1 : 0);

    const txData: typeof budgetTransactions.$inferInsert = {
      customerId,
      budgetType,
      transactionDate,
      transactionType: "consumption",
      amountCents: -consumeAmount,
      allocationId: allocation.id,
      appointmentId: params?.appointmentId ?? null,
      notes: params?.notes ?? null,
      createdByUserId: params?.userId,
      hauswirtschaftMinutes: params?.hauswirtschaftMinutes != null ? Math.round(params.hauswirtschaftMinutes * ratio) : null,
      hauswirtschaftCents: params?.hauswirtschaftCents != null ? Math.round(params.hauswirtschaftCents * ratio) : null,
      alltagsbegleitungMinutes: params?.alltagsbegleitungMinutes != null ? Math.round(params.alltagsbegleitungMinutes * ratio) : null,
      alltagsbegleitungCents: params?.alltagsbegleitungCents != null ? Math.round(params.alltagsbegleitungCents * ratio) : null,
      travelKilometers: params?.travelKilometers != null ? Math.round(params.travelKilometers * ratio) : null,
      travelCents: params?.travelCents != null ? Math.round(params.travelCents * ratio) : null,
      customerKilometers: params?.customerKilometers != null ? Math.round(params.customerKilometers * ratio) : null,
      customerKilometersCents: params?.customerKilometersCents != null ? Math.round(params.customerKilometersCents * ratio) : null,
    };

    const result = await d.insert(budgetTransactions).values(txData).returning();
    if (result[0]) transactions.push(result[0]);

    remaining -= consumeAmount;
    totalConsumedAmount += consumeAmount;
    isFirstTransaction = false;
  }

  if (remaining > 0) {
    const ratio = params && amountCents > 0 ? remaining / amountCents : (isFirstTransaction ? 1 : 0);

    const txData: typeof budgetTransactions.$inferInsert = {
      customerId,
      budgetType,
      transactionDate,
      transactionType: "consumption",
      amountCents: -remaining,
      allocationId: null,
      appointmentId: params?.appointmentId ?? null,
      notes: params?.notes ?? null,
      createdByUserId: params?.userId,
      hauswirtschaftMinutes: params?.hauswirtschaftMinutes != null ? Math.round(params.hauswirtschaftMinutes * ratio) : null,
      hauswirtschaftCents: params?.hauswirtschaftCents != null ? Math.round(params.hauswirtschaftCents * ratio) : null,
      alltagsbegleitungMinutes: params?.alltagsbegleitungMinutes != null ? Math.round(params.alltagsbegleitungMinutes * ratio) : null,
      alltagsbegleitungCents: params?.alltagsbegleitungCents != null ? Math.round(params.alltagsbegleitungCents * ratio) : null,
      travelKilometers: params?.travelKilometers != null ? Math.round(params.travelKilometers * ratio) : null,
      travelCents: params?.travelCents != null ? Math.round(params.travelCents * ratio) : null,
      customerKilometers: params?.customerKilometers != null ? Math.round(params.customerKilometers * ratio) : null,
      customerKilometersCents: params?.customerKilometersCents != null ? Math.round(params.customerKilometersCents * ratio) : null,
    };

    const result = await d.insert(budgetTransactions).values(txData).returning();
    if (result[0]) transactions.push(result[0]);

    totalConsumedAmount += remaining;
    remaining = 0;
  }

  return { consumedCents: totalConsumedAmount, transactions, remainingCents: amountCents - totalConsumedAmount };
}

export async function createCascadeConsumption(params: {
  customerId: number;
  appointmentId: number;
  transactionDate: string;
  totalAmountCents: number;
  hauswirtschaftMinutes: number;
  hauswirtschaftCents: number;
  alltagsbegleitungMinutes: number;
  alltagsbegleitungCents: number;
  travelKilometers: number;
  travelCents: number;
  customerKilometers: number;
  customerKilometersCents: number;
  userId?: number;
  skipExistingCheck?: boolean;
}, outerTx?: DbClient): Promise<CascadeResult> {
  const doWork = async (tx: DbClient) => {
    if (!params.skipExistingCheck) {
      const existingTransaction = await getTransactionByAppointmentId(params.appointmentId, tx);
      if (existingTransaction) {
        throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
      }
    }

    const typeSettings = await getBudgetTypeSettings(params.customerId, tx);

    await syncCarryoverAndExpiry(params.customerId, tx);

    const defaultPriority: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null }> = [
      { budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null },
    ];

    let priorityOrder: Array<{ budgetType: string; enabled: boolean; monthlyLimitCents: number | null; yearlyLimitCents: number | null; validFrom: string | null; validTo: string | null }>;

    if (typeSettings.length > 0) {
      const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));
      priorityOrder = defaultPriority.map(d => {
        const s = settingsMap.get(d.budgetType);
        return {
          budgetType: d.budgetType,
          enabled: s ? s.enabled : d.enabled,
          monthlyLimitCents: s ? s.monthlyLimitCents : d.monthlyLimitCents,
          yearlyLimitCents: s?.yearlyLimitCents ?? null,
          validFrom: s?.validFrom ?? null,
          validTo: s?.validTo ?? null,
        };
      });
      priorityOrder.sort((a, b) => {
        const aPrio = settingsMap.get(a.budgetType)?.priority ?? defaultPriority.find(d => d.budgetType === a.budgetType)!.priority;
        const bPrio = settingsMap.get(b.budgetType)?.priority ?? defaultPriority.find(d => d.budgetType === b.budgetType)!.priority;
        return aPrio - bPrio;
      });
    } else {
      const preferences = await getBudgetPreferences(params.customerId, tx);
      priorityOrder = defaultPriority.map(d => ({
        ...d,
        monthlyLimitCents: d.budgetType === "entlastungsbetrag_45b" ? (preferences?.monthlyLimitCents ?? null) : null,
        yearlyLimitCents: null,
        validFrom: null,
        validTo: null,
      }));
    }

    let remaining = params.totalAmountCents;
    const allTransactions: BudgetTransaction[] = [];
    const breakdown: Array<{ budgetType: string; consumedCents: number }> = [];

    for (const pot of priorityOrder) {
      if (remaining <= 0) break;
      if (!pot.enabled) {
        breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
        continue;
      }

      if (pot.validFrom && params.transactionDate < pot.validFrom) {
        breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
        continue;
      }
      if (pot.validTo && params.transactionDate > pot.validTo) {
        breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
        continue;
      }

      let maxConsumable = remaining;

      const isMonthlyBudget = pot.budgetType === "entlastungsbetrag_45b" || pot.budgetType === "umwandlung_45a";
      if (isMonthlyBudget && pot.monthlyLimitCents !== null) {
        const txDate = parseLocalDate(params.transactionDate);
        const txYear = txDate.getFullYear();
        const txMonth = txDate.getMonth() + 1;
        const currentMonthStart = `${txYear}-${String(txMonth).padStart(2, '0')}-01`;
        const lastDay = new Date(txYear, txMonth, 0).getDate();
        const currentMonthEnd = `${txYear}-${String(txMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const monthConsumptions = await tx.select({
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, params.customerId),
            eq(budgetTransactions.budgetType, pot.budgetType),
            eq(budgetTransactions.transactionType, "consumption"),
            gte(budgetTransactions.transactionDate, currentMonthStart),
            lte(budgetTransactions.transactionDate, currentMonthEnd)
          ));

        const monthReversals = await tx.select({
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, params.customerId),
            eq(budgetTransactions.budgetType, pot.budgetType),
            eq(budgetTransactions.transactionType, "reversal"),
            gte(budgetTransactions.transactionDate, currentMonthStart),
            lte(budgetTransactions.transactionDate, currentMonthEnd)
          ));

        const alreadyUsedThisMonth = Math.max(0, Number(monthConsumptions[0]?.total ?? 0) - Number(monthReversals[0]?.total ?? 0));

        let effectiveMonthlyLimit = pot.monthlyLimitCents;
        if (pot.budgetType === "entlastungsbetrag_45b") {
          const totalCarryover = await getTotalCarryoverCents(params.customerId, params.transactionDate, tx);
          effectiveMonthlyLimit = pot.monthlyLimitCents + totalCarryover;
        }

        const monthlyRemaining = Math.max(0, effectiveMonthlyLimit - alreadyUsedThisMonth);
        maxConsumable = Math.min(remaining, monthlyRemaining);
      }

      if (pot.budgetType === "ersatzpflege_39_42a" && pot.yearlyLimitCents !== null) {
        const txDate = parseLocalDate(params.transactionDate);
        const txYear = txDate.getFullYear();
        const yearStart = `${txYear}-01-01`;
        const yearEnd = `${txYear}-12-31`;

        const yearConsumptions = await tx.select({
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, params.customerId),
            eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
            eq(budgetTransactions.transactionType, "consumption"),
            gte(budgetTransactions.transactionDate, yearStart),
            lte(budgetTransactions.transactionDate, yearEnd)
          ));

        const yearReversals = await tx.select({
          total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
        })
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.customerId, params.customerId),
            eq(budgetTransactions.budgetType, "ersatzpflege_39_42a"),
            eq(budgetTransactions.transactionType, "reversal"),
            gte(budgetTransactions.transactionDate, yearStart),
            lte(budgetTransactions.transactionDate, yearEnd)
          ));

        const alreadyUsedThisYear = Math.max(0, Number(yearConsumptions[0]?.total ?? 0) - Number(yearReversals[0]?.total ?? 0));
        const yearlyRemaining = Math.max(0, pot.yearlyLimitCents - alreadyUsedThisYear);
        maxConsumable = Math.min(maxConsumable, yearlyRemaining);
      }

      if (maxConsumable <= 0) {
        breakdown.push({ budgetType: pot.budgetType, consumedCents: 0 });
        continue;
      }

      const isFirstPot = allTransactions.length === 0;
      const fifoResult = await consumeFifo(
        params.customerId,
        pot.budgetType,
        maxConsumable,
        params.transactionDate,
        isFirstPot ? {
          appointmentId: params.appointmentId,
          userId: params.userId,
          hauswirtschaftMinutes: params.hauswirtschaftMinutes,
          hauswirtschaftCents: params.hauswirtschaftCents,
          alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
          alltagsbegleitungCents: params.alltagsbegleitungCents,
          travelKilometers: params.travelKilometers,
          travelCents: params.travelCents,
          customerKilometers: params.customerKilometers,
          customerKilometersCents: params.customerKilometersCents,
        } : {
          appointmentId: params.appointmentId,
          userId: params.userId,
        },
        tx
      );

      allTransactions.push(...fifoResult.transactions);
      remaining -= fifoResult.consumedCents;
      breakdown.push({ budgetType: pot.budgetType, consumedCents: fifoResult.consumedCents });
    }

    return {
      transactions: allTransactions,
      totalConsumedCents: params.totalAmountCents - remaining,
      outstandingCents: remaining,
      breakdown,
    };
  };

  if (outerTx) {
    return await doWork(outerTx);
  }
  return await db.transaction(async (tx: DbClient) => doWork(tx));
}

export async function createConsumptionTransaction(params: {
  customerId: number;
  appointmentId: number;
  transactionDate: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  userId?: number;
}, outerTx?: DbClient): Promise<BudgetTransaction> {
  const client = outerTx || db;
  const costs = await calculateAppointmentCost({
    customerId: params.customerId,
    hauswirtschaftMinutes: params.hauswirtschaftMinutes,
    alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
    travelKilometers: params.travelKilometers,
    customerKilometers: params.customerKilometers,
    date: params.transactionDate,
  });

  const [customer] = await client.select({ acceptsPrivatePayment: customers.acceptsPrivatePayment })
    .from(customers).where(eq(customers.id, params.customerId)).limit(1);
  const acceptsPrivatePayment = customer?.acceptsPrivatePayment ?? false;

  const hasUsage = costs.totalCents > 0;
  if (!hasUsage) {
    const cascadeResult = await createCascadeConsumption({
      customerId: params.customerId,
      appointmentId: params.appointmentId,
      transactionDate: params.transactionDate,
      totalAmountCents: 0,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      hauswirtschaftCents: 0,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      alltagsbegleitungCents: 0,
      travelKilometers: 0,
      travelCents: 0,
      customerKilometers: 0,
      customerKilometersCents: 0,
      userId: params.userId,
    }, outerTx);
    return cascadeResult.transactions[0];
  }

  const doWork = async (tx: DbClient) => {
    await (tx as typeof db).execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(params.customerId))})`);

    if (!acceptsPrivatePayment) {
      const summaries = await getAllBudgetSummaries(params.customerId);
      const typeSettings = await getBudgetTypeSettings(params.customerId);

      let total45b = summaries.entlastungsbetrag45b.availableCents;
      let total45a = summaries.umwandlung45a.currentMonthAvailableCents;
      let total39_42a = summaries.ersatzpflege39_42a.currentYearAvailableCents;

      if (typeSettings.length > 0) {
        const settingsMap = new Map(typeSettings.map(s => [s.budgetType, s]));
        const s45b = settingsMap.get("entlastungsbetrag_45b");
        if (s45b && !s45b.enabled) total45b = 0;
        const s45a = settingsMap.get("umwandlung_45a");
        if (s45a && !s45a.enabled) total45a = 0;
        const s39 = settingsMap.get("ersatzpflege_39_42a");
        if (s39 && !s39.enabled) total39_42a = 0;
      }

      const totalAvailable = total45a + total45b + total39_42a;

      if (costs.totalCents > totalAvailable) {
        const shortfall = costs.totalCents - totalAvailable;
        const shortfallEuro = (shortfall / 100).toFixed(2).replace(".", ",");
        throw new Error(
          `Budget reicht nicht — es fehlen ${shortfallEuro} €. Kunde akzeptiert keine Privatzahlung.`
        );
      }
    }

    const cascadeResult = await createCascadeConsumption({
      customerId: params.customerId,
      appointmentId: params.appointmentId,
      transactionDate: params.transactionDate,
      totalAmountCents: costs.totalCents,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      hauswirtschaftCents: costs.hauswirtschaftCents,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      alltagsbegleitungCents: costs.alltagsbegleitungCents,
      travelKilometers: params.travelKilometers,
      travelCents: costs.travelCents,
      customerKilometers: params.customerKilometers,
      customerKilometersCents: costs.customerKilometersCents,
      userId: params.userId,
    }, tx);

    if (cascadeResult.outstandingCents > 0) {
      if (acceptsPrivatePayment) {
        const privateRatio = costs.totalCents > 0 ? cascadeResult.outstandingCents / costs.totalCents : 1;
        const [privateTransaction] = await tx.insert(budgetTransactions).values({
          customerId: params.customerId,
          budgetType: "private",
          transactionDate: params.transactionDate,
          transactionType: "consumption",
          amountCents: -cascadeResult.outstandingCents,
          appointmentId: params.appointmentId,
          hauswirtschaftMinutes: Math.round(params.hauswirtschaftMinutes * privateRatio),
          hauswirtschaftCents: Math.round(costs.hauswirtschaftCents * privateRatio),
          alltagsbegleitungMinutes: Math.round(params.alltagsbegleitungMinutes * privateRatio),
          alltagsbegleitungCents: Math.round(costs.alltagsbegleitungCents * privateRatio),
          travelKilometers: Math.round(params.travelKilometers * privateRatio * 10) / 10,
          travelCents: Math.round(costs.travelCents * privateRatio),
          customerKilometers: Math.round(params.customerKilometers * privateRatio * 10) / 10,
          customerKilometersCents: Math.round(costs.customerKilometersCents * privateRatio),
          createdByUserId: params.userId,
          notes: `Privatzahlung: ${(cascadeResult.outstandingCents / 100).toFixed(2)} €`,
        }).returning();
        return cascadeResult.transactions[0] ?? privateTransaction;
      }
      const shortfallEuro = (cascadeResult.outstandingCents / 100).toFixed(2).replace(".", ",");
      throw new Error(
        `Budget reicht nicht — es fehlen ${shortfallEuro} €. Kunde akzeptiert keine Privatzahlung.`
      );
    }

    return cascadeResult.transactions[0];
  };

  if (outerTx) {
    return await doWork(outerTx);
  }
  return await db.transaction(async (tx) => doWork(tx));
}
