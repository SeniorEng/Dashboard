import {
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
  customers,
  type BudgetAllocation,
  type InsertBudgetAllocation,
  type CustomerBudgetPreferences,
  type CustomerBudgetTypeSetting,
} from "@shared/schema";
import { eq, and, sql, lt, lte, gte, isNull, isNotNull, desc, asc, inArray, or } from "drizzle-orm";
import { todayISO, parseLocalDate, currentYearAndMonth, lastDayOfMonth, addDays } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS, floorAutoAnchor45bToCurrentYear, clampToStatutoryMax, resolve45aMonthlyLimitCents } from "@shared/domain/budgets";
import { enumerate45bStatutoryMonths, sum45bStatutoryMonths } from "@shared/domain/budget/statutory-45b";
import { resolve45bAnchor, initialBalanceMonthKeys, pickEffective45bSettingRow, effective45bSettingsWindow, shiftStartToSettings, clampEndToSettings } from "@shared/domain/budget/anchor-45b";
import { expiry45bFloorDateFor, carryoverExpiresAtFor } from "@shared/domain/budget/expiry-45b";
import { carryoverOutSollFor, carryoverTargetYear, type AllocRow } from "@shared/domain/budget/halfyear-45b";
// Re-Export: Bestands-Aufrufer (summary-queries) importieren die Funktion
// weiterhin von hier. Die Definition liegt jetzt in der SSoT.
export { pickEffective45bSettingRow };
import { formatEuroDE } from "@shared/utils/money";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { readBudgetTypeSettings } from "./preferences-storage";
import { getEarliestCareLevelStart } from "../customer-mgmt/care-level";
import {
  carryoverWindowFor,
  buildCarryoverDedupSets,
} from "@shared/domain/budget-carryover-dedup";
import { auditService } from "../../services/audit";
import { budgetAllocationsRepo, customersRepo } from "../../repos";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { SelbstzahlerStatutoryPotError } from "./preferences-storage";

const DEFAULT_MONTHLY_BUDGET_CENTS = BUDGET_45B_MAX_MONTHLY_CENTS;

/**
 * Task #1234 — Defense-in-Depth (Schwester zu Task #1233 auf dem
 * type-settings-Pfad): Selbstzahler (`billingType='selbstzahler'`) dürfen
 * NIE Geld aus einem gesetzlichen Pflegekassen-Topf (§45b/§45a/§39+§42a)
 * bekommen. Der type-settings-Schreibpfad (`upsertBudgetTypeSettings`) gatet
 * das bereits; dieselbe Invariante muss aber auch für die Allokations-/
 * Startwert-Schreibpfade gelten — ein direkter Storage-Aufrufer (Skript,
 * Import, künftige Route), der die Route umgeht, könnte sonst einen
 * gesetzlichen Startwert/Allokation auf einen Selbstzahler seeden und die
 * Invariante wieder aufweichen.
 *
 * Topf-Erkennung: ausschließlich über den SSoT-Validator
 * (`validateSelbstzahlerBudget`) — ein Probe-Aufruf mit
 * `billingType:"selbstzahler"` ist genau dann `!ok`, wenn der Topf ein
 * gesperrter gesetzlicher Topf ist (keine zweite Whitelist).
 *
 * Greift NICHT, wenn der Aufrufer `allowStatutoryForSelbstzahler` setzt
 * (legitime Korrektur-/Seed-/Migrations-Pfade) — identische Escape-Hatch-
 * Konvention wie auf dem type-settings-Pfad.
 */
async function assertSelbstzahlerStatutoryAllocationAllowed(
  customerId: number,
  budgetType: string,
  executor: DbClient,
  allow?: boolean,
): Promise<void> {
  if (allow) return;
  // Schneller Vorab-Check: handelt es sich überhaupt um einen gesetzlichen
  // Topf? Wenn nicht, ist nichts zu prüfen (kein DB-Roundtrip nötig).
  if (validateSelbstzahlerBudget({ billingType: "selbstzahler", intent: { budgetType } }).ok) {
    return;
  }
  const cust = await customersRepo.findByIdIncludingDeleted(customerId, executor);
  const v = validateSelbstzahlerBudget({
    billingType: cust?.billingType,
    intent: { budgetType },
  });
  if (!v.ok) throw new SelbstzahlerStatutoryPotError(v.message);
}

export async function createBudgetAllocation(
  allocation: InsertBudgetAllocation,
  userId?: number,
  tx?: DbClient,
  options?: { allowStatutoryForSelbstzahler?: boolean },
): Promise<BudgetAllocation> {
  const executor = tx ?? db;
  await assertSelbstzahlerStatutoryAllocationAllowed(
    allocation.customerId,
    allocation.budgetType,
    executor,
    options?.allowStatutoryForSelbstzahler,
  );
  const result = await executor.insert(budgetAllocations).values({
    ...allocation,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function getBudgetAllocations(customerId: number, year?: number): Promise<BudgetAllocation[]> {
  if (year) {
    return await budgetAllocationsRepo.selectFrom(db)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.year, year),
        isNull(budgetAllocations.deletedAt)
      ))
      .orderBy(asc(budgetAllocations.month), asc(budgetAllocations.validFrom));
  }
  return await budgetAllocationsRepo.selectFrom(db)
    .where(and(eq(budgetAllocations.customerId, customerId), isNull(budgetAllocations.deletedAt)))
    .orderBy(desc(budgetAllocations.year), asc(budgetAllocations.month));
}

export async function upsertInitialBalanceAllocation(
  params: { customerId: number; budgetType: string; year: number; month: number; amountCents: number; validFrom: string; expiresAt: string | null; notes?: string },
  userId?: number,
  tx?: DbClient,
  options?: { allowStatutoryForSelbstzahler?: boolean },
): Promise<void> {
  const d = tx ?? db;
  await assertSelbstzahlerStatutoryAllocationAllowed(
    params.customerId,
    params.budgetType,
    d,
    options?.allowStatutoryForSelbstzahler,
  );
  const allExisting = await budgetAllocationsRepo.selectColumnsFrom({ id: budgetAllocations.id, deletedAt: budgetAllocations.deletedAt }, d)
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
    await d.update(budgetAllocations)
      .set({
        amountCents: params.amountCents,
        month: params.month,
        validFrom: params.validFrom,
        expiresAt: params.expiresAt,
        notes: params.notes ?? null,
      })
      .where(eq(budgetAllocations.id, active[0].id));

    for (let i = 1; i < active.length; i++) {
      await d.update(budgetAllocations)
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
    const inserted = await d.insert(budgetAllocations)
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
    await d.insert(budgetAllocations)
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

/**
 * Task #670 — Manueller §45b-Carryover ("Restguthaben aus Vorjahr").
 *
 * Legt eine `source='carryover'` Allokation für `sourceYear + 1` an (validFrom
 * = 01.01., expiresAt = 30.06. des Zieljahres, gem. SGB XI §45b Abs. 3).
 * Per Kunde+Quelljahr genau eine aktive Zeile — beim Update wird die bestehende
 * Zeile in-place aktualisiert (kein Drift mit dem Auto-Carryover-Pfad, da
 * `ensureYearlyCarryover45b` denselben Quelljahr-Dedup über
 * `existingCarryoverYears` macht).
 *
 * GoBD: Soft-gelöschte Carryover-Allokationen werden NICHT wiederbelebt
 * (`deletedAt = null`); stattdessen wird eine frische Zeile angelegt und ein
 * `budget_allocation_resurrected`-Audit-Eintrag geschrieben — analog zu
 * `upsertInitialBalanceAllocation`.
 */
export async function upsertCarryoverAllocation(
  params: { customerId: number; budgetType: string; sourceYear: number; amountCents: number; notes?: string },
  userId?: number,
  options?: { allowStatutoryForSelbstzahler?: boolean },
): Promise<void> {
  await assertSelbstzahlerStatutoryAllocationAllowed(
    params.customerId,
    params.budgetType,
    db,
    options?.allowStatutoryForSelbstzahler,
  );
  // Task #716 — Fenster aus shared SSoT, damit Auto-/Manual-Pfad nicht
  // driften (siehe `ensureYearlyCarryover45b`).
  const { targetYear, validFrom, expiresAt } = carryoverWindowFor(params.sourceYear);

  const allExisting = await budgetAllocationsRepo.selectColumnsFrom(
    { id: budgetAllocations.id, deletedAt: budgetAllocations.deletedAt },
    db,
  )
    .where(and(
      eq(budgetAllocations.customerId, params.customerId),
      eq(budgetAllocations.budgetType, params.budgetType),
      eq(budgetAllocations.source, "carryover"),
      eq(budgetAllocations.year, targetYear),
      isNull(budgetAllocations.month),
    ))
    .orderBy(desc(budgetAllocations.id));

  const active = allExisting.filter(e => !e.deletedAt);
  const deleted = allExisting.filter(e => !!e.deletedAt);

  if (active.length > 0) {
    await db.update(budgetAllocations)
      .set({
        amountCents: params.amountCents,
        validFrom,
        expiresAt,
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
          reason: "GoBD: Duplikat-Bereinigung bei upsertCarryoverAllocation",
          keptAllocationId: active[0].id,
        });
      }
    }
  } else if (deleted.length > 0) {
    const inserted = await db.insert(budgetAllocations)
      .values({
        customerId: params.customerId,
        budgetType: params.budgetType,
        year: targetYear,
        month: null,
        amountCents: params.amountCents,
        source: "carryover",
        validFrom,
        expiresAt,
        notes: params.notes ?? null,
        createdByUserId: userId,
      })
      .returning({ id: budgetAllocations.id });

    if (userId != null) {
      await auditService.log(userId, "budget_allocation_resurrected", "budget", params.customerId, {
        customerId: params.customerId,
        budgetType: params.budgetType,
        year: targetYear,
        source: "carryover",
        amountCents: params.amountCents,
        replacedSoftDeletedAllocationId: deleted[0].id,
        newAllocationId: inserted[0]?.id ?? null,
        reason: "GoBD: Ersatz-Insert statt Resurrect der soft-gelöschten carryover-Allokation",
      });
    }
  } else {
    await db.insert(budgetAllocations)
      .values({
        customerId: params.customerId,
        budgetType: params.budgetType,
        year: targetYear,
        month: null,
        amountCents: params.amountCents,
        source: "carryover",
        validFrom,
        expiresAt,
        notes: params.notes ?? null,
        createdByUserId: userId,
      });
  }
}

export async function getInitialBalanceAllocations(customerId: number, budgetType: string, tx?: DbClient): Promise<BudgetAllocation[]> {
  // Task #608: Für §45b zusätzlich `carryover`-Allokationen ausliefern, damit
  // der Übertrag aus dem Vorjahr im UI „Startwert anpassen" sichtbar und
  // löschbar wird. Vor #608 entstand sonst ein Geister-Übertrag, der zwar in
  // der Budget-Übersicht summiert wurde, aber per UI weder bearbeitet noch
  // gelöscht werden konnte — neu hinzugefügte Startwerte stapelten sich darauf
  // („Gesamt zugewiesen" sprang unerklärbar nach oben).
  //
  // Für §45a / §39+42a bleibt die alte Semantik (nur `initial_balance`) — dort
  // gibt es keinen automatischen Carryover-Pfad.
  const sourceFilter = budgetType === "entlastungsbetrag_45b"
    ? sql`${budgetAllocations.source} IN ('initial_balance', 'carryover')`
    : eq(budgetAllocations.source, "initial_balance");

  return budgetAllocationsRepo.selectFrom(tx ?? db)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, budgetType),
      isNull(budgetAllocations.deletedAt),
      sourceFilter,
    ))
    .orderBy(desc(budgetAllocations.validFrom), desc(budgetAllocations.id));
}

/**
 * Liefert den monatlichen §45b-Aufstockungsbetrag in Cent für ein gegebenes Datum.
 *
 * Task #603: Der pro-Kunden konfigurierbare "Unser Anteil"-Wert in
 * `customer_budget_type_settings.monthlyLimitCents` ist KEIN harter Monats-Cap,
 * sondern reduziert die monatliche Aufstockung des §45b-Jahrestopfs. Ist kein
 * Wert gesetzt, wird der gesetzliche Default (131 €) verwendet. Werte > 131 €
 * werden über `clampToStatutoryMax` als Safety-Net abgeschnitten.
 *
 * `asOfDate` (optional) wählt die historisierte Zeile, die zum Stichtag gültig
 * war — wichtig für rückwirkende Buchungen (GoBD).
 */
async function getMonthlyBudgetAmountCents(
  customerId: number,
  _tx?: DbClient,
  _typeSettings?: CustomerBudgetTypeSetting[],
  asOfDate?: string,
): Promise<number> {
  const d = _tx ?? db;

  const settings = _typeSettings ?? (asOfDate
    ? await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }, d)
    : await d.select()
        .from(customerBudgetTypeSettings)
        .where(eq(customerBudgetTypeSettings.customerId, customerId)));
  void d;

  const s45b = settings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  if (s45b?.monthlyLimitCents != null) {
    const clamped = clampToStatutoryMax({
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: s45b.monthlyLimitCents,
      yearlyLimitCents: null,
      pflegegrad: null,
    });
    return clamped.monthlyLimitCents ?? DEFAULT_MONTHLY_BUDGET_CENTS;
  }

  // Task #728 (Phase 2.1): `customer_budgets`-Fallback entfernt. Inhalte
  // sind durch `backfillCustomerBudgetsToTypeSettings` (Startup) in die
  // SSoT `customer_budget_type_settings` migriert. Kunden ohne Setting
  // erhalten den gesetzlichen Default.
  return DEFAULT_MONTHLY_BUDGET_CENTS;
}

export async function getCustomerBudgetAmounts(customerId: number, _tx?: DbClient, _typeSettings?: CustomerBudgetTypeSetting[]): Promise<{ pflegesachleistungen36: number; verhinderungspflege39: number }> {
  const typeSettings = _typeSettings ?? await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: todayISO() }, _tx);
  const setting45a = typeSettings.find(s => s.budgetType === "umwandlung_45a");
  const setting39 = typeSettings.find(s => s.budgetType === "ersatzpflege_39_42a");

  // Task #728 (Phase 2.1): `customer_budgets`-Fallback entfernt.
  // Backfill (`backfillCustomerBudgetsToTypeSettings`) hat die Legacy-Werte
  // in `customer_budget_type_settings` übertragen; Kunden ohne Setting
  // liefern jetzt 0 statt eines stillschweigenden Legacy-Werts.
  let pflegesachleistungen36 = setting45a?.monthlyLimitCents ?? 0;

  // Task #954 — §45a statutorischer Default nach Pflegegrad: Ist der §45a-Topf
  // aktiviert, aber ohne expliziten Monatsbetrag, greift der gesetzliche
  // Umwandlungsanspruch (PG≥2). Derselbe SSoT-Resolver speist auch den Cap-Pfad
  // (`computeCapRemaining`), damit Anzeige (Overview) und Buchung (Cascade)
  // identisch defaulten — kein „Anzeige vs. Buchung"-Drift.
  if (setting45a?.enabled && setting45a.monthlyLimitCents == null) {
    const d = _tx ?? db;
    const [row] = await customersRepo
      .selectColumnsFrom({ pflegegrad: customers.pflegegrad }, d)
      .where(eq(customers.id, customerId))
      .limit(1);
    pflegesachleistungen36 = resolve45aMonthlyLimitCents(null, row?.pflegegrad ?? null) ?? 0;
  }

  return {
    pflegesachleistungen36,
    verhinderungspflege39: setting39?.yearlyLimitCents ?? 0,
  };
}

export async function calculateAllocatedCents(
  customerId: number,
  budgetType: string,
  opts: { year?: number; asOfDate?: string; projectFuture?: boolean },
  _tx?: DbClient,
  _preferences?: CustomerBudgetPreferences | undefined,
  _typeSettings?: CustomerBudgetTypeSetting[]
): Promise<number> {
  const d = _tx ?? db;
  const typeSettings = _typeSettings ?? await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: todayISO() }, _tx);

  let calculated = 0;
  if (budgetType === "entlastungsbetrag_45b") {
    calculated = (await calculateAllocated45b(customerId, opts, d, typeSettings)).allocatedCents;
  } else if (budgetType === "umwandlung_45a") {
    calculated = await calculateAllocated45a(customerId, opts, d, typeSettings);
  } else if (budgetType === "ersatzpflege_39_42a") {
    calculated = await calculateAllocated39_42a(customerId, opts, d, typeSettings);
  }

  const manualAdjustments = await budgetAllocationsRepo.selectFrom(d)
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
 *      - dem zur Laufzeit aus der Pflegegrad-Historie abgeleiteten Anker
 *        (`getEarliestCareLevelStart`, §45b auf das laufende Jahr gebodet),
 *      - frühestem `initial_balance.validFrom`,
 *      - frühestem persistierten `carryover` (Altlast-Quellen `monthly_auto`/
 *        `monthly` als Anker entfernt — Task #1289),
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
 *      `monthlyAmount`, sofern für diesen `(year, month)` KEIN **aktiver**
 *      `initial_balance` existiert. Soft-gelöschte Startwerte blockieren das
 *      Auto-Renewal NICHT mehr (Task #642): wo kein aktiver Startwert mehr
 *      einen Monat besetzt, kehrt die reguläre 131-€-Aufstockung zurück.
 *      Solange ein Startwert aktiv ist, gilt sein Monat weiterhin als belegt
 *      — damit ein manueller Startwert nicht doppelt durch die virtuelle
 *      Auto-Allokation ergänzt wird (ursprüngliche Schutzeigenschaft aus
 *      Task #101 bleibt erhalten).
 *
 *   4. Addiere alle persistierten `initial_balance`-Einträge bis `ibDateLimit`.
 *
 *   5. Addiere alle persistierten `carryover`-Einträge — aber nur dann, wenn
 *      für das **Quelljahr** (carryover.year - 1) **kein** manueller Startwert
 *      existiert. Sonst Doppelzählung (Task #101). Der Altbestand obsolet
 *      gewordener Carryovers ist einmalig zurückgebaut worden; das Skript ist
 *      nach Anwendung entfernt, Protokoll:
 *      `docs/corrections/2026-08-23_duplikate-45b-carryover-startwert.md`.
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
/**
 * Task #1306 — §45b-Allocation plus die Liste der NICHT gezählten Spezial-
 * Allocations (abgelaufener Übertrag / per IB-Supersession verdrängte
 * `initial_balance`). Letztere ist die SSoT für die symmetrische ConsumedNet-
 * Korrektur: Verbrauch, der gegen einen aus `Allocated` entfernten Topf gebucht
 * wurde, darf nicht weiter vom laufenden Topf abgezogen werden. Nur im
 * `asOfDate`/Default-Modus relevant — der `{year}`-Pool-Modus liefert eine leere
 * Liste.
 */
interface Allocated45bResult {
  allocatedCents: number;
  excludedSpecialAllocationIds: number[];
  // Task #1812 — Reset-Stichtag (Monatsanfang des spätesten wirksamen §45b-
  // Startwerts M). Verbrauch mit `transactionDate < resetCutoffDate` ist bereits
  // in der neuen Startwert-Basis abgebildet und darf NICHT erneut abgezogen
  // werden (`getExcluded45bConsumption`). `null`, wenn kein Reset wirksam ist
  // bzw. im `{year}`-Pool-Modus.
  resetCutoffDate: string | null;
  // Task #1927 — Monatsanfang, ab dem Monatsaufstockungen zum Topf beitragen
  // (`enumStart` nach ALLEN Shifts: Anker, Übertrag, Settings-Fenster,
  // Verfalls-Boden, Startwert-Reset).
  //
  // Verbrauch VOR diesem Datum, der gegen die virtuelle Monatsaufstockung
  // gebucht wurde (`allocation_id IS NULL`, das FIFO-Restleg in
  // `consumption-engine.ts`), gehört zu Monaten, die aus `Allocated`
  // herausgefallen sind. Er darf den laufenden Topf nicht weiter belasten —
  // dieselbe Symmetrie wie bei `excludedSpecialAllocationIds`, nur für das Leg,
  // das gar keine Allocation-Zeile hat und deshalb über keine ID greifbar ist.
  // `null` im `{year}`-Pool-Modus.
  accrualFloorDate: string | null;
}

async function calculateAllocated45b(
  customerId: number,
  opts: { year?: number; asOfDate?: string; projectFuture?: boolean },
  d: Pick<typeof db, 'select'>,
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<Allocated45bResult> {
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  const existingAllocations = await budgetAllocationsRepo.selectFrom(d)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

  const all45bSettings = await d.select()
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
    ))
    .orderBy(asc(customerBudgetTypeSettings.validFrom));

  // Task #1204 — §45b-Anker wird zur Laufzeit aus der Pflegegrad-Historie
  // abgeleitet (kein persistierter `budget_start_date` mehr) und auf den 1.1.
  // des LAUFENDEN Jahres gebodet (Onboarding-Baseline, Task #860): das Vorjahr
  // gilt als aufgebraucht, es wird kein automatischer Vorjahres-Übertrag
  // fabriziert. Identisch in `ensureYearlyCarryover45b` und im
  // /initial-budget-§45b-Pfad. Die Allokations-Fallbacks unten greifen nur,
  // wenn KEINE Pflegegrad-Historie existiert.
  // Anker-Kette: SSoT in `shared/domain/budget/anchor-45b.ts`. Die Reihenfolge
  // (Pflegegrad → aktiver Startwert → aktiver Übertrag → soft-gelöschter
  // Startwert → Eligibility-Gate/Jahresanfang) samt ihrer Begründungen steht
  // dort; hier bleibt nur die Datenbeschaffung. Verhalten unverändert.
  const s45bEnabled = all45bSettings.some(s => s.enabled);
  const pgStart = await getEarliestCareLevelStart(customerId, d);
  const anchorBase = {
    pgStartIso: pgStart ?? null,
    s45bEnabled,
    activeAllocations: existingAllocations,
    fallbackYear: curYear,
    floorPgAnchor: (iso: string) => floorAutoAnchor45bToCurrentYear(iso, curYear),
  };

  let anchor = resolve45bAnchor({ ...anchorBase, deletedInitialBalanceValidFroms: [] });
  // Die soft-gelöschten Startwerte (Stufe 4) werden NUR geholt, wenn die
  // Stufen 1–3 nichts geliefert haben — sonst wäre das eine zusätzliche Query
  // auf jedem Aufruf dieses heißen Lesepfads.
  if (anchor.kind === "ineligible" || anchor.via === "jahresanfang") {
    const deletedInitialBalances = await budgetAllocationsRepo.selectFrom(d)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "initial_balance"),
        isNotNull(budgetAllocations.deletedAt),
      ));
    anchor = resolve45bAnchor({
      ...anchorBase,
      deletedInitialBalanceValidFroms: deletedInitialBalances
        .map(a => a.validFrom)
        .filter((v): v is string => !!v),
    });
  }

  if (anchor.kind === "ineligible") {
    // Kein Anspruch, also auch kein Aufstockungs-Boden: es gibt keine Monate,
    // die herausfallen koennten.
    return { allocatedCents: 0, excludedSpecialAllocationIds: [], resetCutoffDate: null, accrualFloorDate: null };
  }
  const budgetStartDate: string = anchor.anchorIso;

  const startDate = parseLocalDate(budgetStartDate);
  let allocStartYear = startDate.getFullYear();
  let allocStartMonth = startDate.getMonth() + 1;

  // Task #642: nur AKTIVE Startwerte blockieren das Auto-Renewal. Soft-
  // gelöschte Startwert-Monate werden nicht mehr aus dem Skip-Set
  // eingetragen, sodass die reguläre Monatsaufstockung zurückkehrt, sobald
  // kein aktiver Startwert mehr den Monat überdeckt. Der ursprüngliche
  // Doppelzählungsschutz (Task #101) wirkt weiter, solange ein Startwert
  // aktiv ist.
  const initialBalanceMonths = existingAllocations
    .filter(a => a.source === "initial_balance" && a.month != null)
    .map(a => ({ year: a.year, month: a.month! }));

  // Task #1812 — §45b-Startwert = Reset/Re-Baseline (nicht mehr additiv).
  // Der `allocStart`-Shift auf den Monat NACH dem Startwert wird NICHT mehr hier
  // auf die geteilte `allocStart`-Variable angewendet (er kollidierte mit dem
  // expiryFloor-Shift, der `allocStartMonth` wieder auf 1 setzt und damit die
  // Monate vor dem Startwert wieder einließ). Stattdessen wird der Reset erst
  // unmittelbar vor der Enumeration als lokale Start-Grenze berechnet
  // (`enumStartYear/Month`, siehe unten) — nach ALLEN allocStart-Manipulationen.

  // Task #696 — Carryover-aware allocStart-Shift.
  //
  // Eine `source='carryover'` Allokation für Zieljahr Y repräsentiert das
  // Restguthaben aus Jahr (Y-1). Der gesamte Konsum- und Allokationsverlauf
  // für Jahre < Y ist damit auf einen einzigen Betrag (das Restguthaben)
  // kondensiert worden — würde die Auto-Renewal-Schleife zusätzlich
  // monatlich §45b-Beträge für Jahre < Y aufschlagen, käme es zur Doppel-
  // zählung (Bug 2 Schröder: budgetStartDate = Dez 2025, Carryover für 2026
  // vorhanden → Dez 2025 wurde 1× als monthly_auto UND 1× im Carryover gezählt).
  //
  // Daher: wenn ein Carryover existiert, schieben wir `allocStart` auf den 1.
  // Januar des spätesten Zieljahrs vor.
  //
  // Task #959 — Universelles Verfalls-/Übertrags-Modell: Ein Carryover
  // kondensiert das Restguthaben des Quelljahrs aus JEDER Herkunft (virtuelle
  // Monatsaufstockung, `initial_balance`, manueller/Legacy-Anker). Die frühere
  // `ibYears`-Ausnahme (Task #101: Carryover neben einem Startwert ignorieren)
  // entfällt — stattdessen rollt der Startwert ebenfalls in den Carryover (siehe
  // `ensureYearlyCarryover45b`) und wird hier per IB-Supersession aus
  // `initialBalanceTotal` herausgerechnet (kein Doppelzählen). So bekommt JEDER
  // Kunde (neu, alt, manuell) exakt EINEN ablaufenden Übertrag pro Jahr.
  //
  // WICHTIG (Task #959/#1392): Der Shift darf nur GÜLTIGE Überträge
  // berücksichtigen — bereits in Kraft (`validFrom <= Stichtag`) UND noch nicht
  // verfallen (`expiresAt >= Stichtag`). Das ist exakt dasselbe `carryoverCounted`-
  // Prädikat, das unten `carryoverTotal` zählt; so sieht der allocStart-Shift
  // denselben Übertragsbestand wie die Summe (keine Drift).
  //
  // Zwei Fälle, die dieses Prädikat abfängt:
  //  - Ein in die ZUKUNFT materialisierter Übertrag (Zieljahr 2026,
  //    `validFrom = 2026-01-01`) darf den `allocStart` einer RÜCKWIRKENDEN
  //    Buchung (`asOfDate = 2024-06-15`) nicht auf 2026 vorziehen → sonst
  //    `allocStart > end` → §45b fällt auf 0, GoBD-Regression bei backdated
  //    Bookings (Task #959).
  //  - Ein VERFALLENER Übertrag (z.B. stale/weitergerollt) darf `allocStart`
  //    NICHT mehr nach vorn ziehen (Task #1392): sein Quelljahr ist über den
  //    `expiryFloor` ohnehin ausgeblendet und sein Verbrauch wird symmetrisch
  //    herausgerechnet. Damit kann ein abgelaufener Übertrag weder allocStart
  //    noch den Startwert-Boden verfälschen (Entkopplung Startwert↔Übertrag).
  const carryoverCounted = (a: { source: string; validFrom: string; expiresAt: string | null }) =>
    a.source === "carryover" &&
    a.validFrom <= (opts.asOfDate ?? `${curYear}-12-31`) &&
    (!a.expiresAt || a.expiresAt >= (opts.asOfDate ?? `${curYear}-01-01`));
  const validCarryoverTargetYears = existingAllocations
    .filter(carryoverCounted)
    .map(a => a.year);
  const latestValidCarryoverYear = validCarryoverTargetYears.length > 0
    ? Math.max(...validCarryoverTargetYears)
    : null;
  if (latestValidCarryoverYear != null && latestValidCarryoverYear > allocStartYear) {
    allocStartYear = latestValidCarryoverYear;
    allocStartMonth = 1;
  }

  // Skip-Set der Monatsaufstockung — SSoT in `anchor-45b.ts` (nur AKTIVE
  // Startwerte, Task #642/#101). Identisches Ergebnis wie zuvor.
  const initialBalanceSet = initialBalanceMonthKeys(existingAllocations);

  // Task #603 — Per-Kunde konfigurierbarer §45b-Monats-Anteil ist historisiert.
  // Wir holen ALLE §45b-Zeilen einmal und schlagen pro iteriertem Monat die
  // damals gültige Zeile nach. Verglichen wird gegen das **Monatsende**
  // (siehe Task #668): ein einziger Mitte-des-Monats-Stichtag würde einen
  // Settings-Wechsel, der erst NACH dem 15. greift (z.B. `validFrom = heute`
  // an einem Tag > 15., oder die append-only-Transition mit
  // `validFrom = morgen = 16.`+), für den aktuellen Monat verschlucken — die
  // Monatsaufstockung fiele dann auf einen veralteten / leeren Fallback
  // zurück. Mit Monatsende-Lookup matcht jede Zeile, die bis zum Ende des
  // Monats in Kraft getreten ist; eine später (im Folgemonat) angelegte
  // Zeile bleibt für historische Monate korrekt unsichtbar, weil ihr
  // `validFrom` > Monatsende des historischen Monats liegt.
  //
  // Bei einer Transition innerhalb desselben Monats (alte Zeile mit
  // `validTo < Monatsende` + neue Zeile mit `validFrom <= Monatsende`)
  // matcht nur die NEUE Zeile — was dem Nutzer-Intent „ab heute gilt der
  // neue Anteil" entspricht.
  const fallbackMonthlyAmount = await getMonthlyBudgetAmountCents(customerId, undefined, typeSettings);

  const monthlyAmountFor = (year: number, month: number): number => {
    if (all45bSettings.length === 0) return fallbackMonthlyAmount;
    // Task #911 — SSoT-Auswahl der wirksamen Phasen-Zeile (geteilt mit der in
    // der Overview angezeigten `monthlyLimitCents`, siehe
    // `pickEffective45bSettingRow`). `all45bSettings` ist bereits nach
    // `validFrom` aufsteigend sortiert; der Picker sortiert defensiv erneut.
    const row = pickEffective45bSettingRow(all45bSettings, year, month);
    if (!row) return fallbackMonthlyAmount;
    if (row.monthlyLimitCents == null) return DEFAULT_MONTHLY_BUDGET_CENTS;
    const clamped = clampToStatutoryMax({
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: row.monthlyLimitCents,
      yearlyLimitCents: null,
      pflegegrad: null,
    });
    return clamped.monthlyLimitCents ?? DEFAULT_MONTHLY_BUDGET_CENTS;
  };

  // Task #1740 — Diese §45b-Zeile wird OHNE `enabled`-Filter gesucht (wie der
  // SSoT-Resolver `resolve45bActivation` in `shared/domain/budgets.ts`). Das ist
  // hier zwar KEIN Aktivierungs-Gate — die Zeile speist nur den
  // allocStart-Shift-Fallback unten und wird ausschließlich benutzt, wenn
  // `all45bSettings.length === 0` (dann ist auch `typeSettings` frei von
  // §45b-Zeilen, der Filter wäre also ohnehin wirkungslos). Wir vermeiden den
  // `&& s.enabled`-Filter trotzdem bewusst, weil genau dieses Muster (eine
  // DEAKTIVIERTE Zeile wie eine FEHLENDE behandeln) die anderswo entfernte
  // „Budget überschritten"-Regression war und ein künftiger Edit ihn hier sonst
  // still wieder einführen könnte.
  const s45b = typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b");

  // Task #668-Followup: bei mehreren `customer_budget_type_settings`-Zeilen
  // (Append-only-Transition: alte Zeile geschlossen, neue Zeile ab Folgetag)
  // darf der allocStart-Shift NICHT die einzelne picked-row aus
  // `typeSettings` benutzen — das ist üblicherweise die LATEST aktive Zeile
  // und würde den Start fälschlich auf deren `validFrom` schieben, womit alle
  // Monate vor dem Wechsel aus der Iteration fallen (Repro: Jan–Apr fehlten
  // komplett, weil neue Zeile validFrom=Mai war). Korrekt ist die FRÜHESTE
  // `validFrom` aller §45b-Zeilen für diesen Kunden.
  // Liegt nur eine Zeile vor, fällt das auf das alte Verhalten zurück.
  // Fenster-Shift: SSoT in `anchor-45b.ts`. Verhalten unverändert.
  const s45bWindow = effective45bSettingsWindow(all45bSettings, s45b ?? null);
  ({ year: allocStartYear, month: allocStartMonth } = shiftStartToSettings(
    { year: allocStartYear, month: allocStartMonth },
    s45bWindow.validFrom,
  ));

  let horizonYear = curYear;
  let horizonMonth = curMonth;
  // Der Horizont als VOLLER Stichtag — nicht nur Jahr+Monat.
  //
  // Der Verfalls-Boden vergleicht ab jetzt gegen die Frist selbst (30.06.),
  // nicht mehr gegen ihren Monat (`expiry45bFloorDateFor`). Dafür braucht er
  // den Tag. Er wird exakt nach derselben Regel gesetzt wie `horizonYear/Month`
  // direkt darunter — capped auf heute, außer im `projectFuture`-Modus — damit
  // Boden und Enumerations-Grenze nicht auf verschiedene Stichtage sehen.
  let horizonIso = todayISO();
  if (opts.asOfDate) {
    const asOf = parseLocalDate(opts.asOfDate);
    const asOfYear = asOf.getFullYear();
    const asOfMonth = asOf.getMonth() + 1;
    if (opts.projectFuture) {
      // Task #704: Vorausschau-Modus für „Geplant"-Forecast. Horizont darf in
      // die Zukunft wandern, damit zukünftige Monatsaufstockungen + ablaufende
      // Carryovers in die Projektion einfließen. Echte Buchungen (cost-estimate,
      // consumeFifo) verwenden weiterhin den Default (capped auf heute), um
      // nicht für noch nicht angefallene Monate vorzuziehen.
      horizonYear = asOfYear;
      horizonMonth = asOfMonth;
      horizonIso = opts.asOfDate;
    } else if (asOfYear < curYear || (asOfYear === curYear && asOfMonth < curMonth)) {
      horizonYear = asOfYear;
      horizonMonth = asOfMonth;
      horizonIso = opts.asOfDate;
    } else if (opts.asOfDate < horizonIso) {
      // Gleicher Monat wie heute, aber ein FRÜHERER Tag. Die Monats-Fassung
      // oben lässt diesen Fall bewusst durch (sie sieht keinen Unterschied);
      // für den tag-genauen Boden ist er sehr wohl einer — im Juni liegen der
      // 29. und der 30. auf verschiedenen Seiten der Frist. Capping nach oben
      // bleibt: ein asOf NACH heute wird ohne `projectFuture` nicht vorgezogen.
      horizonIso = opts.asOfDate;
    }
  }

  // Task #959 — §45b-Verfalls-Boden (universell, für JEDEN Kunden). Zum Horizont
  // (heute oder Forecast-Datum) trägt nur noch das rechtlich relevante Fenster
  // zum verfügbaren Budget bei: im 1. Halbjahr Vorjahr + laufendes Jahr, ab Juli
  // nur das laufende Jahr (siehe `expiryFloorAnchorYear` unten). Wir heben `allocStart`
  // auf diesen Boden an — ein weit zurückliegender (manueller/Legacy-)Anker
  // akkumuliert damit KEINE jahrelang nicht-verfallenden Monatsbeträge mehr,
  // selbst wenn (noch) kein Carryover materialisiert wurde. Der Boden wird per
  // `Math.max` mit den bestehenden Shifts (Carryover/IB/Settings) kombiniert,
  // sodass ein materialisierter Carryover (der das Restguthaben exakt abbildet)
  // weiterhin Vorrang behält und es zu KEINER Doppelzählung kommt. NICHT im
  // `{year}`-Modus (Pool-Berechnung von `ensureYearlyCarryover45b`) — dort muss
  // das volle Quelljahr sichtbar bleiben, damit der Übertrag korrekt entsteht.
  // Frist-SSoT (`shared/domain/budget/expiry-45b.ts`) statt des nackten
  // Ausdrucks `horizonMonth <= 6 ? …`. Dieselbe Konstante speist das
  // Übertrags-Fenster in `carryoverWindowFor` — Boden und Frist können damit
  // nicht mehr gegeneinander laufen.
  //
  // TAG-GENAU statt monatsgenau: `expiry45bFloorDateFor` liefert den Boden als
  // fertigen Stichtag und vergleicht den Horizont gegen die Frist SELBST, nicht
  // gegen ihren Monat. Das ERSETZT die Kette „Jahr holen → `allocStartMonth = 1`
  // → weiter unten `${allocStartYear}-01-01` zusammenbauen": der Boden war damit
  // an zwei Stellen halb kodiert, Jahr in der SSoT, Monat/Tag hier. Bei den
  // heutigen Konstanten (Frist = letzter Tag des Monats) ist das Ergebnis
  // identisch — die Kopplungs-Grenze N1 aus dem Gate-2 ist damit aber
  // geschlossen, und der Boden hat nur noch EINE Quelle.
  const expiryFloorDate = expiry45bFloorDateFor(horizonIso);
  const [expiryFloorAnchorYear, expiryFloorAnchorMonth] = expiryFloorDate.split("-").map(Number);
  if (opts.year == null) {
    const bodenLiegtHoeher = expiryFloorAnchorYear > allocStartYear
      || (expiryFloorAnchorYear === allocStartYear && expiryFloorAnchorMonth > allocStartMonth);
    if (bodenLiegtHoeher) {
      allocStartYear = expiryFloorAnchorYear;
      allocStartMonth = expiryFloorAnchorMonth;
    }
  }

  let endYear = horizonYear;
  let endMonth = horizonMonth;
  ({ year: endYear, month: endMonth } = clampEndToSettings(
    { year: endYear, month: endMonth },
    s45bWindow.validTo,
  ));

  // Task #1812 — §45b-Startwert = Reset/Re-Baseline. Der SPÄTESTE zum Stichtag
  // (`ibDateLimit`) bereits wirksame Startwert-Monat M ist die neue Basis: er
  // ERSETZT jede Ansammlung <= M. Nur Monate NACH M akkumulieren weiter. Wir
  // berechnen daher eine LOKALE Enumerations-Startgrenze `enumStart = max(
  // allocStart-nach-allen-Shifts, M+1)` — bewusst NICHT auf der geteilten
  // `allocStart`-Variable (kollidierte mit dem expiryFloor-Reset auf Monat 1).
  // Gilt NUR im laufenden/`asOfDate`-Modus, NICHT im `{year}`-Pool-Modus
  // (Carryover-Berechnung, out of scope) — dort bleibt allocStart maßgeblich.
  // Ein rein zukünftiger Startwert (M-Start > Stichtag) ist noch nicht wirksam
  // und löst keinen Reset aus (rückdatierte Reads bleiben korrekt).
  const resetDateLimit = opts.asOfDate ?? `${curYear}-12-31`;
  let resetYear = 0, resetMonth = 0;
  let hasReset = false;
  if (opts.year == null) {
    for (const ib of initialBalanceMonths) {
      const ibStart = `${ib.year}-${String(ib.month).padStart(2, "0")}-01`;
      if (ibStart > resetDateLimit) continue;
      if (!hasReset || ib.year > resetYear || (ib.year === resetYear && ib.month > resetMonth)) {
        resetYear = ib.year;
        resetMonth = ib.month;
        hasReset = true;
      }
    }
  }
  const resetCutoffDate = hasReset
    ? `${resetYear}-${String(resetMonth).padStart(2, "0")}-01`
    : null;

  let enumStartYear = allocStartYear;
  let enumStartMonth = allocStartMonth;
  if (hasReset) {
    let afterMonth = resetMonth + 1, afterYear = resetYear;
    if (afterMonth > 12) { afterMonth = 1; afterYear++; }
    if (afterYear > enumStartYear || (afterYear === enumStartYear && afterMonth > enumStartMonth)) {
      enumStartYear = afterYear;
      enumStartMonth = afterMonth;
    }
  }

  // Task #872 — §45b-Monatsaufstockung als reine SSoT-Aufzählung. Identisch zur
  // historischen Monat-für-Monat-Schleife (allocStart→end, Startwert-Monate
  // übersprungen, historisierter Monatsbetrag pro Monat), nur ausgelagert in
  // `enumerate45bStatutoryMonths` — gleichzeitig die Quelle der materialisierten
  // `statutory_monthly`-Zeilen und der Backfill-Reconciliation.
  const statutoryMonths = enumerate45bStatutoryMonths({
    allocStartYear: enumStartYear,
    allocStartMonth: enumStartMonth,
    endYear,
    endMonth,
    initialBalanceMonthKeys: initialBalanceSet,
    monthlyAmountFor,
  });

  // Task #1927 — Aufstockungs-Boden VERÖFFENTLICHEN (nicht neu rechnen).
  //
  // `allocStartYear/Month` ist die Grenze, unterhalb derer ÜBERHAUPT NICHTS mehr
  // zum Topf beiträgt — nach Anker, Übertrags-Shift, Settings-Fenster und
  // Verfalls-Boden. Sie bestimmt bereits `Allocated`; sie war nur nach außen
  // unsichtbar. `getExcluded45bConsumption` braucht genau sie, um den Verbrauch
  // symmetrisch zu behandeln.
  //
  // BEWUSST `allocStart` und NICHT `enumStart`: `enumStart` liegt bei einem
  // Startwert-Reset einen Monat HÖHER (der Monat M des Startwerts wird von der
  // Enumeration übersprungen, weil ihn der Startwert selbst deckt). Der Monat M
  // trägt aber sehr wohl zum Topf bei — über die `initial_balance`-Zeile. Nähme
  // man `enumStart`, fiele der Verbrauch des Reset-Monats aus dem Abzug und die
  // Verfügbarkeit stiege ohne fachlichen Grund.
  //
  // GEMESSEN, nicht hergeleitet: mit `enumStart` bewegten sich an
  // `engeldesk_ref` HEUTE 8 Kunden um +656,80 € — exakt die acht mit einem
  // Startwert-Reset (57, 89, 94, 96, 99, 182, 210, 222). Mit `allocStart` ist
  // die Differenz null. Alles unterhalb des Reset-Monats deckt ohnehin schon
  // `resetCutoffDate` (Glied (b)), das ist also keine Lücke, sondern die
  // richtige Arbeitsteilung zwischen den beiden Gliedern.
  //
  // KOPPLUNG, die beim Anfassen zu beachten ist (Gate-2-Fund Q5): der
  // Ledger-Assert in `server/services/invoice-45b-reduction.ts` fordert
  // `allocated − consumedNet === 0` EXAKT und haengt damit direkt an
  // `excludedConsumedNetCents`. Er ist heute unberuehrt, weil jener Pfad einen
  // Startwert auf den Monatsersten setzt und damit `resetCutoffDate >=
  // accrualFloorDate` gilt — das NULL-Glied ist dort eine Teilmenge des
  // Reset-Glieds. Wer diesen Boden ueber den Abrechnungsmonat hebt (etwa auf
  // `enumStart`), bricht jene Stelle als harten 400er mitten in einer
  // GoBD-Korrektur.
  //
  // NICHT einfach `expiryFloorDate` einsetzen, so naheliegend das aussieht:
  // der Verfalls-Boden ist nur EINER der Shifts, die `allocStart` bilden (Anker,
  // Übertrag, Settings-Fenster kommen dazu und liegen regelmäßig HÖHER). Wer
  // hier den Verfalls-Boden direkt nähme, senkte die Grenze auf den 01.01. des
  // Boden-Jahres ab, während `Allocated` weiter ab dem höheren `allocStart`
  // zählt — der Verbrauch der dazwischen liegenden Monate bliebe abgezogen,
  // ohne dass sein Anspruch zählt. Genau die Asymmetrie, die Task #1927
  // geschlossen hat, nur mit umgekehrtem Vorzeichen.
  const accrualFloorDate = `${allocStartYear}-${String(allocStartMonth).padStart(2, "0")}-01`;

  if (opts.year != null) {
    const yearMonthlyTotal = sum45bStatutoryMonths(
      statutoryMonths.filter(s => s.year === opts.year),
    );
    return {
      allocatedCents: yearMonthlyTotal + sumInitialBalancesForYear(existingAllocations, opts.year),
      excludedSpecialAllocationIds: [],
      resetCutoffDate: null,
      // Pool-Modus (Uebertrags-Berechnung), kein Lesepfad: dort muss das volle
      // Quelljahr sichtbar bleiben, ein Boden waere fachlich falsch.
      accrualFloorDate: null,
    };
  }

  const totalCalculated = sum45bStatutoryMonths(statutoryMonths);

  // Task #959/#1392 — IB-Supersession + Verfall: Startwert-Boden ENTKOPPELT vom
  // Übertrags-Jahr. Früher zog
  // `ibFloorYear = max(expiryFloor, latestCountedCarryoverYear)` den Boden an
  // EINEN (evtl. stale/abgelaufenen) Übertrag und verdrängte legitime Startwerte
  // PAUSCHAL (jeder Startwert unterhalb des spätesten Übertrags-Zieljahrs fiel
  // raus). Das ließ einen weitergerollten Übertrag den Startwert + die
  // Monatsaufstockungen unsichtbar machen → falsch-negative §45b-Anzeige.
  //
  // Jetzt zwei getrennte, klar begründete Regeln:
  //  (1) Boden = allein das rechtliche Verfalls-Fenster (`expiryFloorAnchorYear`).
  //      Ein Startwert im gültigen Fenster bleibt sichtbar, auch wenn ein
  //      Übertrag verfallen ist.
  //  (2) GEZIELTE IB-Supersession gegen ECHTE Doppelzählung: ein Startwert wird
  //      nur dann herausgerechnet, wenn ein GÜLTIGER Übertrag GENAU sein
  //      Quelljahr kondensiert. Übertrag für Zieljahr T bildet das Restguthaben
  //      des Quelljahrs (T-1) ab; der Startwert für (T-1) zählt sonst doppelt.
  //      `carryoverCounted` (oben definiert, dieselbe Schranke wie
  //      `carryoverTotal`) liefert die gültigen Überträge.
  const ibDateLimit = opts.asOfDate ?? `${curYear}-12-31`;
  const ibFloorYear = expiryFloorAnchorYear;
  const supersededIbYears = new Set(
    existingAllocations.filter(carryoverCounted).map(a => a.year - 1),
  );

  // Task #959/#1392 — Carryover wird IMMER gezählt (frühere `ibYears`-Ausnahme
  // aus Task #101 entfällt): Der Startwert desselben Quelljahrs ist per
  // gezielter IB-Supersession (oben) aus `initialBalanceTotal` entfernt, sodass
  // Carryover + Startwert sich nicht mehr doppeln. Es zählen nur noch nicht
  // verfallene Überträge (validFrom <= Stichtag, expiresAt >= Stichtag).
  const carryoverTotal = existingAllocations
    .filter(carryoverCounted)
    .reduce((sum, a) => sum + a.amountCents, 0);

  // Task #1306/#1392 — Symmetrie-Anker: Spezial-Allocations (Übertrag /
  // `initial_balance`), die NACH den Zähl-Prädikaten NICHT mehr zum verfügbaren
  // Budget beitragen (abgelaufener Übertrag bzw. per gezielter IB-Supersession
  // verdrängter Quelljahres-Startwert). `getExcluded45bConsumption` nutzt diese
  // IDs, damit der gegen sie gebuchte Verbrauch nicht weiter vom laufenden Topf
  // abgezogen wird (Allocated und ConsumedNet folgen denselben
  // Fenster-/Supersession-Regeln).
  // Task #1812 — Reset-Semantik: NUR der Startwert des spätesten wirksamen
  // Reset-Monats M ist die Basis. Frühere Startwerte (< M) sind durch die neue
  // Baseline ersetzt und fallen aus `initialBalanceTotal` heraus (landen in
  // `excludedSpecialAllocationIds`, damit ihr Verbrauch symmetrisch nicht mehr
  // abgezogen wird). Die bisherigen Verfalls-/Supersession-Prädikate bleiben als
  // zusätzliche Schranke erhalten.
  const ibCounted = (a: { source: string; validFrom: string; year: number; month: number | null }) =>
    a.source === "initial_balance" &&
    a.validFrom <= ibDateLimit &&
    a.year >= ibFloorYear &&
    !supersededIbYears.has(a.year) &&
    hasReset && a.year === resetYear && a.month === resetMonth;
  const initialBalanceTotal = existingAllocations
    .filter(ibCounted)
    .reduce((sum, a) => sum + a.amountCents, 0);
  const excludedSpecialAllocationIds = existingAllocations
    .filter(a =>
      (a.source === "initial_balance" && !ibCounted(a)) ||
      (a.source === "carryover" && !carryoverCounted(a)),
    )
    .map(a => a.id);

  return {
    allocatedCents: totalCalculated + initialBalanceTotal + carryoverTotal,
    excludedSpecialAllocationIds,
    resetCutoffDate,
    accrualFloorDate,
  };
}

/**
 * Task #1306 — Symmetrische §45b-ConsumedNet-Korrektur (SSoT).
 *
 * Liefert (a) die IDs der zum `asOfDate` NICHT gezählten Spezial-Allocations
 * (abgelaufener Übertrag / verdrängte `initial_balance`) und (b) den Netto-
 * Verbrauch (Σ|consumption|+Σ|write_off|−Σ|reversal|, bis `asOfDate`), der gegen
 * GENAU diese Allocations gebucht wurde. Beide Verfügbarkeits-Reader
 * (`unified-reader`, `consumption-engine`) ziehen (b) vom rohen Netto-Verbrauch
 * ab, sodass Verbrauch gegen einen aus `Allocated` entfernten Topf nicht länger
 * den laufenden Topf belastet. KEINE zweite Verfügbarkeits-Mathematik — die
 * Exklusions-Regel kommt ausschließlich aus `calculateAllocated45b`.
 */
export async function getExcluded45bConsumption(
  customerId: number,
  asOfDate: string,
  d: Pick<typeof db, 'select'>,
  typeSettings: CustomerBudgetTypeSetting[],
  opts?: { projectFuture?: boolean },
): Promise<{ excludedSpecialAllocationIds: number[]; excludedConsumedNetCents: number }> {
  // Task #1340 — `projectFuture` MUSS denselben Wert haben wie der zugehörige
  // `calculateAllocatedCents`-Aufruf, dessen Verbrauch wir symmetrisch
  // herausrechnen. Sonst driften Allocated- und Exklusions-Fenster auseinander
  // (z.B. Forecast-Projektion in `getBudgetSummary` rechnet mit
  // `projectFuture: true`). Default (undefined) = bisheriges Verhalten der
  // Lese-/Buchungs-Pfade (`unified-reader`, `consumption-engine`).
  const { excludedSpecialAllocationIds, resetCutoffDate, accrualFloorDate } = await calculateAllocated45b(
    customerId,
    { asOfDate, projectFuture: opts?.projectFuture },
    d,
    typeSettings,
  );
  // Kurzschluss (Gate-2-Fund N2): `accrualFloorDate` ist fuer jeden Kunden mit
  // §45b-Anspruch gesetzt, dieser Zweig greift also praktisch nur noch im
  // `ineligible`-Fall. Das ist gewollt — die Alternative waere eine zusaetzliche
  // Query nach dem fruehesten `transaction_date`, also genau der Roundtrip, den
  // der Kurzschluss sparen soll. Er bleibt als Ineligible-Ausstieg stehen.
  if (excludedSpecialAllocationIds.length === 0 && !resetCutoffDate && !accrualFloorDate) {
    return { excludedSpecialAllocationIds, excludedConsumedNetCents: 0 };
  }

  // Task #1812/#1927 — DREI symmetrische Exklusions-Quellen in EINER Bedingung
  // (die ODER-Verknüpfung dedupliziert Zeilen, die mehrere erfüllen):
  //  (a) Verbrauch gegen eine aus `Allocated` entfernte Spezial-Allocation
  //      (abgelaufener Übertrag / vom Reset verdrängter früherer Startwert),
  //  (b) Verbrauch VOR dem Reset-Stichtag M — bereits in der neuen Startwert-
  //      Basis abgebildet, darf also nicht erneut vom laufenden Topf abgezogen
  //      werden,
  //  (c) Task #1927 — Verbrauch gegen die virtuelle MONATSAUFSTOCKUNG aus
  //      Monaten unterhalb des Aufstockungs-Bodens.
  //
  // Warum (c) nötig ist und (a) es nicht erschlägt: Die FIFO-Buchung
  // (`consumption-engine.ts`) verbraucht zuerst die Spezial-Allocations, jede
  // mit ihrer `allocation_id`; was danach übrig bleibt, wird als EINE Zeile mit
  // `allocation_id = NULL` gebucht — das Monatsaufstockungs-Leg, das keine
  // materialisierte Zeile hat, auf die es zeigen könnte. `inArray(allocationId, …)`
  // aus (a) trifft solche Zeilen per SQL-Semantik NIE.
  //
  // Wandert der Boden (jeden 01.07. durch den Verfalls-Boden, an jedem
  // Jahreswechsel durch den Anker), fallen die Aufstockungen der darunter
  // liegenden Monate aus `Allocated` — ihr Verbrauch blieb bisher trotzdem
  // abgezogen und belastete den neuen Topf dauerhaft.
  //
  // NUR für `allocation_id IS NULL`: Verbrauch gegen eine noch GEZÄHLTE
  // Spezial-Allocation darf eine reine Datumsregel nicht wegnehmen. Damit
  // bleiben (a) und (c) trennscharf — ID-Weg für verlinkte Zeilen, Datums-Weg
  // ausschließlich für das Leg ohne Verlinkung.
  const exclusionParts = [
    excludedSpecialAllocationIds.length > 0
      ? inArray(budgetTransactions.allocationId, excludedSpecialAllocationIds)
      : undefined,
    resetCutoffDate
      ? lt(budgetTransactions.transactionDate, resetCutoffDate)
      : undefined,
    accrualFloorDate
      ? and(
          isNull(budgetTransactions.allocationId),
          lt(budgetTransactions.transactionDate, accrualFloorDate),
        )
      : undefined,
  ].filter((p): p is NonNullable<typeof p> => p != null);
  const exclusionCond = exclusionParts.length === 1
    ? exclusionParts[0]
    : or(...exclusionParts);

  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      exclusionCond,
      lte(budgetTransactions.transactionDate, asOfDate),
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      eq(budgetTransactions.transactionType, "reversal"),
      exclusionCond,
      lte(budgetTransactions.transactionDate, asOfDate),
    )),
  ]);

  const excludedConsumedNetCents = Math.max(
    0,
    Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0),
  );
  return { excludedSpecialAllocationIds, excludedConsumedNetCents };
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
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<number> {
  const { year: curYear, month: curMonth } = currentYearAndMonth();

  // Task #1204 — Anker = roher (ungekappter) Pflegegrad-Beginn zur Laufzeit
  // statt eines persistierten `budget_start_date`. §45a/§39 lesen den
  // ungekappten Beginn; die setting.validFrom-Klammer unten begrenzt vorwärts.
  let startDateStr: string | null = await getEarliestCareLevelStart(customerId, d);

  const existingAllocations = await budgetAllocationsRepo.selectFrom(d)
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
      (a.source === "carryover") && a.validFrom
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

  // Task #705 — Dedup analog §45b (siehe `initialBalanceSet` oben):
  // Wenn für einen Monat bereits ein `initial_balance` existiert, ist der
  // virtuelle `monthlyAmount`-Beitrag für diesen Monat redundant — sonst
  // verdoppelt sich die Anzeige (Reproducer: §45a 743,60 €/Mo + IB 743,60 €
  // ergab 1.487,20 €).
  const initialBalanceSet45a = new Set(
    initialBalances
      .filter(a => a.month != null)
      .map(a => `${a.year}-${a.month}`)
  );

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
    let monthsInYear = 0;
    for (let mm = yearStartMonth; mm <= yearEndMonth; mm++) {
      if (!initialBalanceSet45a.has(`${opts.year}-${mm}`)) monthsInYear++;
    }
    return monthsInYear * monthlyAmount + ibForYear;
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
    const monthlyContribution = initialBalanceSet45a.has(`${asOfYear}-${asOfMonth}`) ? 0 : monthlyAmount;
    return monthlyContribution + ibForMonth;
  }

  let count = 0;
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    if (!initialBalanceSet45a.has(`${y}-${m}`)) count++;
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
  typeSettings: CustomerBudgetTypeSetting[]
): Promise<number> {
  const { year: curYear } = currentYearAndMonth();

  // Task #1204 — Anker = roher (ungekappter) Pflegegrad-Beginn zur Laufzeit.
  let startDateStr: string | null = await getEarliestCareLevelStart(customerId, d);

  if (!startDateStr) {
    const existingAllocations = await budgetAllocationsRepo.selectFrom(d)
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
        (a.source === "carryover") && a.validFrom
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

  const initialBalances = await budgetAllocationsRepo.selectFrom(d)
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

  // Task #705 — §39/§42a ist ein JAHRES-Topf. Wenn für ein Jahr bereits ein
  // `initial_balance` existiert, ist die zusätzliche `yearlyLimitCents`-
  // Auf­stockung für dieses Jahr Doppelzählung (Reproducer analog §45a).
  const ibYearsSet = new Set(initialBalances.map(a => a.year));

  if (opts.year != null) {
    const ibForYear = initialBalances
      .filter(a => a.year === opts.year)
      .reduce((sum, a) => sum + a.amountCents, 0);
    const inWindow = opts.year >= startYear && opts.year <= endYear;
    const yearlyAlloc = inWindow && !ibYearsSet.has(opts.year) ? yearlyLimitCents : 0;
    return yearlyAlloc + ibForYear;
  }

  if (opts.asOfDate) {
    const asOfYear = parseLocalDate(opts.asOfDate).getFullYear();
    const ibForYear = initialBalances
      .filter(a => a.year === asOfYear)
      .reduce((sum, a) => sum + a.amountCents, 0);
    const inWindow = asOfYear >= startYear && asOfYear <= endYear;
    const yearlyAlloc = inWindow && !ibYearsSet.has(asOfYear) ? yearlyLimitCents : 0;
    return yearlyAlloc + ibForYear;
  }

  const ibTotal = initialBalances.reduce((sum, a) => sum + a.amountCents, 0);
  let yearsWithoutIb = 0;
  for (let y = startYear; y <= endYear; y++) {
    if (!ibYearsSet.has(y)) yearsWithoutIb++;
  }
  return yearsWithoutIb * yearlyLimitCents + ibTotal;
}

async function ensureYearlyCarryover45b(customerId: number, _tx?: DbClient): Promise<BudgetAllocation[]> {
  const d = _tx ?? db;
  const { year: curYear } = currentYearAndMonth();

  // Task #684 — Dedup über ALLE Carryover-Zeilen (aktiv UND soft-gelöscht).
  // Eine vom Admin gelöschte Carryover-Zeile (`deleted_at IS NOT NULL`) ist
  // ein expliziter „nicht regenerieren"-Marker — sonst legt der Auto-Pfad bei
  // der nächsten Budget-Übersicht/-Buchung sofort wieder einen 131 €-Übertrag
  // an und das Löschen wirkt nicht. Für Sum-/Verfügbarkeits-Berechnungen
  // weiter unten brauchen wir aber nur die aktiven Zeilen.
  const allCarryoverAllocations = await budgetAllocationsRepo.selectFrom(d)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
    ));
  const carryoverAllocations = allCarryoverAllocations.filter(a => a.deletedAt == null);

  // Task #716 — Dedup-Sets aus shared SSoT (`buildCarryoverDedupSets`).
  // Umfasst aktive UND soft-gelöschte Zeilen → blockiert sowohl Doppelanlage
  // neben einer manuell gesetzten Zeile (Year-Dedup) als auch die
  // Wiederbelebung einer vom Admin bewusst gelöschten Zeile (Task #684).
  // Window-Dedup (Task #601) ist defensiver Fallback gegen Convention-Drift
  // zwischen Wizard-Pfad (`year = sourceYear`) und Auto-Pfad
  // (`year = targetYear`).
  const { years: existingCarryoverYears, windows: existingCarryoverWindows } = buildCarryoverDedupSets(
    allCarryoverAllocations.map(a => ({
      year: a.year,
      validFrom: a.validFrom,
      expiresAt: a.expiresAt ?? null,
    })),
  );

  const typeSettings = await readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate: todayISO() }, _tx);

  const allAllocations = await budgetAllocationsRepo.selectFrom(d)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      isNull(budgetAllocations.deletedAt)
    ));

  let eligibilityStartYear = curYear;

  // Task #1204 — §45b-Anker zur Laufzeit aus der Pflegegrad-Historie, auf das
  // laufende Jahr gebodet (Onboarding-Baseline, Task #860). Identisch zu
  // `calculateAllocated45b`, sonst driften Summe und Carryover-Anlage.
  let budgetStartDate: string | null = null;
  // Task #724 — Eligibility-Gate wie in `calculateAllocated45b`: der Auto-Anker
  // aus der Pflegegrad-Historie darf nur greifen, wenn §45b aktiviert ist, sonst
  // legte ein nie eingerichteter Topf einen Phantom-Anker an.
  const s45bEnabledCarry = !!typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b" && s.enabled);
  const pgStartCarry = await getEarliestCareLevelStart(customerId, d);
  if (pgStartCarry && s45bEnabledCarry) {
    budgetStartDate = floorAutoAnchor45bToCurrentYear(pgStartCarry, curYear);
  }
  if (!budgetStartDate) {
    const ibEntries = allAllocations.filter(a => a.source === "initial_balance" && a.validFrom);
    if (ibEntries.length > 0) {
      budgetStartDate = ibEntries.reduce((min, a) => a.validFrom < min.validFrom ? a : min).validFrom;
    }
  }
  if (!budgetStartDate) {
    const otherEntries = allAllocations.filter(a =>
      (a.source === "carryover") && a.validFrom
    );
    if (otherEntries.length > 0) {
      budgetStartDate = otherEntries.reduce((min, a) => a.validFrom < min.validFrom ? a : min).validFrom;
    }
  }
  if (!budgetStartDate) {
    if (!s45bEnabledCarry) return [];
    // Task #856 — Auto-Fallback identisch zu `calculateAllocated45b`: ohne
    // Pflegegrad-Historie (pgStartCarry == null) und ohne Allokation ankern wir
    // auf den 1.1. des laufenden Jahres. Kein automatischer Vorjahres-Übertrag
    // für nie eingerichtete Kunden (sonst driften Summe und Carryover-Anlage UND
    // der Auto-Pfad materialisiert 12 × 131 € ohne fachliche Grundlage).
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

  // Task #959 — Universelles Übertrags-Modell: Jahre MIT Startwert
  // (`initial_balance`) rollen ihr Restguthaben ebenfalls in den Folgejahres-
  // Carryover. Die frühere `yearsWithInitialBalance`-Ausnahme (Task #101: kein
  // Auto-Carryover neben einem Startwert, um Doppelzählung zu vermeiden) entfällt,
  // weil der Pool eines Jahres den Startwert bereits über `yearAllocatedCents`
  // (= `sumInitialBalancesForYear`) enthält und der Lesepfad den überrollten
  // Startwert per IB-Supersession aus `initialBalanceTotal` herausrechnet. So
  // verfällt das Restguthaben JEDES Kunden (neu, alt, manuell) als sichtbarer
  // Write-off zum 30.06., statt unbegrenzt als Startwert sichtbar zu bleiben.

  // Bulk-Vorberechnung (Task #442): statt pro Jahr vier separate SUM-Queries
  // abzusetzen, sammeln wir alle relevanten Allocation-IDs sowie den Jahres-
  // bereich einmal vorab und feuern höchstens zwei aggregierte Queries.
  const yearsToProcess = years.filter(y => {
    if (y >= curYear) return false;
    const win = carryoverWindowFor(y);
    const targetWindow = `${win.validFrom}|${win.expiresAt}`;
    return !existingCarryoverYears.has(win.targetYear)
      && !existingCarryoverWindows.has(targetWindow);
  });

  /**
   * In welches Jahr rollte diese Übertragszeile? Über das FENSTER
   * (`valid_from`), NICHT über die Spalte `year`.
   *
   * ── ERSETZT die `year`-Zuordnung (`a.year === year`) ─────────────────────
   * `year` trägt zwei Konventionen nebeneinander: der Auto-Pfad schreibt das
   * ZIELjahr, der Wizard-Pfad vor #601 das QUELLjahr, und der #601-Backfill
   * normalisiert die Spalte nicht. Auf Prod sind 26 Zeilen betroffen. Für die
   * trägt die `year`-Zuordnung den Übertrag dem FALSCHEN Jahr als Zufluss zu —
   * ein Jahr zu früh — und lässt ihn dort Verbrauch absorbieren, den er nie
   * decken konnte.
   *
   * `valid_from` trägt dagegen immer den 01.01. des Zieljahres, unabhängig von
   * der Konvention. Es ist derselbe drift-sichere Schlüssel, den die Dedup-SSoT
   * (`shared/domain/budget-carryover-dedup.ts`) benennt und den das Messwerkzeug
   * als `--keying=window` fährt.
   *
   * Die Wahl war bis zur Expositionsmessung eine OFFENE fachliche Frage und ist
   * jetzt entschieden: unter `year` weist die Messung 7 Kunden-Jahre mit
   * Phantom-Übertrag aus, unter `window` keinen einzigen.
   *
   * ── EHRLICHE EINORDNUNG: hier wirkt sie (noch) nicht ────────────────────
   * Gemessen ist die Umstellung im SCHREIBPFAD verhaltensneutral, seit die
   * Absorption aus dem Ledger kommt. Eine falsch zugeordnete Übertragszeile
   * bringt ihren verlinkten Verbrauch in `netConsumed` UND in `absorbed` ein,
   * in gleicher Höhe — beides hebt sich auf, solange nicht mehr auf sie
   * gebucht wurde als ihr Betrag hergibt. Ein Test, der hier einen Unterschied
   * behauptet, wäre falsch; es gibt deshalb keinen.
   *
   * Sie bleibt trotzdem, aus zwei Gründen: sie ist die inhaltlich richtige
   * Zuordnung (das Fenster sagt, in welches Jahr die Zeile rollte, `year` sagt
   * je nach Konvention etwas anderes), und sie bringt den Schreibpfad auf
   * dasselbe Modell wie das MESSWERKZEUG, wo sie sehr wohl wirkt — dort
   * trennt sie Zufluss von persistiertem Abfluss und ist der Grund für die
   * 7-gegen-0-Differenz. Zwei Modelle nebeneinander wären genau die Drift,
   * die diesen Cluster ausgelöst hat.
   *
   * NICHT mitgeändert: die Dedup-Sets (`buildCarryoverDedupSets`) und damit
   * `yearsToProcess`. Die beantworten eine andere Frage — „existiert für dieses
   * Zieljahr schon eine Zeile" — und prüfen bereits BEIDE Schlüssel per ODER.
   * Sie sind damit ohnehin die konservativere Seite; sie hier mitzudrehen wäre
   * ein zweiter Eingriff mit Doppelanlage-Risiko.
   */
  const zieljahrVon = (a: { year: number; validFrom: string }): number =>
    carryoverTargetYear({ ...a, month: null, amountCents: 0, source: "carryover", expiresAt: null } as AllocRow, "window");

  const linkedIdsByYear = new Map<number, number[]>();
  const allLinkedIdsSet = new Set<number>();
  for (const year of yearsToProcess) {
    const specialIds = allAllocations
      .filter(a => a.year === year && a.source !== "carryover")
      .map(a => a.id);
    const carryoverIds = carryoverAllocations
      .filter(a => zieljahrVon(a) === year)
      .map(a => a.id);
    const ids = [...specialIds, ...carryoverIds];
    linkedIdsByYear.set(year, ids);
    for (const id of ids) allLinkedIdsSet.add(id);
  }
  const allLinkedIds = Array.from(allLinkedIdsSet);

  /**
   * Verbrauchs-Summen: je Allocation (verlinkt) und je Jahr (NULL-Leg).
   *
   * ── `write_off` ist AUSGESCHLOSSEN ────────────────────────────────────
   * Er ist kein Verbrauch gegen den eigenen Jahrestopf, sondern das Verfallen
   * des hereingerollten Übertrags. Vorher zählte er mit, und das war keine
   * Nachlässigkeit, sondern die Krücke der alten Formel: `netConsumed −
   * totalCarryoverIn` kam über den mitgezählten Write-Off aufs richtige
   * Ergebnis — aber nur, solange `processExpiredCarryover` bereits gelaufen
   * war. Mit der ledger-basierten Absorption unten wird die Krücke nicht mehr
   * gebraucht und wäre eine Doppelzählung.
   */
  const linkedConsumption = new Map<number, number>();
  const linkedReversal = new Map<number, number>();
  const unlinkedConsumption = new Map<number, number>();
  const unlinkedReversal = new Map<number, number>();

  if (allLinkedIds.length > 0) {
    const linkedRows = await d.select({
      allocationId: budgetTransactions.allocationId,
      transactionType: budgetTransactions.transactionType,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'reversal')`,
      inArray(budgetTransactions.allocationId, allLinkedIds),
    )).groupBy(budgetTransactions.allocationId, budgetTransactions.transactionType);

    for (const row of linkedRows) {
      if (row.allocationId == null) continue;
      const total = Number(row.total ?? 0);
      const ziel = row.transactionType === "reversal" ? linkedReversal : linkedConsumption;
      ziel.set(row.allocationId, (ziel.get(row.allocationId) ?? 0) + total);
    }
  }

  if (yearsToProcess.length > 0) {
    const unlinkedRows = await d.select({
      year: sql<number>`EXTRACT(YEAR FROM ${budgetTransactions.transactionDate})::int`,
      transactionType: budgetTransactions.transactionType,
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'reversal')`,
      isNull(budgetTransactions.allocationId),
      gte(budgetTransactions.transactionDate, `${Math.min(...yearsToProcess)}-01-01`),
      lte(budgetTransactions.transactionDate, `${Math.max(...yearsToProcess)}-12-31`),
    )).groupBy(
      sql`EXTRACT(YEAR FROM ${budgetTransactions.transactionDate})`,
      budgetTransactions.transactionType,
    );

    for (const row of unlinkedRows) {
      const y = Number(row.year);
      const total = Number(row.total ?? 0);
      const ziel = row.transactionType === "reversal" ? unlinkedReversal : unlinkedConsumption;
      ziel.set(y, (ziel.get(y) ?? 0) + total);
    }
  }

  /** Netto (`consumption − reversal`) über eine Menge von Allocation-IDs. */
  const nettoUeberIds = (ids: number[]): number => {
    let verbraucht = 0, storniert = 0;
    for (const id of ids) {
      verbraucht += linkedConsumption.get(id) ?? 0;
      storniert += linkedReversal.get(id) ?? 0;
    }
    return Math.max(0, verbraucht - storniert);
  };

  for (const year of yearsToProcess) {
    const targetYear = year + 1;

    const yearAllocatedCents = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year }, _tx, undefined, typeSettings);

    const carryoverIntoThisYear = carryoverAllocations.filter(a => zieljahrVon(a) === year);
    const totalCarryoverIn = carryoverIntoThisYear.reduce((sum, a) => sum + a.amountCents, 0);

    // Task #1392 — KEIN Carryover-Chaining. Es rollt ausschließlich das im Jahr
    // `year` SELBST entstandene Restguthaben (`yearAllocatedCents` =
    // Monatsaufstockung + Startwert + manuelle Anpassung des Jahres) in den
    // Folgejahres-Übertrag. Ein bereits aus (year-1) hereingerollter Übertrag
    // (`totalCarryoverIn`) verfällt zu SEINER eigenen Frist (30.06.`year`) über
    // `processExpiredCarryover` und darf NICHT erneut weitergerollt werden —
    // andernfalls überlebt ein Rest aus Quelljahr Y rechtswidrig über den
    // 30.06.(Y+1) hinaus (Chaining: Y → Übertrag in Y+1 → Übertrag in Y+2 …).
    //
    // ── ABSORPTION AUS DEM LEDGER (ERSETZT `netConsumed − totalCarryoverIn`) ──
    //
    // Vorher stand hier:
    //
    //     const consumedAgainstOwnYear = Math.max(0, netConsumed - totalCarryoverIn);
    //
    // Das ließ den hereingerollten Übertrag Verbrauch in Höhe seines vollen
    // Betrags absorbieren — unabhängig davon, ob er ihn laut Buchung getragen
    // hat. Solange `processExpiredCarryover` schon gelaufen war, glich der
    // mitgezählte Write-Off das aus; VOR dem Verfall (und `syncCarryoverAndExpiry`
    // rief die Anlage bis zu diesem PR zuerst) fehlte der Ausgleich und der
    // eigene Jahrestopf wurde zu wenig belastet → Übertrag zu groß →
    // Verfügbarkeit zu hoch → höhere §45b-Forderung an die Pflegekasse.
    //
    // Was ihn ERSETZT: der Betrag, den der Übertrag laut LEDGER getragen hat —
    // die Summe der Buchungen mit seiner `allocation_id`.
    //
    // WARUM das die 30.06.-Frist bereits respektiert und hier keine
    // Datumsregel nötig ist: `computeFifoAvailability` nimmt eine Übertrags-
    // Allocation nur in die FIFO-Kette auf, solange `expiresAt >= transactionDate`
    // der Buchung. Eine Buchung nach der Frist kann per Konstruktion nicht
    // gegen ihn verlinkt werden. Die Frist ist also beim BUCHEN durchgesetzt und
    // im Buchungssatz festgehalten; sie hier aus Daten neu abzuleiten wäre ein
    // Zweitbegriff derselben Frage — und der verliert gegen den Ledger. Genau
    // daran ist die datumsbasierte Fassung dieses PR gescheitert (Gate-2 B1):
    // sie hat Verbrauch als absorbiert gerechnet, den der Write-Off gleichzeitig
    // als verfallen auswies, und dieselben Cent doppelt gedeckt.
    //
    // `Math.min` gegen `totalCarryoverIn`: mehr als sein eigener Betrag kann ein
    // Übertrag nicht tragen, auch wenn Fehlbuchungen mehr auf ihn zeigen.
    //
    // Die Zuordnung Übertrag→Jahr läuft über das FENSTER (`zieljahrVon`, oben
    // begründet) statt über die Spalte `year`.
    const netConsumed = nettoUeberIds(linkedIdsByYear.get(year) ?? [])
      + Math.max(0, (unlinkedConsumption.get(year) ?? 0) - (unlinkedReversal.get(year) ?? 0));
    const absorbedByCarryIn = Math.min(
      totalCarryoverIn,
      nettoUeberIds(carryoverIntoThisYear.map(a => a.id)),
    );
    const unused = carryoverOutSollFor({
      sourceYearAllocatedCents: yearAllocatedCents,
      netConsumptionYearCents: netConsumed,
      absorbedByCarryInCents: absorbedByCarryIn,
    });

    if (unused <= 0) continue;

    const result = await d.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: targetYear,
      month: null,
      amountCents: unused,
      source: "carryover",
      validFrom: `${targetYear}-01-01`,
      // Frist aus der SSoT — dieselbe Konstante wie `carryoverWindowFor` und der
      // Verfalls-Boden im Lesepfad. Diese dritte Kopie des Literals hat der
      // Rueckfall-Waechter gefunden (`tests/architecture/45b-null-leg-exclusion.test.ts`).
      expiresAt: carryoverExpiresAtFor(targetYear),
      notes: `Übertrag aus ${year}: ${formatEuroDE(unused)} (verfällt 30.06.${targetYear})`,
    }).onConflictDoNothing().returning();

    if (result[0]) created.push(result[0]);
  }

  return created;
}

export async function processExpiredCarryover(customerId: number, _tx?: DbClient): Promise<import("@shared/schema").BudgetTransaction[]> {
  const d = _tx ?? db;
  // §45b-Verfall-as-of — `todayISO()` ist hier RICHTIG und bleibt (geprüft, nicht
  // übernommen): Die Frage dieser Funktion lautet „welche Frist ist JETZT
  // abgelaufen", nicht „wie war der Stand zu einem Stichtag". Sie hat keinen
  // as-of-Parameter und wird als Seiteneffekt aus Buchungs-/Lesepfaden mit
  // beliebigem `transactionDate` gerufen — ein Buchungsdatum als Kriterium
  // würde Verfall je nach gebuchtem Termin vor- oder zurückdatieren.
  // Falsch war nicht das Auswahl-Kriterium, sondern das DATUM der erzeugten
  // Buchung (siehe `writeOffDate` unten) und dass die Pro-Allocation-Sicht im
  // `consumption-engine` diese später datierte Zeile ohne as-of-Filter gegen
  // rückwirkende Buchungen gerechnet hat.
  // `expiresAt < today` ist strikt: am 30.06. ist der Übertrag noch nutzbar,
  // erst ab dem 01.07. verfällt er — deckungsgleich zum `writeOffDate`.
  const today = todayISO();

  const expiredAllocations = await budgetAllocationsRepo.selectFrom(d)
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
    // §45b-Verfall-as-of — Der Verfall wird auf den ERSTEN Tag NACH der Frist datiert
    // (30.06. → 01.07.), nicht auf die Frist selbst.
    //
    // §45b Abs. 3 lässt das Guthaben mit ABLAUF des 30.06. verfallen — der
    // 30.06. gehört also noch zum nutzbaren Fenster, und genau so filtert die
    // Allocation-Auswahl (`expiresAt >= Stichtag`, einschließend). Ein auf den
    // 30.06. datierter Write-Off machte den Topf ausgerechnet an seinem letzten
    // gültigen Tag leer: die Verbrauchs-Summen zählen `transactionDate <=
    // Stichtag`, der Write-Off fiel damit in den 30.06. selbst und zehrte ihn
    // auf. Eine legitime 30.06.-Buchung war nach dem Verfallslauf blockiert.
    // Mit dem 01.07. liegt die Verfallsbuchung erstmals außerhalb des Fensters.
    const writeOffDate = addDays(allocation.expiresAt!, 1);

    const writeOff = await d.insert(budgetTransactions).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: writeOffDate,
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
  // ── REIHENFOLGE: erst Verfall, dann Anlage (ERSETZT die umgekehrte) ──────
  //
  // Vorher lief die Anlage zuerst. Das war die Ursachen-Hälfte des
  // §45b-Übertragsdefekts, die keine Formel behebt: `ensureYearlyCarryover45b`
  // las den Verbrauchsstand des Quelljahres, BEVOR der hereingerollte Übertrag
  // seinen Verfalls-`write_off` bekommen hatte. Die alte, betrags-basierte
  // Verrechnung (`netConsumed − totalCarryoverIn`) hing genau an diesem
  // Write-Off, um auf das richtige Ergebnis zu kommen — fehlte er, wurde der
  // eigene Jahrestopf zu wenig belastet und ein zu hoher Übertrag persistiert.
  //
  // Fachlich ist diese Reihenfolge ohnehin die richtige: ein Übertrag, dessen
  // Frist abgelaufen ist, gehört abgeschlossen, bevor der nächste entsteht.
  // Zwischen den beiden Schritten sieht ein Leser sonst kurzzeitig einen
  // neuen Übertrag neben einem alten, der längst tot ist.
  //
  // Der Roll selbst liest den Verbrauch inzwischen aus der Verlinkung und
  // braucht den Write-Off nicht mehr (siehe `ensureYearlyCarryover45b`). Die
  // Reihenfolge bleibt trotzdem so — sie ist die zweite, unabhängige Lage
  // gegen dieselbe Fehlerklasse, und sie kostet nichts.
  //
  // EINE Folge, die zu kennen ist: ein in DIESEM Lauf neu angelegter Übertrag,
  // dessen Frist schon vorbei ist (Roll eines weit zurückliegenden Jahres),
  // bekommt seinen Write-Off erst beim NÄCHSTEN Sync statt sofort. Auf die
  // Verfügbarkeit wirkt das nicht — `carryoverCounted` verlangt
  // `expiresAt >= Stichtag` und zählt so eine Zeile ohnehin nicht.
  await processExpiredCarryover(customerId, _tx);
  await ensureYearlyCarryover45b(customerId, _tx);
}

