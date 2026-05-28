/**
 * Task #754 — BUG-14 / BUG-10b: Reversal-TX müssen die Service-Cent-,
 * Minuten- und Kilometer-Spalten ihrer korrespondierenden Consumption-TX
 * vorzeichen-invertiert spiegeln.
 *
 * Drift-Detektor (siehe `tests/equality/storno-summe-null.test.ts`): Σ pro
 * Service-Feld über {consumption + reversal} je `appointmentId` = 0.
 *
 * Hier prüfen wir konkret die SPIEGEL-Konvention pro Einzel-Tx:
 *   - Reine §45b-Konsumtion (1 Tx) + reverseBudgetTransaction → 1 Reversal
 *     mit invertierten Service-Feldern.
 *   - Cascade-Konsumtion (mehrere Töpfe) + rebookDisabledBudgetTransactions
 *     → 1 Reversal pro Cascade-Leg, jede mit ihren eigenen invertierten
 *     Service-Feldern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { reverseBudgetTransaction } from "../../server/storage/budget/transaction-storage";
import { budgetLedgerStorage } from "../../server/storage/budget-ledger";
import { rebookDisabledBudgetTransactions } from "../../server/storage/budget/rebook-storage";
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

async function getTxs(customerId: number, appointmentId: number) {
  return db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.appointmentId, appointmentId),
    ));
}

describe("Task #754 — Reversal Service-Cent-Spiegel", () => {
  it("BUG-14: §45b-Storno spiegelt Service-Cents/-Minuten/-km vorzeichen-invertiert", async () => {
    const c = await createTestCustomer({
      vorname: "T754-BUG14",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();

    // §45b-Topf mit reichlich Budget anlegen.
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
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

    // Fake-Appointment-ID — wir bauen die Konsumtion direkt über die Engine.
    const [appt] = await db.insert(appointments).values({
      customerId, date: today, scheduledStart: "09:00", status: "completed",
      appointmentType: "Kundentermin", durationPromised: 60,
      createdByUserId: userId, assignedEmployeeId: userId,
    }).returning({ id: appointments.id });
    const appointmentId = appt.id;

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
    expect(consumption.hauswirtschaftCents ?? 0).toBeGreaterThan(0);

    const reversal = await reverseBudgetTransaction(consumption.id, userId);
    expect(reversal).toBeDefined();

    // Spiegel: alle Service-Spalten der Reversal = -original.
    expect(reversal!.amountCents).toBe(-consumption.amountCents);
    expect(reversal!.hauswirtschaftCents).toBe(consumption.hauswirtschaftCents == null ? null : 0 - consumption.hauswirtschaftCents);
    expect(reversal!.alltagsbegleitungCents).toBe(consumption.alltagsbegleitungCents == null ? null : 0 - consumption.alltagsbegleitungCents);
    expect(reversal!.travelCents).toBe(consumption.travelCents == null ? null : 0 - consumption.travelCents);
    expect(reversal!.customerKilometersCents).toBe(consumption.customerKilometersCents == null ? null : 0 - consumption.customerKilometersCents);
    expect(reversal!.hauswirtschaftMinutes).toBe(consumption.hauswirtschaftMinutes == null ? null : 0 - consumption.hauswirtschaftMinutes);
    expect(reversal!.alltagsbegleitungMinutes).toBe(consumption.alltagsbegleitungMinutes == null ? null : 0 - consumption.alltagsbegleitungMinutes);
    expect(Number(reversal!.travelKilometers)).toBe(consumption.travelKilometers == null ? 0 : -Number(consumption.travelKilometers));

    // Σ je Service-Feld über alle Tx dieses Termins = 0.
    const txs = await getTxs(customerId, appointmentId);
    const sum = (k: keyof typeof txs[0]) => txs.reduce((s, t) => s + (Number(t[k] ?? 0) || 0), 0);
    expect(sum("hauswirtschaftCents")).toBe(0);
    expect(sum("alltagsbegleitungCents")).toBe(0);
    expect(sum("travelCents")).toBe(0);
    expect(sum("customerKilometersCents")).toBe(0);
    expect(sum("amountCents")).toBe(0);
  }, 90_000);

  it("BUG-10b: Cascade-Storno (§45b + §45a + §39) spiegelt anteilig pro Leg", async () => {
    const c = await createTestCustomer({
      vorname: "T754-BUG10b",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    const today = todayISO();

    // Alle drei Töpfe aktiv, niedriges §45b → Cascade muss in §45a/§39 überlaufen.
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 31840 },
      { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, yearlyLimitCents: 161200 },
    ], undefined, userId);

    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 5000,
      carryoverAmountCents: 0,
      budgetStartDate: today,
    });
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 31840,
      carryoverAmountCents: 0,
      budgetStartDate: today,
    });
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "ersatzpflege_39_42a",
      currentMonthAmountCents: 161200,
      carryoverAmountCents: 0,
      budgetStartDate: today,
    });

    const [appt] = await db.insert(appointments).values({
      customerId, date: today, scheduledStart: "09:00", status: "completed",
      appointmentType: "Kundentermin", durationPromised: 180,
      createdByUserId: userId, assignedEmployeeId: userId,
    }).returning({ id: appointments.id });
    const appointmentId = appt.id;

    // Großzügig hohe Hauswirtschafts-Minuten → Cascade über mehrere Töpfe.
    await createConsumptionTransaction({
      customerId,
      appointmentId,
      transactionDate: today,
      hauswirtschaftMinutes: 240,
      alltagsbegleitungMinutes: 60,
      travelKilometers: 20,
      customerKilometers: 0,
      userId,
    });

    const beforeReversal = await getTxs(customerId, appointmentId);
    const consumptions = beforeReversal.filter(t => t.transactionType === "consumption");
    expect(consumptions.length).toBeGreaterThanOrEqual(2);

    // Jetzt §45a + §39 deaktivieren → rebook-Pfad legt Reversals an.
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: 31840 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: 161200 },
    ], undefined, userId);

    const rebookResult = await rebookDisabledBudgetTransactions(customerId, userId);
    expect(rebookResult.reversedCount).toBeGreaterThanOrEqual(2);

    // Nach Storno: für jede Original-Consumption existiert eine Reversal mit
    // invertierten Service-Spalten. Σ je Service-Feld über die alten
    // Cascade-Töpfe (45a, 39) + ihre Reversals = 0.
    const after = await getTxs(customerId, appointmentId);
    const cascadeOriginal = after.filter(t => t.transactionType === "consumption" && (t.budgetType === "umwandlung_45a" || t.budgetType === "ersatzpflege_39_42a"));
    const reversalsForCascade = after.filter(t => t.transactionType === "reversal" && cascadeOriginal.some(o => o.id === t.reversedTransactionId));
    expect(reversalsForCascade.length).toBe(cascadeOriginal.length);
    for (const orig of cascadeOriginal) {
      const rev = reversalsForCascade.find(r => r.reversedTransactionId === orig.id);
      expect(rev).toBeDefined();
      expect(rev!.amountCents).toBe(-orig.amountCents);
      expect(rev!.hauswirtschaftCents).toBe(orig.hauswirtschaftCents == null ? null : 0 - orig.hauswirtschaftCents);
      expect(rev!.alltagsbegleitungCents).toBe(orig.alltagsbegleitungCents == null ? null : 0 - orig.alltagsbegleitungCents);
      expect(rev!.travelCents).toBe(orig.travelCents == null ? null : 0 - orig.travelCents);
      expect(rev!.customerKilometersCents).toBe(orig.customerKilometersCents == null ? null : 0 - orig.customerKilometersCents);
    }
  }, 120_000);
});
