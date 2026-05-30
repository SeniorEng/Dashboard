/**
 * Task #834 — Import-Reconcile ist all-or-nothing.
 *
 * Früher öffnete `executeReconcile` pro Termin eine eigene Transaktion. Schlug
 * der Lauf in der Mitte fehl, blieben bereits verarbeitete Termine storniert +
 * Budget zurückgerollt, während der Rest unangetastet war — ein halb-
 * reconcileter, GoBD-relevanter Inkonsistenz-Zustand.
 *
 * Dieser Test erzwingt einen Fehler mitten im Lauf (über einen Spy auf
 * `budgetLedgerStorage.getTransactionsByAppointmentId`, der beim ZWEITEN Termin
 * wirft, nachdem der erste bereits im selben Tx verarbeitet wurde) und prüft:
 *   1. `executeReconcile` wirft (kein stilles Teil-Ergebnis).
 *   2. KEIN Termin ist hinterher storniert/soft-gelöscht (vollständiger
 *      Rollback — auch der bereits verarbeitete erste Termin).
 *   3. Es existiert KEINE neue Reversal-Buchung (Budget-Verbrauch unangetastet).
 *   4. Ein anschließender sauberer Lauf storniert beide Termine (Idempotenz/
 *      Wiederholbarkeit nach behobenem Fehler).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  apiGet,
  getAuthCookie,
  createTestCustomer,
  createAndDocumentAppointment,
  assignEmployeeToCustomer,
  cleanupCustomer,
  getFutureDate,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
const customerIdsToCleanup: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
});

afterAll(async () => {
  for (const id of customerIdsToCleanup) await cleanupCustomer(id);
});

describe("Task #834 — Reconcile ist atomar (all-or-nothing)", () => {
  it("rollt den GESAMTEN Lauf zurück, wenn er mittendrin fehlschlägt", async () => {
    const date = getFutureDate(10);
    const customer = await createTestCustomer({
      vorname: "ReconcileAtomic",
      nachname: `Test-${uniqueId()}`,
      pflegegrad: 3,
      acceptsPrivatePayment: true,
    });
    const customerId = customer.id;
    customerIdsToCleanup.push(customerId);
    await assignEmployeeToCustomer(customerId, auth.user.id);

    // Zwei Termine, beide NICHT in der Excel → beide Stornier-Kandidaten.
    const appt1 = await createAndDocumentAppointment(customerId, hwServiceId, {
      date,
      startTime: "08:00",
      durationMinutes: 30,
    });
    const appt2 = await createAndDocumentAppointment(customerId, hwServiceId, {
      date,
      startTime: "10:00",
      durationMinutes: 30,
    });

    const { db } = await import("../server/lib/db");
    const { appointments, budgetTransactions } = await import("@shared/schema");
    const { executeReconcile } = await import(
      "../server/services/appointment-import-reconcile"
    );
    const { budgetLedgerStorage } = await import("../server/storage/budget-ledger");

    const apptIds = [appt1.appointmentId, appt2.appointmentId];

    async function loadStatuses() {
      const rows = await db
        .select({
          id: appointments.id,
          status: appointments.status,
          deletedAt: appointments.deletedAt,
        })
        .from(appointments)
        .where(inArray(appointments.id, apptIds));
      return new Map(rows.map((r) => [r.id, r]));
    }

    async function countReversals(): Promise<number> {
      const rows = await db
        .select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(
          and(
            eq(budgetTransactions.customerId, customerId),
            eq(budgetTransactions.transactionType, "reversal"),
            isNotNull(budgetTransactions.reversedTransactionId),
          ),
        );
      return rows.length;
    }

    const reversalsBefore = await countReversals();

    // Spy: realer Aufruf für den ERSTEN Termin (damit er im Tx tatsächlich
    // verarbeitet + storniert wird), harter Fehler beim ZWEITEN Termin.
    const realGetTx = budgetLedgerStorage.getTransactionsByAppointmentId.bind(
      budgetLedgerStorage,
    );
    const spy = vi
      .spyOn(budgetLedgerStorage, "getTransactionsByAppointmentId")
      .mockImplementation(async (id: number, tx?: any) => {
        if (id === appt2.appointmentId) {
          throw new Error("Injizierter Mid-Run-Fehler (Task #834)");
        }
        return realGetTx(id, tx);
      });

    try {
      await expect(
        executeReconcile({
          appointmentIds: apptIds,
          reason: "Atomarer-Rollback-Regressionstest (Task #834)",
          userId: auth.user.id,
        }),
      ).rejects.toThrow(/Mid-Run-Fehler/);
    } finally {
      spy.mockRestore();
    }

    // Vollständiger Rollback: KEIN Termin storniert/soft-gelöscht.
    const afterFail = await loadStatuses();
    for (const id of apptIds) {
      const row = afterFail.get(id);
      expect(row).toBeTruthy();
      expect(row!.status).not.toBe("cancelled");
      expect(row!.deletedAt).toBeNull();
    }

    // Keine neue Reversal-Buchung übrig geblieben.
    expect(await countReversals()).toBe(reversalsBefore);

    // Wiederholbarkeit: ein sauberer Lauf (ohne injizierten Fehler) storniert
    // jetzt beide Termine vollständig.
    const result = await executeReconcile({
      appointmentIds: apptIds,
      reason: "Sauberer-Reconcile-nach-Fix (Task #834)",
      userId: auth.user.id,
    });
    expect(result.cancelled).toBe(2);
    expect(result.errors).toHaveLength(0);

    const afterClean = await loadStatuses();
    for (const id of apptIds) {
      const row = afterClean.get(id);
      expect(row!.status).toBe("cancelled");
      expect(row!.deletedAt).not.toBeNull();
    }
  });
});
