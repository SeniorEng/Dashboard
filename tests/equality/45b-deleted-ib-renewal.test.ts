/**
 * Task #642 — §45b: soft-gelöschte initial_balance-Monate dürfen die
 * monatliche Auto-Aufstockung (131 €) NICHT permanent blockieren.
 *
 * Drei Drift-Szenarien gegen `calculateAllocatedCents`:
 *
 *   1. delete-then-renew
 *      Einzelner Startwert für Monat M wird gesetzt und anschließend
 *      soft-gelöscht. Nach dem Löschen muss Monat M wieder mit dem regulären
 *      `monthlyAmount` (131 €) in die Allocation einfließen.
 *
 *   2. duplicate-with-one-active
 *      Zwei Startwerte für Monat M (einer aktiv, einer soft-gelöscht). Solange
 *      ein Startwert aktiv ist, gilt M weiterhin als belegt — es darf KEIN
 *      zusätzliches Auto-Renewal für M obendrauf kommen (Schutz aus #101).
 *
 *   3. both-deleted
 *      Beide Startwerte für Monat M sind soft-gelöscht → Monat M kehrt zur
 *      regulären Aufstockung zurück.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  calculateAllocatedCents,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import { createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";
import { upsertBudgetPreferences } from "../../server/storage/budget/preferences-storage";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

const BUDGET_TYPE = "entlastungsbetrag_45b";
const MONTHLY_CENTS = 13100; // 131 € gesetzlicher Default
const IB_CENTS = 50000;       // 500 € Startwert, willkürlich

async function getActorUserId(): Promise<number> {
  const rows = await db.execute(
    /* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`,
  );
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T642_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id;
}

async function softDeleteAllActive(customerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: budgetAllocations.id })
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));
  for (const r of rows) {
    await db.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, r.id));
  }
  return rows.map(r => r.id);
}

/**
 * Wir benutzen einen Stichtag exakt 4 Monate nach dem IB-Monat. So sehen die
 * Berechnungen unabhängig von der Wall-Clock einen deterministischen Horizont
 * (Monate M..M+4 ergeben 5 Monate Auto-Renewal, sofern nichts blockiert).
 */
const IB_YEAR = 2026;
const IB_MONTH = 1;
const AS_OF = "2026-05-15";        // Mai = Monat 5 → 5 Monate Horizont
const EXPECTED_MONTHS_TOTAL = 5;   // Jan..Mai inklusive

describe("Task #642 — §45b deleted initial_balance darf Auto-Renewal nicht blockieren", () => {
  it("Case 1: delete-then-renew — gelöschter IB-Monat kehrt zur Aufstockung zurück", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T642-CASE1");

    await upsertBudgetPreferences({
      customerId,
      budgetStartDate: `${IB_YEAR}-0${IB_MONTH}-01`,
    }, userId);

    await upsertInitialBalanceAllocation({
      customerId,
      budgetType: BUDGET_TYPE,
      year: IB_YEAR,
      month: IB_MONTH,
      amountCents: IB_CENTS,
      validFrom: `${IB_YEAR}-0${IB_MONTH}-01`,
      expiresAt: null,
    }, userId);

    // VOR Delete: IB belegt M, Auto-Renewal liefert M+1..M+4 (4 Monate).
    const beforeDelete = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: AS_OF });
    expect(beforeDelete).toBe(IB_CENTS + (EXPECTED_MONTHS_TOTAL - 1) * MONTHLY_CENTS);

    // NACH Delete: alle 5 Monate (M..M+4) bekommen Auto-Renewal.
    await softDeleteAllActive(customerId);
    const afterDelete = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: AS_OF });
    expect(afterDelete).toBe(EXPECTED_MONTHS_TOTAL * MONTHLY_CENTS);
  });

  it("Case 2: duplicate-with-one-active — aktiver IB blockiert seinen Monat weiterhin", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T642-CASE2");

    await upsertBudgetPreferences({
      customerId,
      budgetStartDate: `${IB_YEAR}-0${IB_MONTH}-01`,
    }, userId);

    // Erste Zeile setzen, dann soft-deleten — der nächste Upsert legt eine
    // GoBD-konforme Ersatz-Zeile an (Resurrect ist verboten).
    await upsertInitialBalanceAllocation({
      customerId, budgetType: BUDGET_TYPE,
      year: IB_YEAR, month: IB_MONTH, amountCents: IB_CENTS,
      validFrom: `${IB_YEAR}-0${IB_MONTH}-01`, expiresAt: null,
    }, userId);
    await softDeleteAllActive(customerId);

    // Neue aktive Zeile für denselben Monat.
    await upsertInitialBalanceAllocation({
      customerId, budgetType: BUDGET_TYPE,
      year: IB_YEAR, month: IB_MONTH, amountCents: IB_CENTS,
      validFrom: `${IB_YEAR}-0${IB_MONTH}-01`, expiresAt: null,
    }, userId);

    // Erwartung: aktive Zeile (IB_CENTS) + 4 Monate Auto-Renewal.
    // KEIN doppelter 131-€-Topf für Monat M.
    const total = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: AS_OF });
    expect(total).toBe(IB_CENTS + (EXPECTED_MONTHS_TOTAL - 1) * MONTHLY_CENTS);
  });

  it("Case 3: both-deleted — beide Zeilen weg → voller Auto-Renewal-Zeitraum", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T642-CASE3");

    await upsertBudgetPreferences({
      customerId,
      budgetStartDate: `${IB_YEAR}-0${IB_MONTH}-01`,
    }, userId);

    await upsertInitialBalanceAllocation({
      customerId, budgetType: BUDGET_TYPE,
      year: IB_YEAR, month: IB_MONTH, amountCents: IB_CENTS,
      validFrom: `${IB_YEAR}-0${IB_MONTH}-01`, expiresAt: null,
    }, userId);
    await softDeleteAllActive(customerId);

    await upsertInitialBalanceAllocation({
      customerId, budgetType: BUDGET_TYPE,
      year: IB_YEAR, month: IB_MONTH, amountCents: IB_CENTS,
      validFrom: `${IB_YEAR}-0${IB_MONTH}-01`, expiresAt: null,
    }, userId);
    await softDeleteAllActive(customerId);

    // Keine aktiven IBs mehr — alle 5 Monate (M..M+4) bekommen Auto-Renewal.
    const total = await calculateAllocatedCents(customerId, BUDGET_TYPE, { asOfDate: AS_OF });
    expect(total).toBe(EXPECTED_MONTHS_TOTAL * MONTHLY_CENTS);
  });
});
