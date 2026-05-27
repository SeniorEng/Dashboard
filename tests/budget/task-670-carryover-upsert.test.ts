/**
 * Task #670 — `upsertCarryoverAllocation` legt §45b-Restguthaben aus dem
 * Vorjahr getrennt vom Startwert ab. Sichert die Kernverträge ab:
 *
 *   1) Erstanlage schreibt `source='carryover'`, `year = sourceYear+1`,
 *      `month=null`, `validFrom = YYYY-01-01`, `expiresAt = YYYY-06-30`.
 *   2) Zweiter Upsert für dasselbe Quelljahr aktualisiert die bestehende
 *      Zeile in-place (keine zweite aktive Zeile, kein Resurrect).
 *   3) Nach Soft-Delete erzeugt der Upsert eine NEUE Zeile statt die
 *      gelöschte zu "wiederbeleben" — und schreibt einen
 *      `budget_allocation_resurrected`-Audit-Eintrag (GoBD-Konvention).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, budgetAllocations } from "@shared/schema";
import {
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import {
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

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
    nachname: `T670_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  return c.id;
}

describe("T670 — upsertCarryoverAllocation", () => {
  it("legt eine carryover-Allokation mit korrektem Zieljahr + Verfallsfenster an", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T670-INSERT");
    const sourceYear = 2024;

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 25000 },
      userId,
    );

    const rows = await db.select().from(budgetAllocations).where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
    ));

    expect(rows).toHaveLength(1);
    expect(rows[0].year).toBe(sourceYear + 1);
    expect(rows[0].month).toBeNull();
    expect(rows[0].amountCents).toBe(25000);
    expect(rows[0].validFrom).toBe(`${sourceYear + 1}-01-01`);
    expect(rows[0].expiresAt).toBe(`${sourceYear + 1}-06-30`);
  });

  it("aktualisiert die bestehende Zeile in-place beim zweiten Upsert (kein Duplikat)", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T670-UPDATE");
    const sourceYear = 2024;

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 10000 },
      userId,
    );
    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 33000 },
      userId,
    );

    const active = await db.select().from(budgetAllocations).where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
    ));
    expect(active).toHaveLength(1);
    expect(active[0].amountCents).toBe(33000);
  });

  it("legt nach Soft-Delete eine neue Zeile an statt zu wiederbeleben + audit-loggt resurrected", async () => {
    const userId = await getActorUserId();
    const customerId = await freshCustomer("T670-RESURR");
    const sourceYear = 2024;

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 12000 },
      userId,
    );
    const before = await db.select().from(budgetAllocations).where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.source, "carryover"),
    ));
    expect(before).toHaveLength(1);
    const originalId = before[0].id;

    await db.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, originalId));

    await upsertCarryoverAllocation(
      { customerId, budgetType: "entlastungsbetrag_45b", sourceYear, amountCents: 45000 },
      userId,
    );

    const allRows = await db.select().from(budgetAllocations).where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.source, "carryover"),
    )).orderBy(desc(budgetAllocations.id));

    // Eine soft-gelöschte (Original) + eine frische aktive Zeile.
    expect(allRows).toHaveLength(2);
    const stillDeleted = allRows.find(r => r.id === originalId);
    expect(stillDeleted?.deletedAt).not.toBeNull();
    const fresh = allRows.find(r => r.id !== originalId);
    expect(fresh?.deletedAt).toBeNull();
    expect(fresh?.amountCents).toBe(45000);

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.userId, userId),
      eq(auditLog.action, "budget_allocation_resurrected"),
      eq(auditLog.entityId, customerId),
    ));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
