/**
 * Task #440 — GoBD-Härtung Budget-Sprint 1:
 *   1) Keine Resurrect-Updates auf soft-gelöschte `budget_allocations`.
 *   2) Settings-Updates schließen alte Zeile (validTo = heute) und legen
 *      neue Zeile (validFrom = heute+1) an — kein DELETE mehr.
 *   3) Read-Pfade nutzen die zum transactionDate gültige Konfiguration.
 *   4) Jede Transition / Resurrect-Ersatz schreibt einen Audit-Log-Eintrag.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  auditLog,
  budgetAllocations,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { addDays, todayISO } from "@shared/utils/datetime";
import {
  getActiveBudgetTypeSettings,
  upsertBudgetTypeSettings,
} from "../../server/storage/budget/preferences-storage";
import { upsertInitialBalanceAllocation } from "../../server/storage/budget/allocation-storage";
import {
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(async () => {
  process.env.TZ = "Europe/Berlin";
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

async function getActorUserId(): Promise<number> {
  const rows = await db.execute(
    // Beliebiger existierender User reicht — FK auf users.id genügt für audit_log.
    // Wir nehmen den ersten admin/super-admin (analog zu clear-45b-monthly-limits).
    /* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`,
  );
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function freshCustomer(prefix: string): Promise<number> {
  const c = await createTestCustomer({
    vorname: prefix,
    nachname: `T440_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id as number;
}

describe("Task #440 — Settings-Historisierung", () => {
  it("Erstanlage erzeugt genau eine offene Zeile pro Topf (validFrom = null = rückwirkend gültig, validTo = null)", async () => {
    const customerId = await freshCustomer("T440-CREATE");
    const userId = await getActorUserId();

    await upsertBudgetTypeSettings(
      customerId,
      [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 },
      ],
      undefined,
      userId,
    );

    const rows = await db
      .select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId))
      .orderBy(asc(customerBudgetTypeSettings.budgetType));

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // Erstanlage ohne explizites validFrom → NULL ("rückwirkend gültig"),
      // damit Buchungen vor dem Anlagedatum und budgetStartDate-basierte
      // Auto-Allokationen (§45b) den heute angelegten Topf weiterhin sehen.
      expect(r.validFrom).toBeNull();
      expect(r.validTo).toBeNull();
    }
  });

  it("Same-day-Update einer eben angelegten Zeile aktualisiert in-place (keine Pseudo-Historisierung)", async () => {
    const customerId = await freshCustomer("T440-SAMEDAY");
    const userId = await getActorUserId();
    const today = todayISO();

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 }],
      undefined,
      userId,
    );
    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 20000 }],
      undefined,
      userId,
    );

    const rows = await db
      .select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId))
      .orderBy(asc(customerBudgetTypeSettings.id));

    // In-Place-Update: weiterhin nur eine Zeile, neuer Wert greift HEUTE.
    // validFrom bleibt NULL (Erstanlage hat es nicht explizit gesetzt — die
    // Zeile gilt rückwirkend, siehe Erstanlage-Test).
    expect(rows).toHaveLength(1);
    expect(rows[0].monthlyLimitCents).toBe(20000);
    expect(rows[0].validFrom).toBeNull();
    expect(rows[0].validTo).toBeNull();

    const active = await getActiveBudgetTypeSettings(customerId, today);
    expect(active[0].monthlyLimitCents).toBe(20000);
  });

  it("Echte Transition (alte Zeile war an vorherigem Tag in Kraft) schließt validTo=heute und legt neue Zeile validFrom=morgen an", async () => {
    const customerId = await freshCustomer("T440-UPDATE");
    const userId = await getActorUserId();
    const today = todayISO();
    const tomorrow = addDays(today, 1);

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 }],
      undefined,
      userId,
    );

    // Alte Zeile künstlich in die Vergangenheit setzen, damit sie als "in Kraft
    // gewesen" gilt — sonst greift der Same-Day-In-Place-Pfad.
    await db
      .update(customerBudgetTypeSettings)
      .set({ validFrom: "2020-01-01" })
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 20000 }],
      undefined,
      userId,
    );

    const rows = await db
      .select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId))
      .orderBy(asc(customerBudgetTypeSettings.id));

    expect(rows).toHaveLength(2);
    const [oldRow, newRow] = rows;
    expect(oldRow.monthlyLimitCents).toBe(10000);
    expect(oldRow.validTo).toBe(today);
    expect(newRow.monthlyLimitCents).toBe(20000);
    expect(newRow.validFrom).toBe(tomorrow);
    expect(newRow.validTo).toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "budget"),
          eq(auditLog.entityId, customerId),
          eq(auditLog.action, "budget_type_settings_transition"),
        ),
      )
      .orderBy(asc(auditLog.id));
    const kinds = audits.map((a) => (a.metadata as { kind?: string } | null)?.kind);
    expect(kinds).toContain("transition");
  });

  it("Unveränderte Settings erzeugen keine neue Zeile (keine Pseudo-Transition)", async () => {
    const customerId = await freshCustomer("T440-NOOP");
    const userId = await getActorUserId();

    const payload = [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
    ];
    await upsertBudgetTypeSettings(customerId, payload, undefined, userId);
    await upsertBudgetTypeSettings(customerId, payload, undefined, userId);

    const rows = await db
      .select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId));
    expect(rows).toHaveLength(1);
  });

  it("getActiveBudgetTypeSettings liefert die zum asOfDate gültige Zeile nach echter Transition", async () => {
    const customerId = await freshCustomer("T440-HIST");
    const userId = await getActorUserId();
    const today = todayISO();
    const tomorrow = addDays(today, 1);

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 10000 }],
      undefined,
      userId,
    );
    // In die Vergangenheit verschieben, damit der nächste Upsert eine echte
    // Transition (statt In-Place) auslöst.
    await db
      .update(customerBudgetTypeSettings)
      .set({ validFrom: "2020-01-01" })
      .where(eq(customerBudgetTypeSettings.customerId, customerId));

    await upsertBudgetTypeSettings(
      customerId,
      [{ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 99999 }],
      undefined,
      userId,
    );

    const atToday = await getActiveBudgetTypeSettings(customerId, today);
    expect(atToday).toHaveLength(1);
    expect(atToday[0].monthlyLimitCents).toBe(10000);

    const atTomorrow = await getActiveBudgetTypeSettings(customerId, tomorrow);
    expect(atTomorrow).toHaveLength(1);
    expect(atTomorrow[0].monthlyLimitCents).toBe(99999);
  });
});

describe("Task #440 — Allocation-Resurrect-Ersatz", () => {
  it("Soft-gelöschte initial_balance-Allokation wird durch neue Zeile ersetzt (kein deletedAt=null)", async () => {
    const customerId = await freshCustomer("T440-ALLOC");
    const userId = await getActorUserId();

    // 1) Initial-Balance anlegen
    await upsertInitialBalanceAllocation(
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: 2026,
        month: 1,
        amountCents: 50000,
        validFrom: "2026-01-01",
        expiresAt: null,
        notes: "T440 erst",
      },
      userId,
    );

    const afterCreate = await db
      .select()
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          eq(budgetAllocations.source, "initial_balance"),
        ),
      );
    expect(afterCreate).toHaveLength(1);
    const firstId = afterCreate[0].id;

    // 2) Soft-Delete
    await db
      .update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, firstId));

    // 3) Erneutes Upsert → laut Task: NEUE Zeile anlegen, alte bleibt soft-gelöscht.
    await upsertInitialBalanceAllocation(
      {
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: 2026,
        month: 1,
        amountCents: 75000,
        validFrom: "2026-01-01",
        expiresAt: null,
        notes: "T440 ersetzt",
      },
      userId,
    );

    const afterResurrect = await db
      .select()
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          eq(budgetAllocations.source, "initial_balance"),
        ),
      )
      .orderBy(asc(budgetAllocations.id));

    // Genau zwei Zeilen: alte soft-gelöscht, neue lebend.
    expect(afterResurrect).toHaveLength(2);
    expect(afterResurrect[0].id).toBe(firstId);
    expect(afterResurrect[0].deletedAt).not.toBeNull();
    expect(afterResurrect[0].amountCents).toBe(50000);

    expect(afterResurrect[1].deletedAt).toBeNull();
    expect(afterResurrect[1].amountCents).toBe(75000);
    expect(afterResurrect[1].id).not.toBe(firstId);

    // Audit-Log: Resurrect-Ersatz protokolliert
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "budget"),
          eq(auditLog.entityId, customerId),
          eq(auditLog.action, "budget_allocation_resurrected"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0].metadata as {
      replacedSoftDeletedAllocationId?: number;
      newAllocationId?: number;
    } | null;
    expect(meta?.replacedSoftDeletedAllocationId).toBe(firstId);
    expect(meta?.newAllocationId).toBe(afterResurrect[1].id);
  });
});

describe("T440-HIST-CONSUME — createCascadeConsumption nutzt zur Buchung gültige Topf-Konfig", () => {
  it("Buchung mit transactionDate VOR Transition sieht alte Settings, NACH Transition die neuen", async () => {
    const { bookConsumption } = await import("../helpers/budget-booking.ts");
    const { createTestEmployee } = await import("../test-utils.ts");
    const { budgetTransactions } = await import("@shared/schema");
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T440-HIST-CONSUME");
    const emp = await createTestEmployee({ nachnamePrefix: "T440HC" });

    // Direkter DB-Setup, weil upsertBudgetTypeSettings nur "heute/morgen"
    // schreibt — wir simulieren hier eine echte Transition aus der
    // Vergangenheit (alte Zeile aktiv 2024-01-01..2024-12-31, neue Zeile
    // aktiv ab 2025-01-01 mit deaktiviertem §45b).
    await db.insert(customerBudgetTypeSettings).values([
      { customerId, budgetType: "entlastungsbetrag_45b", enabled: true,  priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "2024-01-01", validTo: "2024-12-31" },
      { customerId, budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "2025-01-01", validTo: null },
      { customerId, budgetType: "umwandlung_45a",        enabled: true,  priority: 2, monthlyLimitCents: 50000, yearlyLimitCents: null, validFrom: "2024-01-01", validTo: null },
      { customerId, budgetType: "ersatzpflege_39_42a",   enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: "2024-01-01", validTo: null },
    ]);
    await upsertInitialBalanceAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", year: 2024, month: 1, amountCents: 100000, validFrom: "2024-01-01", expiresAt: null, notes: "T440 hist 45b" },
      userId,
    );
    await upsertInitialBalanceAllocation(
      { customerId, budgetType: "umwandlung_45a", year: 2024, month: 1, amountCents: 100000, validFrom: "2024-01-01", expiresAt: null, notes: "T440 hist 45a" },
      userId,
    );

    // Buchung mit transactionDate=2024-06-15 → §45b war damals aktiv (Prio 1)
    const oldBooking = await bookConsumption({
      customerId, employeeId: emp.id, userId,
      date: "2024-06-15", hwMinutes: 60, abMinutes: 0, travelKm: 0, customerKm: 0,
    });
    const oldTxs = await db
      .select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, oldBooking.appointmentId));
    const oldBy = new Map(oldTxs.filter(t => t.transactionType === "consumption").map(t => [t.budgetType, Math.abs(t.amountCents)]));
    expect(oldBy.get("entlastungsbetrag_45b") ?? 0).toBeGreaterThan(0);
    expect(oldBy.get("umwandlung_45a") ?? 0).toBe(0);

    // Buchung mit transactionDate=2025-06-15 → §45b deaktiviert, §45a übernimmt
    const newBooking = await bookConsumption({
      customerId, employeeId: emp.id, userId,
      date: "2025-06-15", hwMinutes: 60, abMinutes: 0, travelKm: 0, customerKm: 0,
    });
    const newTxs = await db
      .select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, newBooking.appointmentId));
    const newBy = new Map(newTxs.filter(t => t.transactionType === "consumption").map(t => [t.budgetType, Math.abs(t.amountCents)]));
    expect(newBy.get("entlastungsbetrag_45b") ?? 0).toBe(0);
    expect(newBy.get("umwandlung_45a") ?? 0).toBeGreaterThan(0);
  });
});
