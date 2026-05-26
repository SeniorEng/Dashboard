/**
 * Task #608 — §45b Carryover/Startwert ist im UI sichtbar UND löschbar,
 * und das Löschen neutralisiert die Legacy-Felder in
 * `customer_budget_type_settings`, damit kein Geister-Übertrag
 * re-materialisiert wird.
 *
 * Abgedeckte Verträge:
 *   1) `getInitialBalanceAllocations` listet für §45b sowohl
 *      `source='initial_balance'` als auch `source='carryover'` (anders als
 *      §45a/§39, die nur Startwerte kennen).
 *   2) `clearLegacyInitialBalanceFromSettings` nullt
 *      `initialBalanceCents`/`initialBalanceMonth` auf der offenen
 *      Settings-Zeile in-place, schreibt ein
 *      `budget_type_settings_initial_balance_cleared`-Audit-Log und ist
 *      idempotent (zweiter Aufruf → no-op, kein zweiter Audit-Eintrag).
 *   3) Der Helper wird in einer separaten Transaktion ausgeführt, d.h. ein
 *      Fehler im aufrufenden Kontext führt zu kompletten Rollback.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  auditLog,
  budgetAllocations,
  customerBudgetTypeSettings,
} from "@shared/schema";
import {
  getInitialBalanceAllocations,
  upsertInitialBalanceAllocation,
} from "../../server/storage/budget/allocation-storage";
import { clearLegacyInitialBalanceFromSettings } from "../../server/storage/budget/preferences-storage";
import {
  apiDelete,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";
import {
  SETTINGS_VALID_FROM_EPOCH,
  upsertBudgetTypeSettings,
  getActiveBudgetTypeSettings,
} from "../../server/storage/budget/preferences-storage";
import { todayISO } from "@shared/utils/datetime";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

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
    nachname: `T608_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id;
}

describe("T608 — getInitialBalanceAllocations enthält Carryover für §45b", () => {
  it("listet sowohl initial_balance als auch carryover Allokationen für §45b", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T608-LIST");

    await upsertInitialBalanceAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", year: 2025, month: 1, amountCents: 50000, validFrom: "2025-01-01", expiresAt: null, notes: "Startwert" },
      userId,
    );
    // Carryover-Allokationen werden vom Year-End-Recompute (nicht vom Upsert-
    // Helper) erzeugt — wir simulieren das hier direkt per INSERT.
    await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2026,
      month: null,
      amountCents: 36025,
      source: "carryover",
      validFrom: "2026-01-01",
      expiresAt: "2026-06-30",
      notes: "Carryover 2025→2026",
    });

    const list = await getInitialBalanceAllocations(customerId, "entlastungsbetrag_45b");
    const sources = list.map(a => a.source);
    expect(sources).toContain("initial_balance");
    expect(sources).toContain("carryover");
    // Sortierung: neuestes validFrom zuerst.
    expect(list[0].validFrom >= list[list.length - 1].validFrom).toBe(true);
  });
});

describe("T608 — clearLegacyInitialBalanceFromSettings", () => {
  it("nullt Legacy-Felder in-place, schreibt Audit-Log und ist idempotent", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T608-CLEAR");

    // Settings-Zeile mit Legacy-Feldern setzen (simuliert Schröder-Zustand).
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: "2025-01-01",
      validTo: null,
      initialBalanceCents: 36025,
      initialBalanceMonth: "2025-01",
    });

    const first = await db.transaction(async (tx) =>
      clearLegacyInitialBalanceFromSettings(customerId, "entlastungsbetrag_45b", tx, userId),
    );
    expect(first).toBe(true);

    const openRow = (await db.select().from(customerBudgetTypeSettings).where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
    )))[0];
    expect(openRow.initialBalanceCents).toBeNull();
    expect(openRow.initialBalanceMonth).toBeNull();
    // validFrom darf NICHT verändert worden sein (keine neue Historisierungszeile).
    expect(openRow.validFrom).toBe("2025-01-01");
    expect(openRow.validTo).toBeNull();

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.action, "budget_type_settings_initial_balance_cleared"),
      eq(auditLog.entityId, customerId),
    )).orderBy(desc(auditLog.id));
    expect(audits.length).toBe(1);

    // Zweiter Aufruf → idempotent: keine zusätzliche Aktion, kein neuer Audit.
    const second = await db.transaction(async (tx) =>
      clearLegacyInitialBalanceFromSettings(customerId, "entlastungsbetrag_45b", tx, userId),
    );
    expect(second).toBe(false);
    const auditsAfter = await db.select().from(auditLog).where(and(
      eq(auditLog.action, "budget_type_settings_initial_balance_cleared"),
      eq(auditLog.entityId, customerId),
    ));
    expect(auditsAfter.length).toBe(1);
  });
});

describe("T608 — DELETE /api/budget/:cid/initial-balance/:aid Route-Level", () => {
  it("löscht §45b-Carryover und nullt zugehörige Legacy-Settings-Felder atomar", async () => {
    const customerId = await freshCustomer("T608-ROUTE");

    // Settings-Zeile mit Legacy-Feldern simulieren.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: "2025-01-01",
      validTo: null,
      initialBalanceCents: 36025,
      initialBalanceMonth: "2025-01",
    });
    const [carryover] = await db.insert(budgetAllocations).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year: 2026,
      month: null,
      amountCents: 36025,
      source: "carryover",
      validFrom: "2026-01-01",
      expiresAt: "2026-06-30",
      notes: "Carryover 2025→2026",
    }).returning();

    const res = await apiDelete(`/api/budget/${customerId}/initial-balance/${carryover.id}`);
    expect(res.status).toBe(200);

    // Allocation ist soft-deleted (deletedAt gesetzt).
    const allocAfter = (await db.select().from(budgetAllocations).where(eq(budgetAllocations.id, carryover.id)))[0];
    expect(allocAfter.deletedAt).not.toBeNull();

    // Settings-Legacy-Felder sind genullt.
    const settingsAfter = (await db.select().from(customerBudgetTypeSettings).where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
    )))[0];
    expect(settingsAfter.initialBalanceCents).toBeNull();
    expect(settingsAfter.initialBalanceMonth).toBeNull();
  });
});

describe("T608 — upsertBudgetTypeSettings: Epoch-Sentinel-Edit bleibt historisch korrekt", () => {
  it("behält für vergangene asOfDate-Lookups die alte Sentinel-Zeile und legt für morgen die neue Zeile an", async () => {
    const customerId = await freshCustomer("T608-EPOCH");
    const userId = await getActorUserId();
    const today = todayISO();

    // Zustand: Backfill-Zeile mit Epoch-Sentinel, Priorität 1.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: SETTINGS_VALID_FROM_EPOCH,
      validTo: null,
    });

    // Edit: Priorität auf 2, validFrom leer (User hat den maskierten Sentinel
    // nicht überschrieben).
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null }],
      undefined,
      userId,
    );

    const rows = await db.select().from(customerBudgetTypeSettings).where(and(
      eq(customerBudgetTypeSettings.customerId, customerId),
      eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"),
    ));
    // Append-only Historisierung: alte Zeile bleibt erhalten und ist
    // geschlossen (validTo=today), eine neue Zeile beginnt morgen.
    const closed = rows.find(r => r.validFrom === SETTINGS_VALID_FROM_EPOCH);
    const future = rows.find(r => r.validFrom !== SETTINGS_VALID_FROM_EPOCH);
    expect(closed).toBeDefined();
    expect(closed?.validTo).toBe(today);
    expect(future).toBeDefined();
    expect(future?.validTo).toBeNull();
    expect(future?.priority).toBe(2);

    // Historische asOfDate-Lookups (z.B. eine Buchung aus 2024) sehen weiter
    // die ursprüngliche Sentinel-Konfiguration — KEIN Datenverlust durch
    // den Edit.
    const historical = await getActiveBudgetTypeSettings(customerId, "2024-06-15");
    const histRow = historical.find(s => s.budgetType === "entlastungsbetrag_45b");
    expect(histRow?.priority).toBe(1);
  });
});
