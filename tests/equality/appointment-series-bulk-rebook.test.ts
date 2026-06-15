/**
 * Task #630 — Equality: Serien-Sammeländerungen über die Serien-Update-Route
 * (POST /api/appointment-series/:seriesId/appointments/:appointmentId/update)
 * lösen Auto-Rebook + Audit-Trail aus, sodass Σ budget_tx den neuen
 * Termin-Werten folgen — analog zu Task #627 für die Haupt-PATCH-Route.
 *
 * Abgedeckt:
 *  - mode "single" mit Datumsänderung (budget-relevant) → rebook + audit
 *  - mode "all_future" mit scheduledStart (budget-neutral) → kein Drift,
 *    keine Audit-Einträge, aber Pfad läuft ohne Fehler.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { quarantinedInCI } from "../helpers/known-failing";
import { and, eq } from "drizzle-orm";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  getFutureDate,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { db } from "../../server/lib/db";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import {
  appointments,
  budgetTransactions,
  services,
  auditLog,
} from "@shared/schema";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function getServiceIdByCode(code: string): Promise<number> {
  const [s] = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.code, code))
    .limit(1);
  if (!s) throw new Error(`Service ${code} nicht gefunden`);
  return s.id;
}

async function getAppt(id: number) {
  const [a] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);
  return a;
}

async function getConsumptionTxs(appointmentId: number) {
  return db
    .select()
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    );
}

async function getRebookAuditEntries(appointmentId: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "appointment_km_rebooked"),
        eq(auditLog.entityType, "appointment"),
        eq(auditLog.entityId, appointmentId),
      ),
    );
}

describe("Series-Route Bulk/Single-Edit Auto-Rebook (Task #630)", () => {
  it.skipIf(quarantinedInCI)("single-Mode mit Datumsänderung → budget_tx folgt + Audit-Eintrag", async () => {
    const auth = await getAuthCookie();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T630-SER1",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      pflegegradSeit: "2024-01-01",
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 200000,
        validFrom: "2024-01-01",
      },
    });

    const hwServiceId = await getServiceIdByCode("hauswirtschaft");

    try {
      const seriesStart = getFutureDate(820);
      const seriesEnd = (() => {
        const d = new Date(seriesStart + "T00:00:00");
        d.setDate(d.getDate() + 28);
        return d.toISOString().slice(0, 10);
      })();

      const seriesRes = await apiPost<{ series: { id: number } }>(
        "/api/appointment-series",
        {
          customerId: scenario.customerId,
          startDate: seriesStart,
          endDate: seriesEnd,
          weekdays: ["mi"],
          frequency: "weekly",
          scheduledStart: "09:00",
          durationMinutes: 60,
          services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
          assignedEmployeeId: scenario.employeeId,
        },
      );
      expect(seriesRes.status).toBe(201);
      const seriesId = seriesRes.data.series.id;

      const list = await apiGet<{
        appointments: Array<{ id: number; date: string; seriesId: number | null }>;
      }>(`/api/appointment-series/${seriesId}`);
      const target = list.data.appointments[0];

      await createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: target.id,
        transactionDate: target.date,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: auth.user.id,
      });

      const txsBefore = await getConsumptionTxs(target.id);
      expect(txsBefore.length).toBeGreaterThan(0);

      const newDateObj = new Date(target.date + "T00:00:00");
      newDateObj.setDate(newDateObj.getDate() + 1);
      const newDate = newDateObj.toISOString().slice(0, 10);

      const upd = await apiPost(
        `/api/appointment-series/${seriesId}/appointments/${target.id}/update`,
        { mode: "single", date: newDate },
      );
      expect(upd.status).toBe(200);

      const after = await getAppt(target.id);
      expect(after?.date).toBe(newDate);
      expect(after?.isSeriesException).toBe(true);

      const txsAfter = await getConsumptionTxs(target.id);
      expect(txsAfter.length).toBeGreaterThan(0);
      for (const t of txsAfter) {
        expect(t.transactionDate).toBe(newDate);
      }

      const audits = await getRebookAuditEntries(target.id);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect(meta.trigger).toBe("date_change");
    } finally {
      await scenario.cleanup();
    }
  }, 180_000);

  it("all_future-Mode mit scheduledStart (budget-neutral) → kein Audit, kein Drift", async () => {
    await getAuthCookie();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T630-SER2",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
      pflegegradSeit: "2024-01-01",
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 200000,
        validFrom: "2024-01-01",
      },
    });
    const hwServiceId = await getServiceIdByCode("hauswirtschaft");

    try {
      const seriesStart = getFutureDate(850);
      const seriesEnd = (() => {
        const d = new Date(seriesStart + "T00:00:00");
        d.setDate(d.getDate() + 21);
        return d.toISOString().slice(0, 10);
      })();

      const seriesRes = await apiPost<{ series: { id: number } }>(
        "/api/appointment-series",
        {
          customerId: scenario.customerId,
          startDate: seriesStart,
          endDate: seriesEnd,
          weekdays: ["mi"],
          frequency: "weekly",
          scheduledStart: "09:00",
          durationMinutes: 60,
          services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
          assignedEmployeeId: scenario.employeeId,
        },
      );
      expect(seriesRes.status).toBe(201);
      const seriesId = seriesRes.data.series.id;

      const list = await apiGet<{
        appointments: Array<{ id: number; date: string }>;
      }>(`/api/appointment-series/${seriesId}`);
      const target = list.data.appointments[0];

      const upd = await apiPost(
        `/api/appointment-series/${seriesId}/appointments/${target.id}/update`,
        { mode: "all_future", scheduledStart: "10:00" },
      );
      expect(upd.status).toBe(200);

      const after = await getAppt(target.id);
      expect(after?.scheduledStart?.slice(0, 5)).toBe("10:00");

      // Keine Konsum-Tx vorher → kein Rebook nötig → kein Audit-Eintrag.
      const audits = await getRebookAuditEntries(target.id);
      expect(audits.length).toBe(0);
    } finally {
      await scenario.cleanup();
    }
  }, 180_000);
});
