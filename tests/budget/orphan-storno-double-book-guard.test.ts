/**
 * Task #989 — DB-gestützter Guard gegen die Phantom-Doppel-Gutschrift bei
 * Stornos.
 *
 * `reverseBudgetTransaction` darf KEINE zweite Reversal-Zeile buchen, wenn für
 * dieselbe Original-Consumption bereits eine *verwaiste* Note-basierte
 * Storno-Zeile existiert (`reversed_transaction_id IS NULL`, Notiz
 * "Storno … von Transaktion #N"). Solche Waisen stammen aus historischen
 * Importen und werden vom Partial-Unique-Index
 * `budget_transactions_reversal_unique_idx` (greift nur bei GESETZTEM Link)
 * NICHT erfasst. Ohne den Schreib-Guard aus #987 würde ein regulärer Storno
 * den Topf ein zweites Mal gutschreiben (Phantom-Doppel-Storno).
 *
 * Während der reine Architektur-/Drift-Test
 * (`tests/architecture/phantom-storno-detector.test.ts`) die SSoT-Logik
 * abdeckt, nagelt dieser Integrationstest die Prävention end-to-end gegen die
 * echte DB fest: vorhandene Waise → reverseBudgetTransaction liefert exakt
 * diese Waise zurück, OHNE eine neue Reversal-Zeile zu schreiben.
 *
 * Vorlage: tests/budget/reversal-service-cents-mirror.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { reverseBudgetTransaction } from "../../server/storage/budget/transaction-storage";
import { budgetStorage } from "../../server/storage/budget-storage";
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

async function getReversals(customerId: number, appointmentId: number) {
  return db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "reversal"),
    ));
}

describe("Task #989 — Storno-Doppel-Buchung verhindert (verwaiste Note-Storno)", () => {
  it("reverseBudgetTransaction liefert die bestehende Waise zurück und bucht KEINE zweite Reversal-Zeile", async () => {
    const c = await createTestCustomer({
      vorname: "T989-orphan-guard",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();

    // §45b-Topf mit reichlich Budget anlegen.
    await budgetStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
    ], undefined, userId);

    const today = todayISO();
    const r1 = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 100000,
      budgetStartDate: today,
    });
    expect(r1.status).toBe(201);

    const [appt] = await db.insert(appointments).values({
      customerId, date: today, scheduledStart: "09:00", status: "completed",
      appointmentType: "Kundentermin", durationPromised: 60,
      createdByUserId: userId, assignedEmployeeId: userId,
    }).returning({ id: appointments.id });
    const appointmentId = appt.id;

    // Original-Consumption über die Engine buchen (= Transaktion #N).
    const consumption = await createConsumptionTransaction({
      customerId,
      appointmentId,
      transactionDate: today,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 30,
      travelKilometers: 5,
      customerKilometers: 0,
      userId,
    });
    expect(consumption).toBeDefined();
    expect(consumption.amountCents).toBeLessThan(0);

    // Verwaiste Note-basierte Storno-Zeile für DIESELBE Original-Buchung
    // einfügen (wie sie historische Importe hinterlassen haben):
    // `reversed_transaction_id` bleibt NULL, die Referenz steckt nur in der
    // Notiz.
    const [orphan] = await db.insert(budgetTransactions).values({
      customerId,
      budgetType: consumption.budgetType,
      transactionDate: consumption.transactionDate,
      transactionType: "reversal",
      amountCents: -consumption.amountCents,
      appointmentId,
      allocationId: consumption.allocationId,
      reversedTransactionId: null,
      hauswirtschaftMinutes: consumption.hauswirtschaftMinutes == null ? null : -consumption.hauswirtschaftMinutes,
      hauswirtschaftCents: consumption.hauswirtschaftCents == null ? null : -consumption.hauswirtschaftCents,
      alltagsbegleitungMinutes: consumption.alltagsbegleitungMinutes == null ? null : -consumption.alltagsbegleitungMinutes,
      alltagsbegleitungCents: consumption.alltagsbegleitungCents == null ? null : -consumption.alltagsbegleitungCents,
      travelKilometers: consumption.travelKilometers == null ? null : -Number(consumption.travelKilometers),
      travelCents: consumption.travelCents == null ? null : -consumption.travelCents,
      notes: `Storno von Transaktion #${consumption.id}`,
      createdByUserId: userId,
    }).returning();
    expect(orphan).toBeDefined();
    expect(orphan.reversedTransactionId).toBeNull();

    const reversalsBefore = await getReversals(customerId, appointmentId);
    expect(reversalsBefore).toHaveLength(1);
    expect(reversalsBefore[0].id).toBe(orphan.id);

    // Regulären Storno auslösen → MUSS die bestehende Waise erkennen und genau
    // diese zurückgeben, ohne eine neue Reversal-Zeile zu schreiben.
    const result = await reverseBudgetTransaction(consumption.id, userId);
    expect(result).toBeDefined();
    expect(result!.id).toBe(orphan.id);

    const reversalsAfter = await getReversals(customerId, appointmentId);
    expect(reversalsAfter).toHaveLength(1);
    expect(reversalsAfter[0].id).toBe(orphan.id);
    // Keine neu erstellte (verknüpfte) Storno-Zeile.
    expect(reversalsAfter.some(r => r.reversedTransactionId === consumption.id)).toBe(false);
  }, 90_000);
});
