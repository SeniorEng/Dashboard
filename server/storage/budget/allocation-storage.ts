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
import { eq, and, sql, lte, gte, isNull, isNotNull, desc, asc, inArray } from "drizzle-orm";
import { todayISO, parseLocalDate, currentYearAndMonth, lastDayOfMonth } from "@shared/utils/datetime";
import { BUDGET_45B_MAX_MONTHLY_CENTS, floorAutoAnchor45bToCurrentYear, clampToStatutoryMax, resolve45aMonthlyLimitCents } from "@shared/domain/budgets";
import { enumerate45bStatutoryMonths, sum45bStatutoryMonths } from "@shared/domain/budget/statutory-45b";
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

/**
 * Task #911 — Phasen-bewusste Auswahl der für einen Monat wirksamen §45b-
 * `customer_budget_type_settings`-Zeile. SSoT für die Monats-Aufstockung
 * (`monthlyAmountFor` unten) UND für die in der Overview/Summary angezeigte
 * `monthlyLimitCents` (`getBudgetSummary`). Vorher leitete die Anzeige den
 * Limit-Wert aus einer einzigen `forDate(heute)`-Zeile ab, während die
 * Allocation über ALLE Phasen iterierte — eine erst im Folge-Append wirksame
 * Phase (z.B. `validFrom = morgen`, aber bis Monatsende in Kraft) reduzierte
 * den Topf korrekt, die UI zeigte aber `null`.
 *
 * Auswahl analog `monthlyAmountFor`: gegen das **Monatsende** geprüft (eine im
 * laufenden Monat ab Tag > 15 wirksame Phase matcht trotzdem), die Zeile mit
 * dem spätesten `validFrom`, deren Fenster den Monat berührt, gewinnt. `rows`
 * darf in beliebiger Reihenfolge übergeben werden.
 */
export function pickEffective45bSettingRow(
  rows: CustomerBudgetTypeSetting[],
  year: number,
  month: number,
): CustomerBudgetTypeSetting | undefined {
  if (rows.length === 0) return undefined;
  const monthEnd = lastDayOfMonth(year, month);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const sorted = [...rows].sort((a, b) => {
    const av = a.validFrom ?? "";
    const bv = b.validFrom ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    const startsByMonthEnd = r.validFrom == null || r.validFrom <= monthEnd;
    const endsAfterMonthStart = r.validTo == null || r.validTo >= monthStart;
    if (startsByMonthEnd && endsAfterMonthStart) return r;
  }
  return undefined;
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
  let budgetStartDate: string | null = null;
  // Task #724 — Der automatisch aus der Pflegegrad-Historie abgeleitete Anker
  // darf den Eligibility-Gate NICHT umgehen: §45b akkumuliert nur, wenn der
  // Topf in mindestens einer Phase aktiviert ist. Ein Pflegekasse-Kunde MIT
  // Pflegegrad-Historie, aber OHNE §45b-Einrichtung (kein type-setting) zeigte
  // sonst einen Phantom-Topf — 131 €/Monat ist ein fixer statutorischer Betrag,
  // anders als §45a greift hier KEIN `monthlyAmount==0`-Schutz. Echte
  // persistierte Mittel (initial_balance/carryover) ankern weiterhin
  // unabhängig vom Gate über die Fallbacks unten.
  // Task #1766 — Herkunft des Ankers festhalten. Der `initialBalanceMonths`-
  // `allocStart`-Shift (unten) darf die Monatsansammlung der Monate VOR einem
  // Startwert nur dann wegschneiden, wenn der Startwert SELBST die Anker-Herkunft
  // ist (Onboarding ohne frühere Eligibility). Liegt eine frühere Eligibility vor
  // (Pflegegrad-Historie / Carryover / gelöschter Startwert / Fallback), akkumulieren
  // die Monate davor weiter; die Doppelzählung des Startwert-Monats verhindert allein
  // der `initialBalanceSet`-Skip-Set (Antje Jungnickel: Anker 01/2026, Startwert
  // 07/2026 → 917 € statt fälschlich 131 €).
  let anchorFromInitialBalance = false;
  const s45bEnabled = all45bSettings.some(s => s.enabled);
  const pgStart = await getEarliestCareLevelStart(customerId, d);
  if (pgStart && s45bEnabled) {
    budgetStartDate = floorAutoAnchor45bToCurrentYear(pgStart, curYear);
  }

  if (!budgetStartDate) {
    const initialBalances = existingAllocations
      .filter(a => a.source === "initial_balance" && a.validFrom);
    if (initialBalances.length > 0) {
      budgetStartDate = initialBalances.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
      anchorFromInitialBalance = true;
    }
  }

  if (!budgetStartDate) {
    const carryoverEntries = existingAllocations
      .filter(a => a.source === "carryover" && a.validFrom);
    if (carryoverEntries.length > 0) {
      budgetStartDate = carryoverEntries.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
    }
  }

  // Task #1262 — Anker-Fallback aus SOFT-GELÖSCHTEN initial_balance-Zeilen.
  //
  // Ein soft-gelöschter Startwert ist weiterhin Beleg dafür, dass §45b für
  // diesen Kunden eingerichtet wurde. Ohne diesen Fallback verlöre die
  // Allocation nach dem Soft-Delete ALLER aktiven Startwerte ihren Anker:
  // `existingAllocations` (nur aktive Zeilen) wäre §45b-leer, und ohne
  // aktivierte `customer_budget_type_settings` (`s45bEnabled = false`) griffe
  // unten das Eligibility-Gate → harter `return 0`. Der gelöschte Monat würde
  // damit die reguläre 131-€-Monatsaufstockung DAUERHAFT blockieren (Task
  // #642), obwohl ein gelöschter Startwert exakt dorthin zurückkehren muss.
  //
  // Wir ankern daher zusätzlich an der frühesten `validFrom` aller (auch
  // soft-gelöschter) Startwerte. Das Skip-Set unten (`initialBalanceMonths`)
  // zählt unverändert nur AKTIVE Startwerte, sodass gelöschte Monate wieder
  // die Monatsaufstockung erhalten und ein noch aktiver Startwert seinen
  // Monat weiterhin belegt (Doppelzählungsschutz aus Task #101 bleibt).
  if (!budgetStartDate) {
    const deletedInitialBalances = await budgetAllocationsRepo.selectFrom(d)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "initial_balance"),
        isNotNull(budgetAllocations.deletedAt),
      ));
    const withValidFrom = deletedInitialBalances.filter(a => a.validFrom);
    if (withValidFrom.length > 0) {
      budgetStartDate = withValidFrom.reduce((min, a) =>
        a.validFrom < min.validFrom ? a : min
      ).validFrom;
    }
  }

  if (!budgetStartDate) {
    // Task #885 — Eligibility/Anker-Gate darf NICHT nur am Heute-Stand
    // (`typeSettings`, forDate today) hängen: Ein §45b-Settings-Fenster, das
    // im abgefragten Zeitraum (Jahr/asOfDate) gültig war, aber bis „heute"
    // bereits abgelaufen ist (validTo in der Vergangenheit), würde sonst zum
    // harten `return 0` führen — die Monats-Aufstockung des Gültigkeitsmonats
    // verschwände komplett. Wir prüfen daher gegen ALLE §45b-Zeilen
    // (`all45bSettings`, datumsunabhängig). Das Windowing übernimmt weiterhin
    // der allocStart/end-Shift weiter unten (validFrom/validTo-Klammer).
    if (!s45bEnabled) return { allocatedCents: 0, excludedSpecialAllocationIds: [] };
    // Task #1204 — kein Pflegegrad und keine Allokation: Jahresanfang als Anker.
    budgetStartDate = `${curYear}-01-01`;
  }

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

  // Task #1766 — Der Shift greift NUR NOCH, wenn der Startwert selbst die
  // Anker-Herkunft ist (`anchorFromInitialBalance`, Onboarding ohne frühere
  // Eligibility). Existiert eine frühere Eligibility (Pflegegrad-Historie o.Ä.),
  // schöbe der Shift `allocStart` auf den Monat NACH dem spätesten Startwert und
  // schnitte damit die komplette davorliegende Monatsansammlung weg (Antje: Anker
  // 01/2026, Startwert 07/2026 → allocStart 08/2026 > Horizont 07/2026 → 0 Monate,
  // nur 131 € statt 917 €). Die Doppelzählung des Startwert-Monats verhindert
  // unabhängig davon der `initialBalanceSet`-Skip-Set unten.
  if (anchorFromInitialBalance && initialBalanceMonths.length > 0) {
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

  const initialBalanceSet = new Set(
    initialBalanceMonths.map(ib => `${ib.year}-${ib.month}`)
  );

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
  const effectiveS45bValidFrom = all45bSettings.length > 0
    ? all45bSettings[0].validFrom // selectFrom oben asc sortiert
    : (s45b?.validFrom ?? null);

  if (effectiveS45bValidFrom) {
    const vfDate = parseLocalDate(effectiveS45bValidFrom);
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
    if (opts.projectFuture) {
      // Task #704: Vorausschau-Modus für „Geplant"-Forecast. Horizont darf in
      // die Zukunft wandern, damit zukünftige Monatsaufstockungen + ablaufende
      // Carryovers in die Projektion einfließen. Echte Buchungen (cost-estimate,
      // consumeFifo) verwenden weiterhin den Default (capped auf heute), um
      // nicht für noch nicht angefallene Monate vorzuziehen.
      horizonYear = asOfYear;
      horizonMonth = asOfMonth;
    } else if (asOfYear < curYear || (asOfYear === curYear && asOfMonth < curMonth)) {
      horizonYear = asOfYear;
      horizonMonth = asOfMonth;
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
  const expiryFloorAnchorYear = horizonMonth <= 6 ? horizonYear - 1 : horizonYear;
  if (opts.year == null) {
    if (expiryFloorAnchorYear > allocStartYear) {
      allocStartYear = expiryFloorAnchorYear;
      allocStartMonth = 1;
    }
  }

  let endYear = horizonYear;
  let endMonth = horizonMonth;
  // Analog zum validFrom-Shift: bei mehreren §45b-Zeilen die SPÄTESTE
  // `validTo` heranziehen. Eine offene Zeile (`validTo = null`) bedeutet
  // unbegrenzte Geltung — dann kein End-Shift.
  let effectiveS45bValidTo: string | null = null;
  if (all45bSettings.length > 0) {
    const hasOpenEnd = all45bSettings.some(r => r.validTo == null);
    if (!hasOpenEnd) {
      effectiveS45bValidTo = all45bSettings.reduce<string | null>(
        (max, r) => (max == null || (r.validTo != null && r.validTo > max) ? r.validTo : max),
        null,
      );
    }
  } else {
    effectiveS45bValidTo = s45b?.validTo ?? null;
  }

  if (effectiveS45bValidTo) {
    const vtDate = parseLocalDate(effectiveS45bValidTo);
    const vtYear = vtDate.getFullYear();
    const vtMonth = vtDate.getMonth() + 1;
    if (vtYear < endYear || (vtYear === endYear && vtMonth < endMonth)) {
      endYear = vtYear;
      endMonth = vtMonth;
    }
  }

  // Task #872 — §45b-Monatsaufstockung als reine SSoT-Aufzählung. Identisch zur
  // historischen Monat-für-Monat-Schleife (allocStart→end, Startwert-Monate
  // übersprungen, historisierter Monatsbetrag pro Monat), nur ausgelagert in
  // `enumerate45bStatutoryMonths` — gleichzeitig die Quelle der materialisierten
  // `statutory_monthly`-Zeilen und der Backfill-Reconciliation.
  const statutoryMonths = enumerate45bStatutoryMonths({
    allocStartYear,
    allocStartMonth,
    endYear,
    endMonth,
    initialBalanceMonthKeys: initialBalanceSet,
    monthlyAmountFor,
  });

  if (opts.year != null) {
    const yearMonthlyTotal = sum45bStatutoryMonths(
      statutoryMonths.filter(s => s.year === opts.year),
    );
    return {
      allocatedCents: yearMonthlyTotal + sumInitialBalancesForYear(existingAllocations, opts.year),
      excludedSpecialAllocationIds: [],
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
  const ibCounted = (a: { source: string; validFrom: string; year: number }) =>
    a.source === "initial_balance" &&
    a.validFrom <= ibDateLimit &&
    a.year >= ibFloorYear &&
    !supersededIbYears.has(a.year);
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
  const { excludedSpecialAllocationIds } = await calculateAllocated45b(
    customerId,
    { asOfDate, projectFuture: opts?.projectFuture },
    d,
    typeSettings,
  );
  if (excludedSpecialAllocationIds.length === 0) {
    return { excludedSpecialAllocationIds, excludedConsumedNetCents: 0 };
  }

  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      inArray(budgetTransactions.allocationId, excludedSpecialAllocationIds),
      lte(budgetTransactions.transactionDate, asOfDate),
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      eq(budgetTransactions.transactionType, "reversal"),
      inArray(budgetTransactions.allocationId, excludedSpecialAllocationIds),
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

    const yearAllocatedCents = await calculateAllocatedCents(customerId, "entlastungsbetrag_45b", { year }, _tx, undefined, typeSettings);

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

    // Task #1392 — KEIN Carryover-Chaining. Es rollt ausschließlich das im Jahr
    // `year` SELBST entstandene Restguthaben (`yearAllocatedCents` =
    // Monatsaufstockung + Startwert + manuelle Anpassung des Jahres) in den
    // Folgejahres-Übertrag. Ein bereits aus (year-1) hereingerollter Übertrag
    // (`totalCarryoverIn`) verfällt zu SEINER eigenen Frist (30.06.`year`) über
    // `processExpiredCarryover` und darf NICHT erneut weitergerollt werden —
    // andernfalls überlebt ein Rest aus Quelljahr Y rechtswidrig über den
    // 30.06.(Y+1) hinaus (Chaining: Y → Übertrag in Y+1 → Übertrag in Y+2 …).
    //
    // Verbrauch ist FIFO (hereingerollter Übertrag wird zuerst aufgezehrt, da er
    // früher verfällt): nur Verbrauch ÜBER `totalCarryoverIn` hinaus belastet das
    // eigene Jahresguthaben. So bleibt der Übertrag die Differenz aus dem
    // EIGENEN Jahresanspruch minus dem darauf entfallenden Verbrauch.
    const consumedAgainstOwnYear = Math.max(0, netConsumed - totalCarryoverIn);
    const unused = Math.max(0, yearAllocatedCents - consumedAgainstOwnYear);

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

