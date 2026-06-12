import {
  budgetAllocations,
  budgetTransactions,
  customers,
  users,
  type BudgetTransaction,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lte, gte, isNull, or, asc, inArray } from "drizzle-orm";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient, CascadeResult } from "./types";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { getTransactionByAppointmentId } from "./transaction-storage";
import { getBudgetPreferences, readBudgetTypeSettings } from "./preferences-storage";
import { syncCarryoverAndExpiry, calculateAllocatedCents } from "./allocation-storage";
import { computeCapSlot, type CappedBudgetType } from "./cap-calculator";
import { effectiveDefaultPots } from "@shared/domain/budgets";
import { planCascade } from "@shared/domain/budget/plan-cascade";
import { BudgetHardBlockError } from "@shared/domain/budget/over-budget-error";
import { quantizeKm } from "@shared/domain/invoice-line-items";
import { formatEuroDE } from "@shared/utils/money";
import { budgetAllocationsRepo, customersRepo } from "../../repos";
import { auditService } from "../../services/audit";

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
  /**
   * Task #723 — Skalierungsnenner für die Service-Felder bei Cascade-Buchungen.
   * Wird vom Cascade-Pfad (createCascadeConsumption) als Termin-Gesamtkost
   * (`costs.totalCents`) gesetzt, damit Folge-Töpfe ihre Service-Felder
   * proportional zum Termin-Total (nicht zum Topf-Chunk) berechnen und in
   * Summe über alle Legs wieder die Termin-Werte ergeben. Wenn `undefined`,
   * fällt buildConsumptionTxData auf das Chunk-Argument als Nenner zurück
   * (Rebook-Pfad, Single-Pot-Konsumtion).
   */
  totalAmountCents?: number;
};

function buildConsumptionTxData(
  customerId: number,
  budgetType: string,
  transactionDate: string,
  amountCents: number,
  allocationId: number | null,
  chunkAmountCents: number,
  params?: ConsumptionParams,
): typeof budgetTransactions.$inferInsert {
  const hwSrc = params?.hauswirtschaftCents;
  const abSrc = params?.alltagsbegleitungCents;
  const tvSrc = params?.travelCents;
  const ckSrc = params?.customerKilometersCents;

  // Task #723 — Skalierungs-Nenner:
  // - Cascade-Pfad: `params.totalAmountCents` = Termin-Gesamtkost. Dadurch
  //   gilt ratio = legBetrag / Termin-Total, und die Summe der Service-Felder
  //   über ALLE Cascade-Töpfe (§45b + §45a + §39 + ggf. private) konvergiert
  //   gegen die Termin-Werte (mit Final-Reconcile gegen ≤(n-1)-Cent-Drift).
  // - Rebook/Single-Pot-Pfad: kein totalAmountCents → Fallback auf das
  //   übergebene Chunk-Argument (alte Semantik). Damit bleibt das Verhalten
  //   für `rebook-storage` unverändert.
  const consumeAbs = Math.abs(amountCents);
  const scaleDenom = params?.totalAmountCents && params.totalAmountCents > 0
    ? params.totalAmountCents
    : chunkAmountCents;
  const ratio = scaleDenom > 0 ? consumeAbs / scaleDenom : 0;

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
    // Task #616 — km wird mit derselben Quantisierung wie in den
    // Rechnungs-Line-Items (Task #561) gespeichert: 2 NK kaufmännisch
    // gerundet via `quantizeKm`. Vor #616 wurde hier auf 1 NK gerundet,
    // wodurch Budget-Ledger (`formatKm`, 2 NK seit #616) und gebuchte
    // km-Zahl auseinanderdriften konnten. Bei FIFO-Split (`ratio < 1`)
    // wird jedes Leg unabhängig quantisiert — die Summe darf um ≤0,01 km
    // von der Termin-km abweichen (Anzeige-Feld), der gebuchte Cent-Betrag
    // bleibt durch das Subtract-last-Pattern (Task #441) residuell exakt.
    travelKilometers: params?.travelKilometers != null ? quantizeKm(params.travelKilometers * ratio) : null,
    travelCents: tvCents,
    customerKilometers: params?.customerKilometers != null ? quantizeKm(params.customerKilometers * ratio) : null,
    customerKilometersCents: ckCents,
  };
}

/**
 * Task #871 — Read-only-Hälfte von `consumeFifo`: berechnet die FIFO-
 * Verfügbarkeit eines Topfes zum `transactionDate`, OHNE zu schreiben.
 *
 * Gibt `totalAvailable` (bis zum Datum aufgelaufene Allocation minus Netto-
 * Konsumtion, ≥0) plus die für die Spezial-Allocation-FIFO-Verteilung nötigen
 * Maps zurück. Dieselbe Logik wie der READ-Teil des alten `consumeFifo`
 * (vormals Zeilen 144–252) — extrahiert, damit `createCascadeConsumption` die
 * Topf-Kapazität VOR der `planCascade`-Entscheidung kennt, ohne zu buchen.
 */
type FifoAvailability = {
  totalAvailable: number;
  specialAllocations: Array<{ id: number; amountCents: number }>;
  consumedBySpecial: Map<number, number>;
  reversalBySpecial: Map<number, number>;
};

export async function computeFifoAvailability(
  customerId: number,
  budgetType: string,
  transactionDate: string,
  _tx?: DbClient,
): Promise<FifoAvailability> {
  const d = _tx ?? db;
  const today = transactionDate;

  const specialAllocations = await budgetAllocationsRepo.selectFrom(d)
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
  const historicalTypeSettings = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: today }, _tx);
  const totalAllocated = await calculateAllocatedCents(customerId, budgetType, { asOfDate: today }, _tx, undefined, historicalTypeSettings);

  if (totalAllocated <= 0 && specialAllocations.length === 0) {
    return { totalAvailable: 0, specialAllocations, consumedBySpecial: new Map(), reversalBySpecial: new Map() };
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

  return { totalAvailable, specialAllocations, consumedBySpecial, reversalBySpecial };
}

/**
 * Task #871 — Write-Hälfte von `consumeFifo`: bucht gegen eine VORAB berechnete
 * Verfügbarkeit (`computeFifoAvailability`), OHNE erneut zu lesen. Byte-
 * identisch zum WRITE-Teil des alten `consumeFifo` (vormals Zeilen 254–289):
 * begrenzt auf `min(amountCents, availability.totalAvailable)`, verteilt FIFO
 * über die Spezial-Allocations (carryover/initial/manual) und bucht den Rest
 * gegen `allocationId = null`.
 */
async function consumeFifoWithAvailability(
  availability: FifoAvailability,
  customerId: number,
  budgetType: string,
  amountCents: number,
  transactionDate: string,
  params: ConsumptionParams | undefined,
  d: DbClient,
): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }> {
  const { totalAvailable, specialAllocations, consumedBySpecial, reversalBySpecial } = availability;

  if (totalAvailable <= 0) {
    return { consumedCents: 0, transactions: [], remainingCents: amountCents };
  }

  let remaining = Math.min(amountCents, totalAvailable);
  let totalConsumedAmount = 0;
  const transactions: BudgetTransaction[] = [];

  for (const allocation of specialAllocations) {
    if (remaining <= 0) break;

    const consumed = consumedBySpecial.get(allocation.id) ?? 0;
    const reversed = reversalBySpecial.get(allocation.id) ?? 0;
    const netConsumed = Math.max(0, consumed - reversed);
    const available = Math.max(0, allocation.amountCents - netConsumed);

    if (available <= 0) continue;

    const consumeAmount = Math.min(remaining, available);

    const txData = buildConsumptionTxData(customerId, budgetType, transactionDate, -consumeAmount, allocation.id, amountCents, params);

    const result = await d.insert(budgetTransactions).values(txData).returning();
    if (result[0]) transactions.push(result[0]);

    remaining -= consumeAmount;
    totalConsumedAmount += consumeAmount;
  }

  if (remaining > 0) {
    const txData = buildConsumptionTxData(customerId, budgetType, transactionDate, -remaining, null, amountCents, params);

    const result = await d.insert(budgetTransactions).values(txData).returning();
    if (result[0]) transactions.push(result[0]);

    totalConsumedAmount += remaining;
    remaining = 0;
  }

  return { consumedCents: totalConsumedAmount, transactions, remainingCents: amountCents - totalConsumedAmount };
}

/**
 * FIFO-Konsumtion eines einzelnen Topfes: read (`computeFifoAvailability`) +
 * write (`consumeFifoWithAvailability`). Wrapper für alle Aufrufer, die in
 * EINEM Schritt lesen und buchen wollen (z.B. `rebook-storage`). Verhalten
 * unverändert gegenüber dem alten monolithischen `consumeFifo`.
 */
export async function consumeFifo(
  customerId: number,
  budgetType: string,
  amountCents: number,
  transactionDate: string,
  params?: ConsumptionParams,
  _tx?: DbClient
): Promise<{ consumedCents: number; transactions: BudgetTransaction[]; remainingCents: number }> {
  const d = _tx ?? db;
  const availability = await computeFifoAvailability(customerId, budgetType, transactionDate, _tx);
  return consumeFifoWithAvailability(availability, customerId, budgetType, amountCents, transactionDate, params, d);
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
  /**
   * Task #873 (Budget GF Phase 3) — optionaler privater Selbstzahler-Topf als
   * terminaler `uncapped`-Topf der Kaskade. Ist er gesetzt, hängt `planCascade`
   * ihn als letzten Topf an; er absorbiert den GESAMTEN Rest, sodass kein
   * `outstandingCents` entsteht (R7: seine Kapazität wird nie als Zahl gelesen).
   *  - `statutoryExcluded`: §45b/§45a/§39 komplett auslassen — reiner
   *    Selbstzahler bucht 100 % privat, selbst wenn (Migration/Drift) noch eine
   *    Pflegekassen-Allocation am Kunden hängt.
   *  - `noteKind`: Notiz-Variante der privaten Konsum-Zeile
   *    (`selbstzahler` → „Selbstzahler: …", `privatzahlung` → „Privatzahlung: …").
   */
  privatePot?: {
    statutoryExcluded: boolean;
    noteKind: "selbstzahler" | "privatzahlung";
  };
}, outerTx?: DbClient): Promise<CascadeResult> {
  const doWork = async (tx: DbClient) => {
    // Pro-Kunde-Advisory-Lock (Task #494): serialisiert ALLE Einstiegspunkte
    // in die Cascade-Konsumtion (inkl. direkter Aufrufe aus
    // `rebookDisabledBudgetTransactions`/`rebookSingleTransaction`) gegen
    // parallele Massen-Umbuchungen. Reentrant innerhalb derselben
    // Transaktion, daher unschädlich, wenn der äußere Aufrufer
    // (createConsumptionTransaction / rebook-storage) den Lock bereits
    // gehalten hat — der xact-Lock wird ohnehin am Commit/Rollback freigegeben.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${params.customerId}::text))`
    );

    if (!params.skipExistingCheck) {
      const existingTransaction = await getTransactionByAppointmentId(params.appointmentId, tx);
      if (existingTransaction) {
        throw new Error(`Für diesen Termin wurde bereits eine Budget-Abbuchung erstellt (Transaktion #${existingTransaction.id})`);
      }
    }

    // GoBD-Historisierung (Task #440): die Konfiguration, die zum
    // transactionDate gültig war, entscheidet — nicht die aktuelle.
    const typeSettings = await readBudgetTypeSettings(params.customerId, { kind: "forDate", asOfDate: params.transactionDate }, tx);

    await syncCarryoverAndExpiry(params.customerId, tx);

    // Task #441 / BUG-19 (Facette A) — Single Source of Truth aus
    // `shared/domain/budgets`. Keine hardcoded Reihenfolge mehr — alle Aufrufer
    // (Cascade, Preview, Reset-Flows) lesen über `effectiveDefaultPots`, das den
    // Selbstzahler-/Anspruchs-Gate anwendet. Ohne persistierte type-settings-Zeile
    // darf §45b so nicht fälschlich für Selbstzahler default-aktiv sein.
    const [defaultPotCustomer] = await customersRepo
      .selectColumnsFrom(
        {
          billingType: customers.billingType,
          pflegegrad: customers.pflegegrad,
        },
        tx,
      )
      .where(eq(customers.id, params.customerId))
      .limit(1);
    const defaultPriority: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents: number | null }> =
      effectiveDefaultPots({
        billingType: defaultPotCustomer?.billingType,
        pflegegrad: defaultPotCustomer?.pflegegrad,
      }).map(d => ({ ...d, monthlyLimitCents: null }));

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

    // Task #871 — Topf-Kaskade über die EINE pure `planCascade`-Funktion.
    //
    // Phase 1 (read-only): pro Topf die effektive Kapazität bestimmen
    //   - deaktiviert / außerhalb Gültigkeitsfenster → 0
    //   - gedeckelte Töpfe (§45a / §39+§42a) mit Cap → min(FIFO-Verfügbarkeit,
    //     Cap-Restslot via `computeCapSlot`, der SSoT der Cap-Mathematik)
    //   - sonst → FIFO-Verfügbarkeit (`computeFifoAvailability`)
    //   Die FIFO-Verfügbarkeit wird je Topf VORAB gelesen und für die Write-
    //   Phase aufbewahrt. Pro `budgetType` ist die Verfügbarkeit unabhängig von
    //   Buchungen anderer Töpfe, daher ist dieses Vorab-Lesen byte-identisch zur
    //   früheren just-in-time-Lesung innerhalb der Schleife.
    // Phase 2: `planCascade` verteilt die Termin-Kost deterministisch
    //   prioritäts-füllend auf die Töpfe (subtract-last, verlustfrei).
    // Phase 3 (write): pro Split > 0 gegen die vorab gelesene Verfügbarkeit
    //   buchen (`consumeFifoWithAvailability`).
    const cascadePots: Array<{ budgetType: string; capacityCents: number; uncapped?: boolean }> = [];
    const availabilityByType = new Map<string, FifoAvailability>();

    // Task #873 (Budget GF Phase 3): Reiner Selbstzahler bucht 100 % privat —
    // die statutorischen Töpfe werden komplett ausgelassen, selbst wenn noch
    // eine Pflegekassen-Allocation am Kunden hängt (Migration/Konfig-Drift).
    const statutoryExcluded = params.privatePot?.statutoryExcluded === true;

    for (const pot of (statutoryExcluded ? [] : priorityOrder)) {
      if (!pot.enabled) {
        cascadePots.push({ budgetType: pot.budgetType, capacityCents: 0 });
        continue;
      }
      if (pot.validFrom && params.transactionDate < pot.validFrom) {
        cascadePots.push({ budgetType: pot.budgetType, capacityCents: 0 });
        continue;
      }
      if (pot.validTo && params.transactionDate > pot.validTo) {
        cascadePots.push({ budgetType: pot.budgetType, capacityCents: 0 });
        continue;
      }

      const availability = await computeFifoAvailability(
        params.customerId,
        pot.budgetType,
        params.transactionDate,
        tx,
      );
      availabilityByType.set(pot.budgetType, availability);

      let capacity = availability.totalAvailable;

      // §45b ist standardmäßig ein Jahrestopf ohne Monats-Cap (Task #425): die
      // FIFO-Konsumtion wird nur durch die bis zum transactionDate aufgelaufene
      // Allocation begrenzt. Task #1171 (Audit-Ticket H) — ist für §45b jedoch
      // ein Monatslimit konfiguriert, greift derselbe Cap-SSoT (`computeCapSlot`)
      // wie für §45a/§39, sodass die Kaskade beim BUCHEN exakt dasselbe
      // Monatslimit respektiert wie die Anzeige (kein „Display ≠ Booking").
      const isCappedBudget =
        pot.budgetType === "umwandlung_45a" ||
        pot.budgetType === "ersatzpflege_39_42a" ||
        pot.budgetType === "entlastungsbetrag_45b";
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
        capacity = Math.min(capacity, cap.capRemainingCents);
      }

      cascadePots.push({ budgetType: pot.budgetType, capacityCents: capacity });
    }

    // Task #873 (Budget GF Phase 3): privater Selbstzahler-Topf als terminaler
    // `uncapped`-Topf. `planCascade` legt den GESAMTEN Rest hier ab; seine
    // `capacityCents` (0) wird NIE als Zahl gelesen (R7) — der uncapped-Zweig
    // ignoriert die Kapazität vollständig.
    if (params.privatePot) {
      cascadePots.push({ budgetType: "private", capacityCents: 0, uncapped: true });
    }

    const plan = planCascade(params.totalAmountCents, cascadePots);

    const allTransactions: BudgetTransaction[] = [];
    const breakdown: Array<{ budgetType: string; consumedCents: number }> = [];

    for (const split of plan.splits) {
      if (split.amountCents <= 0) {
        breakdown.push({ budgetType: split.budgetType, consumedCents: 0 });
        continue;
      }

      // Task #873 (Budget GF Phase 3): der private (uncapped) Topf hat keine
      // Allocation/FIFO — er wird als EINE private Konsum-Zeile gebucht. Die
      // Service-Felder skaliert derselbe `buildConsumptionTxData`-Pfad wie die
      // statutorischen Legs (ratio = Leg-Betrag / Termin-Total), sodass die
      // Ausgabe byte-identisch zum alten Selbstzahler-Fast-Path bzw.
      // Privatzahlungs-Overflow ist (I6). Bei vollständiger Deckung
      // (outstanding === 0) gleicht der Final-Reconcile unten die ≤(n-1)-Cent-
      // Drift auch über die private Zeile aus.
      if (split.uncapped) {
        const notePrefix =
          params.privatePot?.noteKind === "selbstzahler" ? "Selbstzahler" : "Privatzahlung";
        const privateTxData = buildConsumptionTxData(
          params.customerId,
          "private",
          params.transactionDate,
          -split.amountCents,
          null,
          split.amountCents,
          {
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
            totalAmountCents: params.totalAmountCents,
            notes: `${notePrefix}: ${formatEuroDE(split.amountCents)}`,
          },
        );
        const [privateTx] = await tx.insert(budgetTransactions).values(privateTxData).returning();
        if (privateTx) allTransactions.push(privateTx);
        breakdown.push({ budgetType: split.budgetType, consumedCents: split.amountCents });
        continue;
      }

      const availability = availabilityByType.get(split.budgetType)!;

      // Task #723 — Service-Felder werden in JEDEN Cascade-Topf gegeben
      // (nicht nur in den ersten). Vor #723 bekamen Folge-Töpfe nur
      // `{appointmentId,userId}` → ihre hwCents/abCents/tvCents/ckCents
      // landeten als NULL in der DB, sodass Σ über alle Legs ≠
      // appointment.<feld>Cents war (Lexware-Export, §45b-Anzeige und
      // Statistik addieren diese Spalten). Mit `totalAmountCents` als
      // Skalierungs-Nenner berechnet `buildConsumptionTxData` pro Leg
      // ratio = legBetrag / Termin-Total, und der Final-Reconcile am
      // Cascade-Ende (siehe unten) absorbiert verbleibende Cent-Drift.
      const fifoResult = await consumeFifoWithAvailability(
        availability,
        params.customerId,
        split.budgetType,
        split.amountCents,
        params.transactionDate,
        {
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
          totalAmountCents: params.totalAmountCents,
        },
        tx,
      );

      allTransactions.push(...fifoResult.transactions);
      breakdown.push({ budgetType: split.budgetType, consumedCents: fifoResult.consumedCents });
    }

    const remaining = plan.outstandingCents;

    // Task #723 — Final-Reconcile gegen Rest-Drift:
    // Wenn die Cascade den Termin vollständig abgedeckt hat (kein offener
    // Rest), gleichen wir die ≤(n-1)-Cent-Rundungsdrift pro Service-Feld am
    // letzten eingefügten Leg aus. Seit Task #873 ist der private Selbstzahler-
    // Topf Teil der Kaskade (uncapped, terminal) — die private Zeile ist damit
    // im `allTransactions`-Array enthalten und wird vom Reconcile miterfasst.
    // Bleibt ein Rest (`remaining > 0`), gibt es KEINEN privaten Topf
    // (Pflegekasse ohne Privatzahlung) → der Aufrufer wirft den Hard-Block.
    if (remaining === 0 && allTransactions.length > 0) {
      await reconcileAppointmentLegFieldDrift(
        tx,
        allTransactions,
        {
          hauswirtschaftCents: params.hauswirtschaftCents,
          alltagsbegleitungCents: params.alltagsbegleitungCents,
          travelCents: params.travelCents,
          customerKilometersCents: params.customerKilometersCents,
        },
        {
          customerId: params.customerId,
          appointmentId: params.appointmentId,
          userId: params.userId,
        },
      );
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

/**
 * Task #723 — Final-Reconcile: Σ Service-Feld pro Termin = appointment-Wert.
 *
 * Der Cascade-Pfad rundet jedes Leg unabhängig (ratio = legBetrag / Termin-
 * Total) und wendet dann pro Tx Subtract-Last gegen die Betragsdrift an
 * (Task #441). Über mehrere Legs hinweg kann die Summe pro Service-Feld
 * dennoch um ≤(n-1) Cent vom Termin-Wert abweichen — diese Drift wird hier
 * komplett auf das jeweils letzte Konsum-Tx desselben Termins gebucht.
 *
 * Invariante nach Aufruf:
 *   Σ hauswirtschaftCents      = full.hauswirtschaftCents
 *   Σ alltagsbegleitungCents   = full.alltagsbegleitungCents
 *   Σ travelCents              = full.travelCents
 *   Σ customerKilometersCents  = full.customerKilometersCents
 *
 * Schutz: nur wenn Σ Δ über alle Felder = 0 (sonst würde sich die pro-Tx-
 * Betragsinvariante verschieben). Σ Δ = 0 ist garantiert, sobald der
 * Cascade-Pfad das Termin-Total vollständig konsumiert hat (kein
 * Outstanding) — der Aufrufer muss das sicherstellen.
 */
async function reconcileAppointmentLegFieldDrift(
  tx: DbClient,
  appointmentTxs: BudgetTransaction[],
  full: {
    hauswirtschaftCents: number;
    alltagsbegleitungCents: number;
    travelCents: number;
    customerKilometersCents: number;
  },
  ctx: { customerId: number; appointmentId: number; userId?: number },
): Promise<void> {
  const consumptions = appointmentTxs.filter(
    (t) => t.transactionType === "consumption",
  );
  if (consumptions.length === 0) return;

  let sumHw = 0;
  let sumAb = 0;
  let sumTv = 0;
  let sumCk = 0;
  for (const t of consumptions) {
    sumHw += t.hauswirtschaftCents ?? 0;
    sumAb += t.alltagsbegleitungCents ?? 0;
    sumTv += t.travelCents ?? 0;
    sumCk += t.customerKilometersCents ?? 0;
  }

  const dHw = full.hauswirtschaftCents - sumHw;
  const dAb = full.alltagsbegleitungCents - sumAb;
  const dTv = full.travelCents - sumTv;
  const dCk = full.customerKilometersCents - sumCk;

  if (dHw === 0 && dAb === 0 && dTv === 0 && dCk === 0) return;

  // Schutz: Σ Δ muss 0 sein, sonst verschiebt der UPDATE die pro-Tx-
  // Betragsinvariante. Bei Drift ≠ 0 liegt eine tiefere Inkonsistenz vor
  // (Cascade hat nicht vollständig konsumiert) — wir korrigieren bewusst
  // NICHT (das würde die pro-Tx-Betragsinvariante brechen). Statt die
  // Anomalie wie früher lautlos zu verschlucken (Befund C-02), wird sie mit
  // vollem Kontext in `audit_log` protokolliert; die Buchung selbst bleibt
  // unverändert.
  if (dHw + dAb + dTv + dCk !== 0) {
    await logReconcileSkip(tx, ctx, {
      expected: full,
      actual: {
        hauswirtschaftCents: sumHw,
        alltagsbegleitungCents: sumAb,
        travelCents: sumTv,
        customerKilometersCents: sumCk,
      },
      deltas: {
        hauswirtschaftCents: dHw,
        alltagsbegleitungCents: dAb,
        travelCents: dTv,
        customerKilometersCents: dCk,
      },
      deltaSumCents: dHw + dAb + dTv + dCk,
      consumptionTxIds: consumptions.map((c) => c.id),
    });
    return;
  }

  const last = consumptions[consumptions.length - 1];
  const newHw = (last.hauswirtschaftCents ?? 0) + dHw;
  const newAb = (last.alltagsbegleitungCents ?? 0) + dAb;
  const newTv = (last.travelCents ?? 0) + dTv;
  const newCk = (last.customerKilometersCents ?? 0) + dCk;

  await tx
    .update(budgetTransactions)
    .set({
      hauswirtschaftCents: newHw,
      alltagsbegleitungCents: newAb,
      travelCents: newTv,
      customerKilometersCents: newCk,
    })
    .where(eq(budgetTransactions.id, last.id));

  // In-Memory-Repräsentation aktualisieren, damit nachgelagerte Aufrufer
  // (z.B. `createConsumptionTransaction`-Rückgabewert) den Zustand der DB
  // sehen.
  (last as { hauswirtschaftCents: number | null }).hauswirtschaftCents = newHw;
  (last as { alltagsbegleitungCents: number | null }).alltagsbegleitungCents = newAb;
  (last as { travelCents: number | null }).travelCents = newTv;
  (last as { customerKilometersCents: number | null }).customerKilometersCents = newCk;
}

/**
 * Befund C-02 — protokolliert den Fall, dass der Final-Reconcile eine
 * Service-Feld-Drift mit Σ Δ ≠ 0 vorfindet (tiefere Inkonsistenz: die Cascade
 * hat den Termin nicht vollständig konsumiert). Dieser Zweig korrigiert
 * absichtlich NICHTS und mutiert keine Buchung — er schreibt nur einen
 * Audit-Eintrag mit vollem Kontext, damit die Anomalie nicht mehr lautlos
 * verschwindet.
 *
 * Best-Effort (kein `exec=tx`): Ein gestörter Audit-Insert darf die bereits
 * gebuchte Konsumtion NICHT zurückrollen. `auditService.log` ohne `exec`
 * schluckt Fehler intern und schreibt nur in die Konsole — passend für reine
 * Beobachtbarkeit ohne begleitende Mutation.
 *
 * Bekannte Grenze: Der Insert committet auf einer eigenen Verbindung, während
 * die äußere Buchungs-Tx noch offen ist. Rollt diese später zurück (z.B. in
 * `rebookDisabledBudgetTransactions`, das viele Buchungen in EINER Tx schleift),
 * bleibt ein Eintrag stehen, der „Anomalie BEOBACHTET" bedeutet — nicht
 * „Anomalie committet". Für einen Anomalie-Melder ist das akzeptabel.
 */
async function logReconcileSkip(
  tx: DbClient,
  ctx: { customerId: number; appointmentId: number; userId?: number },
  detail: {
    expected: {
      hauswirtschaftCents: number;
      alltagsbegleitungCents: number;
      travelCents: number;
      customerKilometersCents: number;
    };
    actual: {
      hauswirtschaftCents: number;
      alltagsbegleitungCents: number;
      travelCents: number;
      customerKilometersCents: number;
    };
    deltas: {
      hauswirtschaftCents: number;
      alltagsbegleitungCents: number;
      travelCents: number;
      customerKilometersCents: number;
    };
    deltaSumCents: number;
    consumptionTxIds: number[];
  },
): Promise<void> {
  let actorUserId = ctx.userId ?? null;
  if (actorUserId == null) {
    // Kein expliziter Aufrufer (z.B. System-/Backfill-Pfad): ältesten aktiven
    // Benutzer als System-Actor nehmen, damit die NOT-NULL-FK auf `users` hält.
    const [sys] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorUserId = sys?.id ?? null;
  }
  if (actorUserId == null) {
    console.error(
      "[reconcileAppointmentLegFieldDrift] C-02 Skip ohne auflösbaren Audit-Actor",
      { ...ctx, ...detail },
    );
    return;
  }

  await auditService.log(
    actorUserId,
    "budget_reconcile_skipped",
    "appointment",
    ctx.appointmentId,
    {
      customerId: ctx.customerId,
      reason: "leg_field_drift_sum_nonzero",
      ...detail,
    },
  );
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

    const [customer] = await customersRepo
      .selectColumnsFrom(
        {
          acceptsPrivatePayment: customers.acceptsPrivatePayment,
          billingType: customers.billingType,
        },
        tx,
      )
      .where(eq(customers.id, params.customerId))
      .limit(1);
    // Task #588: `selbstzahler` ist die kanonische Quelle dafür, dass der
    // Kunde grundsätzlich privat zahlt — unabhängig vom Flag
    // `acceptsPrivatePayment`, das im UI für Selbstzahler gar nicht setzbar
    // ist und per Default `false` bleibt.
    const isSelbstzahler = customer?.billingType === "selbstzahler";
    const isPrivateAllowed =
      (customer?.acceptsPrivatePayment ?? false) || isSelbstzahler;

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

    // Task #873 (Budget GF Phase 3): EIN Buchungspfad für ALLE Kunden über die
    // pure `planCascade`. Der Selbstzahler-Fast-Path und der separate
    // Privatzahlungs-Overflow-Zweig sind entfallen; stattdessen entscheidet
    // `privatePot`, ob die Kaskade in einem `uncapped`-Privattopf endet:
    //   - Selbstzahler        → nur der private (uncapped) Topf, §45b/§45a/§39
    //                           werden ausgelassen (100 % privat, Note
    //                           „Selbstzahler: …").
    //   - Pflegekasse + privat → statutorische Töpfe + uncapped Privattopf, der
    //                           den Rest absorbiert (Note „Privatzahlung: …").
    //   - Pflegekasse o. privat → KEIN privater Topf; bleibt ein Rest, wirft die
    //                           Kaskade über `BudgetHardBlockError` (I5).
    const privatePot = isSelbstzahler
      ? { statutoryExcluded: true, noteKind: "selbstzahler" as const }
      : isPrivateAllowed
        ? { statutoryExcluded: false, noteKind: "privatzahlung" as const }
        : undefined;

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
      privatePot,
    }, tx);

    if (cascadeResult.outstandingCents > 0) {
      // Kann nur eintreten, wenn KEIN privater (uncapped) Topf vorhanden war
      // (Pflegekasse ohne Privatzahlung) und die statutorischen Töpfe nicht
      // ausreichten. Der Throw rollt die gesamte `doWork`-Transaktion zurück,
      // sodass die bereits geschriebenen statutorischen Legs nicht persistiert
      // werden (gleiches Verhalten wie der frühere Pre-Check).
      throw new BudgetHardBlockError(cascadeResult.outstandingCents);
    }

    return cascadeResult.transactions[0];
  };

  if (outerTx) {
    return await doWork(outerTx);
  }
  return await db.transaction(async (tx) => doWork(tx));
}
