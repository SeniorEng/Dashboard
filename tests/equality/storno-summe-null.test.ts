/**
 * Task #754 — Equality-Drift-Detektor: Σ pro Service-Feld über
 * {consumption + reversal} je `appointmentId` = 0.
 *
 * Vor Task #754 trugen Reversal-TX `hauswirtschaftCents = NULL` bzw. den
 * vollen Original-Wert (BUG-14 / BUG-10b) — Lexware-Export und
 * §45b-Statistik addierten diese Spalten und sahen einen stornierten
 * Termin weiterhin als „voll gebucht".
 *
 * Erwartung nach Fix: für jede Termin-Konstellation (reine §45b-Buchung,
 * Cascade über mehrere Töpfe, Privatzahlungs-Overflow) muss Σ aller
 * Service-Spalten je `appointmentId` nach einem Storno exakt 0 ergeben.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { reverseBudgetTransaction } from "../../server/storage/budget/transaction-storage";
import { budgetLedgerStorage } from "../../server/storage/budget-ledger";
import { apiPost, createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function actorId(): Promise<number> {
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

async function bookAndStorno(customerId: number, userId: number) {
  const today = todayISO();
  const [appt] = await db.insert(appointments).values({
    customerId, date: today, scheduledStart: "09:00", status: "completed",
    appointmentType: "Kundentermin", durationPromised: 60,
    createdByUserId: userId, assignedEmployeeId: userId,
  }).returning({ id: appointments.id });
  const appointmentId = appt.id;

  await createConsumptionTransaction({
    customerId,
    appointmentId,
    transactionDate: today,
    hauswirtschaftMinutes: 90,
    alltagsbegleitungMinutes: 45,
    travelKilometers: 8,
    customerKilometers: 0,
    userId,
  });

  const txs = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  for (const t of txs) {
    await reverseBudgetTransaction(t.id, userId);
  }

  return appointmentId;
}

async function sumPerField(customerId: number, appointmentId: number) {
  const txs = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.appointmentId, appointmentId),
    ));
  const sum = (k: keyof typeof txs[0]) => txs.reduce((s, t) => s + (Number(t[k] ?? 0) || 0), 0);
  return {
    amount: sum("amountCents"),
    hw: sum("hauswirtschaftCents"),
    ab: sum("alltagsbegleitungCents"),
    tv: sum("travelCents"),
    ck: sum("customerKilometersCents"),
    hwMin: sum("hauswirtschaftMinutes"),
    abMin: sum("alltagsbegleitungMinutes"),
  };
}

describe("Equality — Σ Service-Feld nach Storno = 0", () => {
  it("§45b-only Termin: Σ pro Feld = 0 nach Storno", async () => {
    const c = await createTestCustomer({
      vorname: "T754-Σ0-45b",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
    ], undefined, userId);
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 100000,
      budgetStartDate: todayISO(),
    });

    const apptId = await bookAndStorno(customerId, userId);
    const s = await sumPerField(customerId, apptId);
    expect(s.amount).toBe(0);
    expect(s.hw).toBe(0);
    expect(s.ab).toBe(0);
    expect(s.tv).toBe(0);
    expect(s.ck).toBe(0);
    expect(s.hwMin).toBe(0);
    expect(s.abMin).toBe(0);
  }, 90_000);

  it("Cascade-Termin (§45b → §45a): Σ pro Feld = 0 nach Storno aller Legs", async () => {
    const c = await createTestCustomer({
      vorname: "T754-Σ0-Cascade",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 31840 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
    ], undefined, userId);
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 3000,
      carryoverAmountCents: 0,
      budgetStartDate: todayISO(),
    });
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 31840,
      carryoverAmountCents: 0,
      budgetStartDate: todayISO(),
    });

    const apptId = await bookAndStorno(customerId, userId);
    const s = await sumPerField(customerId, apptId);
    expect(s.amount).toBe(0);
    expect(s.hw).toBe(0);
    expect(s.ab).toBe(0);
    expect(s.tv).toBe(0);
    expect(s.ck).toBe(0);
  }, 120_000);
});
