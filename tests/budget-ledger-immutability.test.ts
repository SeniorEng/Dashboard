/**
 * Task #871 — GoBD: technische Unveränderbarkeit der finanziellen
 * `budget_ledger`-Tabelle (Budget GF Phase 1).
 *
 * Verifiziert die BEFORE-Trigger aus
 * `server/startup/ensure-budget-ledger-immutability.ts`:
 *  - budget_ledger: append-only — UPDATE und DELETE schlagen fehl; Bypass-GUC
 *    `app.allow_gobd_mutation` erlaubt beides.
 *  - budget_reservations: BEWUSST mutierbar — UPDATE/DELETE bleiben erlaubt
 *    (operative Holds, nicht GoBD-relevant).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../server/lib/db";
import { budgetLedger, budgetReservations } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { createTestCustomer, uniqueId } from "./test-utils";

let customerId: number;
let ledgerId: number;
let reservationId: number;

beforeAll(async () => {
  const c = await createTestCustomer({
    vorname: "GoBD",
    nachname: "Ledger-" + uniqueId(),
  });
  customerId = c.id as number;

  const [led] = await db
    .insert(budgetLedger)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: "2026-01-15",
      state: "consumed",
      amountCents: -5000,
      idempotencyKey: "test-ledger-" + uniqueId(),
    })
    .returning({ id: budgetLedger.id });
  ledgerId = led.id;

  const [res] = await db
    .insert(budgetReservations)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      amountCents: 3000,
      state: "hold",
      idempotencyKey: "test-res-" + uniqueId(),
    })
    .returning({ id: budgetReservations.id });
  reservationId = res.id;
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx.delete(budgetReservations).where(eq(budgetReservations.customerId, customerId));
    await tx.delete(budgetLedger).where(eq(budgetLedger.customerId, customerId));
  });
});

describe("budget_ledger: append-only (UPDATE & DELETE gesperrt)", () => {
  it("UPDATE schlägt fehl", async () => {
    await expect(
      db.update(budgetLedger).set({ amountCents: -1 }).where(eq(budgetLedger.id, ledgerId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ amountCents: budgetLedger.amountCents })
      .from(budgetLedger)
      .where(eq(budgetLedger.id, ledgerId));
    expect(rows[0]?.amountCents).toBe(-5000);
  });

  it("DELETE schlägt fehl", async () => {
    await expect(
      db.delete(budgetLedger).where(eq(budgetLedger.id, ledgerId)),
    ).rejects.toThrow();
    const rows = await db.select({ id: budgetLedger.id }).from(budgetLedger).where(eq(budgetLedger.id, ledgerId));
    expect(rows.length).toBe(1);
  });

  it("Mit Bypass-GUC sind UPDATE und DELETE möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      await tx.update(budgetLedger).set({ amountCents: -1 }).where(eq(budgetLedger.id, ledgerId));
      await tx.delete(budgetLedger).where(eq(budgetLedger.id, ledgerId));
    });
    const rows = await db.select({ id: budgetLedger.id }).from(budgetLedger).where(eq(budgetLedger.id, ledgerId));
    expect(rows.length).toBe(0);
  });
});

describe("budget_reservations: operativ mutierbar (kein GoBD-Lock)", () => {
  it("UPDATE (State-Übergang hold → captured) ist erlaubt", async () => {
    await db
      .update(budgetReservations)
      .set({ state: "released" })
      .where(eq(budgetReservations.id, reservationId));
    const rows = await db
      .select({ state: budgetReservations.state })
      .from(budgetReservations)
      .where(eq(budgetReservations.id, reservationId));
    expect(rows[0]?.state).toBe("released");
  });

  it("DELETE ist erlaubt", async () => {
    await db.delete(budgetReservations).where(eq(budgetReservations.id, reservationId));
    const rows = await db
      .select({ id: budgetReservations.id })
      .from(budgetReservations)
      .where(eq(budgetReservations.id, reservationId));
    expect(rows.length).toBe(0);
  });
});
