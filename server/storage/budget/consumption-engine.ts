import {
  budgetAllocations,
  budgetTransactions,
  customers,
  type BudgetTransaction,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, asc, inArray } from "drizzle-orm";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient, CascadeResult } from "./types";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { getTransactionByAppointmentId } from "./transaction-storage";
import { getBudgetPreferences, getActiveBudgetTypeSettings } from "./preferences-storage";
import { syncCarryoverAndExpiry, calculateAllocatedCents } from "./allocation-storage";
import { computeCapSlot, type CappedBudgetType } from "./cap-calculator";
import { getAvailableForDate } from "./import-availability";
import { DEFAULT_BUDGET_POT_ORDER } from "@shared/domain/budgets";
import { formatEuroDE } from "@shared/utils/money";

type ConsumptionParams = {
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
};

function buildConsumptionTxData(
  customerId: number,
  budgetType: string,
  transactionDate: string,
  amountCents: number,
  allocationId: number | null,
  ratio: number,
  params?: ConsumptionParams,
): typeof budgetTransactions.$inferInsert {
  const hwSrc = params?.hauswirtschaftCents;
  const abSrc = params?.alltagsbegleitungCents;
  const tvSrc = params?.travelCents;
  const ckSrc = params?.customerKilometersCents;

  let hwCents = hwSrc != null ? Math.round(hwSrc * ratio) : null;
  let abCents = abSrc != null ? Math.round(abSrc * ratio) : null;
  let tvCents = tvSrc != null ? Math.round(tvSrc * ratio) : null;
  let ckCents = ckSrc != null ? Math.round(ckSrc * ratio) : null;

  // Task #441 — Subtract-last gegen Rundungsdrift.
  // Bei ratiometrischer Aufteilung (FIFO-Split / Cap-Limit) wird jeder Leg-
  // Posten unabhängig gerundet; in Summe driftet das um bis zu 1 Cent pro
  // Leg, d.h. `Σlegs` kann von `|amountCents|` abweichen. Statistik-,
  // Lexware- und Anzeige-Auswertungen summieren jedoch die Bein-Spalten und
  // erwarten exakt den gebuchten Betrag. Wir setzen daher die letzte gesetzte
  // Spalte (Customer-KM-Cents zuerst, dann Travel, Alltag, Hauswirtschaft) als
  // Residuum, sodass `hwCents + abCents + tvCents + ckCents === |amountCents|`.
  // Bedingung: mindestens eine Leg-Quelle ist gesetzt. Cascade-Folgetöpfe
  // ohne Leg-Daten (nur appointmentId/userId) bleiben unverändert null.
  if (hwCents != null || abCents != null || tvCents != null || ckCents != null) {
    const consumedAbs = Math.abs(amountCents);
    const sumOf = (a: number | null) => a ?? 0;
    if (ckCents != null) {
      ckCents = consumedAbs - sumOf(hwCents) - sumOf(abCents) - sumOf(tvCents);
    } else if (tvCents != null) {
      tvCents = consumedAbs - sumOf(hwCents) - sumOf(abCents);
    } else if (abCents != null) {
      abCents = consumedAbs - sumOf(hwCents);
    } else if (hwCents != null) {
      hwCents = consumedAbs;
    }
  }

  return {
    customerId,
    budgetType,
    transactionDate,
    transactionType: "consumption",
    amountCents,
    allocationId,
    appointmentId: params?.appointmentId ?? null,
    notes: params?.notes ?? null,
    createdByUserId: params?.userId,
    hauswirtschaftMinutes: params?.hauswirtschaftMinutes != null ? Math.round(params.hauswirtschaftMinutes * ratio) : null,
    hauswirtschaftCents: hwCents,
    alltagsbegleitungMinutes: params?.alltagsbegleitungMinutes != null ? Math.round(params.alltagsbegleitungMinutes * ratio) : null,
    alltagsbegleitungCents: abCents,
    travelKilometers: params?.travelKilometers != null ? Math.round(params.travelKilometers * ratio) : null,
    travelCents: tvCents,
    customerKilometers: params?.customerKilometers != null ? Math.round(params.customerKilometers * ratio) : null,
    customerKilometersCents: ckCents,
  };
}

export async function consumeFifo(
  customerId: number,
  budgetType: string,
  amountCents: number,
  transactionDate: string,
  params?: ConsumptionParams,
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

  // §45b ist seit Task #425 ein Jahrestopf: Verfügbarkeit = bis zum
  // transactionDate aufgelaufene Allocation. Vor #425 wurde todayISO()
  // genommen, was Vormonats-Buchungen fälschlich künstlich erweitert hätte.
  // Task #440: Topf-Einstellungen aus Sicht von `transactionDate` laden
  // (append-only Historisierung), damit Buchungen NIE die heutige Konfiguration
  // für ein historisches Datum verwenden.
  const historicalTypeSettings = await getActiveBudgetTypeSettings(customerId, today, _tx);
  const totalAllocated = await calculateAllocatedCents(customerId, budgetType, { asOfDate: today }, _tx, undefined, historicalTypeSettings);

  if (totalAllocated <= 0 && specialAllocations.length === 0) {
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
  } else if (budgetType === "entlastungsbetrag_45b") {
    // §45b Jahrestopf (Task #425): nur Konsumtionen bis zum transactionDate
    // gegen die bis dahin aufgelaufene Allocation rechnen, damit spätere
    // Buchungen nicht die Verfügbarkeit für ein früheres Datum reduzieren.
    txDateFilters.push(lte(budgetTransactions.transactionDate, today));
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
  const totalAvailable = Math.max(0, totalAllocated - totalNetConsumed);

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

    const txData = buildConsumptionTxData(customerId, budgetType, transactionDate, -consumeAmount, allocation.id, ratio, params);

    const result = await d.insert(budgetTransactions).values(txData).returning();
    if (result[0]) transactions.push(result[0]);

    remaining -= consumeAmount;
    totalConsumedAmount += consumeAmount;
    isFirstTransaction = false;
  }

  if (remaining > 0) {
    const ratio = params && amountCents > 0 ? remaining / amountCents : (isFirstTransaction ? 1 : 0);

    const txData = buildConsumptionTxData(customerId, budgetType, transactionDate, -remaining, null, ratio, params);

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

    // GoBD-Historisierung (Task #440): die Konfiguration, die zum
    // transactionDate gültig war, entscheidet — nicht die aktuelle.
    const typeSettings = await getActiveBudgetTypeSettings(params.customerId, params.transactionDate, tx);

    await syncCarryoverAndExpiry(params.customerId, tx);

    // Task #441 — Single Source of Truth aus `shared/domain/budgets`.
    // Keine hardcoded Reihenfolge mehr — alle Aufrufer (Cascade, Preview,
    // Reset-Flows) lesen aus `DEFAULT_BUDGET_POT_ORDER`.
    const defaultPriority: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null }> =
      DEFAULT_BUDGET_POT_ORDER.map(d => ({ ...d, monthlyLimitCents: null }));

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

      // §45b ist seit Task #425 ein Jahrestopf ohne Monats-Cap. Die FIFO-
      // Konsumtion wird nur durch die bis zum transactionDate aufgelaufene
      // Allocation (siehe calculateAllocated45b) begrenzt — kein zusätzlicher
      // Window-Cap mehr.
      const isCappedBudget =
        pot.budgetType === "umwandlung_45a" ||
        pot.budgetType === "ersatzpflege_39_42a";
      const hasCap =
        pot.monthlyLimitCents !== null || pot.yearlyLimitCents !== null;

      if (isCappedBudget && hasCap) {
        // Single source of truth for cap math — shared with the import-preview
        // path (`getAvailableForDate`) so preview and booking can never drift.
        const cap = await computeCapSlot({
          customerId: params.customerId,
          budgetType: pot.budgetType as CappedBudgetType,
          transactionDate: params.transactionDate,
          monthlyLimitCents: pot.monthlyLimitCents,
          yearlyLimitCents: pot.yearlyLimitCents,
        }, tx);
        maxConsumable = Math.min(remaining, cap.capRemainingCents);
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
  const doWork = async (tx: DbClient): Promise<BudgetTransaction> => {
    // Pro-Kunde-Advisory-Lock serialisiert konkurrierende Konsumbuchungen
    // (inklusive Cascade-Pfad mit Cost=0), damit das Budget nicht überbucht
    // werden kann. Namespace-Hash vermeidet Kollisionen mit anderen Locks,
    // die nur die rohe customerId verwenden.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${params.customerId}::text))`
    );

    const costs = await calculateAppointmentCost({
      customerId: params.customerId,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      travelKilometers: params.travelKilometers,
      customerKilometers: params.customerKilometers,
      date: params.transactionDate,
    });

    const [customer] = await tx.select({ acceptsPrivatePayment: customers.acceptsPrivatePayment })
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
      }, tx);
      return cascadeResult.transactions[0];
    }

    if (!acceptsPrivatePayment) {
      // Date-aware Vorabprüfung: §45b nutzt die bis zum transactionDate
      // aufgelaufene Allocation minus bereits gebuchter Beträge bis dahin
      // (Task #425). §45a/§39 nutzen ihren jeweiligen Window-Cap relativ
      // zum transactionDate. getAvailableForDate berücksichtigt
      // enabled/validFrom/validTo bereits.
      const availability = await getAvailableForDate(
        params.customerId,
        params.transactionDate,
        tx,
      );
      const totalAvailable = availability.totalCents;

      if (costs.totalCents > totalAvailable) {
        const shortfall = costs.totalCents - totalAvailable;
        throw new Error(
          `Budget reicht nicht — es fehlen ${formatEuroDE(shortfall)}. Kunde akzeptiert keine Privatzahlung.`
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
        const hwCents = Math.round(costs.hauswirtschaftCents * privateRatio);
        const abCents = Math.round(costs.alltagsbegleitungCents * privateRatio);
        const tvCents = Math.round(costs.travelCents * privateRatio);
        const ckCents = cascadeResult.outstandingCents - hwCents - abCents - tvCents;
        const [privateTransaction] = await tx.insert(budgetTransactions).values({
          customerId: params.customerId,
          budgetType: "private",
          transactionDate: params.transactionDate,
          transactionType: "consumption",
          amountCents: -cascadeResult.outstandingCents,
          appointmentId: params.appointmentId,
          hauswirtschaftMinutes: Math.round(params.hauswirtschaftMinutes * privateRatio),
          hauswirtschaftCents: hwCents,
          alltagsbegleitungMinutes: Math.round(params.alltagsbegleitungMinutes * privateRatio),
          alltagsbegleitungCents: abCents,
          travelKilometers: Math.round(params.travelKilometers * privateRatio * 10) / 10,
          travelCents: tvCents,
          customerKilometers: Math.round(params.customerKilometers * privateRatio * 10) / 10,
          customerKilometersCents: ckCents,
          createdByUserId: params.userId,
          notes: `Privatzahlung: ${formatEuroDE(cascadeResult.outstandingCents)}`,
        }).returning();
        return cascadeResult.transactions[0] ?? privateTransaction;
      }
      throw new Error(
        `Budget reicht nicht — es fehlen ${formatEuroDE(cascadeResult.outstandingCents)}. Kunde akzeptiert keine Privatzahlung.`
      );
    }

    return cascadeResult.transactions[0];
  };

  if (outerTx) {
    return await doWork(outerTx);
  }
  return await db.transaction(async (tx) => doWork(tx));
}
