/**
 * Task #871 / Task #1273 — GoBD: technische Unveränderbarkeit der finanziellen
 * Budget-Buchungstabelle.
 *
 * Stufe B (#1273) hat den GoBD-Immutability-Installer von `budget_ledger` auf
 * `budget_transactions` umgezogen (der `budget_ledger`-Spiegel wird nicht mehr
 * geschrieben). Dieser Negativ-Beweis verifiziert die BEFORE-Trigger aus
 * `server/startup/ensure-budget-transactions-immutability.ts`:
 *  - budget_transactions: append-only — UPDATE und DELETE schlagen fehl; der
 *    Bypass-GUC `app.allow_gobd_mutation` erlaubt beides.
 *  - budget_reservations: BEWUSST mutierbar — UPDATE/DELETE bleiben erlaubt
 *    (operative Holds, nicht GoBD-relevant).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../server/lib/db";
import { budgetTransactions, budgetReservations } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { createTestCustomer, uniqueId } from "./test-utils";

let customerId: number;
let transactionId: number;
let reservationId: number;

beforeAll(async () => {
  const c = await createTestCustomer({
    vorname: "GoBD",
    nachname: "Tx-" + uniqueId(),
  });
  customerId = c.id as number;

  // manual_adjustment-Buchung ohne appointmentId — unterliegt nicht dem
  // appointment-required-CHECK (nur consumption/reversal brauchen ein Termin).
  const [tx] = await db
    .insert(budgetTransactions)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: "2026-01-15",
      transactionType: "manual_adjustment",
      amountCents: -5000,
    })
    .returning({ id: budgetTransactions.id });
  transactionId = tx.id;

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
    await tx.delete(budgetTransactions).where(eq(budgetTransactions.customerId, customerId));
  });
});

describe("budget_transactions: append-only (UPDATE & DELETE gesperrt)", () => {
  it("UPDATE schlägt fehl", async () => {
    await expect(
      db.update(budgetTransactions).set({ amountCents: -1 }).where(eq(budgetTransactions.id, transactionId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ amountCents: budgetTransactions.amountCents })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.id, transactionId));
    expect(rows[0]?.amountCents).toBe(-5000);
  });

  it("DELETE schlägt fehl", async () => {
    await expect(
      db.delete(budgetTransactions).where(eq(budgetTransactions.id, transactionId)),
    ).rejects.toThrow();
    const rows = await db
      .select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.id, transactionId));
    expect(rows.length).toBe(1);
  });

  it("Mit Bypass-GUC sind UPDATE und DELETE möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
      await tx.update(budgetTransactions).set({ amountCents: -1 }).where(eq(budgetTransactions.id, transactionId));
      await tx.delete(budgetTransactions).where(eq(budgetTransactions.id, transactionId));
    });
    const rows = await db
      .select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.id, transactionId));
    expect(rows.length).toBe(0);
  });
});

describe("budget_reservations: operativ mutierbar (kein GoBD-Lock)", () => {
  it("UPDATE (State-Übergang hold → released) ist erlaubt", async () => {
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
