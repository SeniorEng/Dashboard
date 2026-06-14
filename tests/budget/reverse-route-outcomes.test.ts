/**
 * Task #1280 — Phase 2 / Paket 2.4: Verifikation des HTTP-Code-Mappings der
 * Reversal-Route `POST /api/budget/transactions/:transactionId/reverse`.
 *
 * Die Route mappt die Outcome-Union aus
 * `reverseBudgetTransactionWithOutcome` (`server/storage/budget/transaction-storage.ts`)
 * auf HTTP-Codes:
 *   - `not_found`        → 404 (`NOT_FOUND`)
 *   - `not_reversible`   → 400 (`REVERSAL_NOT_REVERSIBLE`) — Storno eines Stornos verboten
 *   - `already_reversed` → 409 (`ALREADY_REVERSED`, idempotent, gibt vorhandene Reversal zurück)
 *   - `created`          → 201 (neue Reversal-Zeile + Audit-Eintrag)
 *
 * Dieser Test nagelt genau diese vier Outcomes über die echte HTTP-Route fest
 * und prüft die Idempotenz-Garantie (kein zweiter Reversal-/Audit-Eintrag beim
 * Doppel-Storno).
 *
 * Vorlage: tests/budget/reversal-service-cents-mirror.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions, auditLog } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
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

async function countReversalAudits(customerId: number): Promise<number> {
  const rows = await db.select()
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "budget_reversal"),
      eq(auditLog.entityType, "budget"),
      eq(auditLog.entityId, customerId),
    ));
  return rows.length;
}

describe("Task #1280 — Reversal-Route HTTP-Code-Mapping (400/404/409/201)", () => {
  it("mappt created→201, already_reversed→409 (idempotent), not_reversible→400, not_found→404", async () => {
    const c = await createTestCustomer({
      vorname: "T1280-reverse-codes",
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

    // Echte Consumption-Buchung über die Engine (= Original-Transaktion).
    const consumption = await createConsumptionTransaction({
      customerId,
      appointmentId,
      transactionDate: today,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId,
    });
    expect(consumption).toBeDefined();
    expect(consumption.amountCents).toBeLessThan(0);

    // (1) Erster Storno der Consumption → 201 created, eine Reversal-Zeile, ein Audit.
    const first = await apiPost<any>(`/api/budget/transactions/${consumption.id}/reverse`, {});
    expect(first.status).toBe(201);
    expect(first.data?.id).toBeGreaterThan(0);
    expect(first.data?.transactionType).toBe("reversal");
    expect(first.data?.reversedTransactionId).toBe(consumption.id);
    const reversalId = first.data.id as number;

    const afterFirst = await getReversals(customerId, appointmentId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].id).toBe(reversalId);
    expect(await countReversalAudits(customerId)).toBe(1);

    // (2) Zweiter Storno derselben Original-Buchung → 409 ALREADY_REVERSED,
    //     idempotent: KEINE zweite Reversal-Zeile, KEIN zweiter Audit-Eintrag,
    //     gibt die vorhandene Reversal zurück.
    const second = await apiPost<any>(`/api/budget/transactions/${consumption.id}/reverse`, {});
    expect(second.status).toBe(409);
    expect(second.data?.error).toBe("ALREADY_REVERSED");
    expect(second.data?.reversal?.id).toBe(reversalId);

    const afterSecond = await getReversals(customerId, appointmentId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(reversalId);
    expect(await countReversalAudits(customerId)).toBe(1);

    // (3) Storno der Reversal-Zeile selbst → 400 REVERSAL_NOT_REVERSIBLE,
    //     KEINE neue Zeile, KEIN zusätzlicher Audit-Eintrag.
    const third = await apiPost<any>(`/api/budget/transactions/${reversalId}/reverse`, {});
    expect(third.status).toBe(400);
    expect(third.data?.error).toBe("REVERSAL_NOT_REVERSIBLE");

    const afterThird = await getReversals(customerId, appointmentId);
    expect(afterThird).toHaveLength(1);
    expect(await countReversalAudits(customerId)).toBe(1);

    // (4) Unbekannte/nicht existierende Transaktion → 404 NOT_FOUND.
    const fourth = await apiPost<any>(`/api/budget/transactions/2147483647/reverse`, {});
    expect(fourth.status).toBe(404);
    expect(fourth.data?.error).toBe("NOT_FOUND");
  }, 120_000);
});
