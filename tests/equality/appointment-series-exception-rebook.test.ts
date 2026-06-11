/**
 * Task #627 — Equality: Serientermin-Edit, der zur Series-Exception
 * aufgespalten wird, rebooked die Budget-Consumption weiterhin korrekt.
 *
 * Hintergrund: Task #618 hat das Auto-Rebook (km/Datum/Minuten) in der
 * Termin-PATCH-Route gegen Drift abgesichert — getestet aber nur für
 * Einzeltermine. Wird ein Termin einer Serie via PATCH editiert, läuft
 * derselbe Code-Pfad zusätzlich durch die "isSeriesException = true"-
 * Abspaltung (server/routes/appointments.ts, ~Z. 1068). Dieser Test
 * sichert ab, dass der Rebook auch in diesem Branch greift, sodass
 * Σ budget_tx (Datum, km, Minuten) der editierten Exception folgt.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  apiGet,
  apiPatch,
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
  appointmentServices,
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

describe("Series-Exception Auto-Rebook (Task #627)", () => {
  it("Edit eines Serientermins (km + Datum + Minuten) → isSeriesException=true UND budget_tx folgen den neuen Werten", async () => {
    const auth = await getAuthCookie();
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "T627-SER",
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
      // 1. Serie mit 4 Mittwoch-Terminen erstellen.
      const seriesStart = getFutureDate(800);
      const seriesEnd = (() => {
        const d = new Date(seriesStart + "T00:00:00");
        d.setDate(d.getDate() + 28);
        return d.toISOString().slice(0, 10);
      })();

      const seriesRes = await apiPost<{
        series: { id: number };
        appointments?: Array<{ id: number; date: string }>;
        createdAppointments?: Array<{ id: number; date: string }>;
      }>("/api/appointment-series", {
        customerId: scenario.customerId,
        startDate: seriesStart,
        endDate: seriesEnd,
        weekdays: ["mi"],
        frequency: "weekly",
        scheduledStart: "09:00",
        durationMinutes: 60,
        services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
        assignedEmployeeId: scenario.employeeId,
      });
      expect(seriesRes.status).toBe(201);
      const seriesId = seriesRes.data.series.id;

      const list = await apiGet<{
        appointments: Array<{ id: number; date: string; seriesId: number | null }>;
      }>(`/api/appointment-series/${seriesId}`);
      expect(list.data.appointments.length).toBeGreaterThan(0);
      const target = list.data.appointments[0];
      expect(target.seriesId).toBe(seriesId);

      // Sanity: vor dem Edit ist es noch keine Exception.
      const before = await getAppt(target.id);
      expect(before?.isSeriesException).toBe(false);
      expect(before?.seriesId).toBe(seriesId);

      // 2. Konsum auf dem Serientermin buchen (km initial = 5).
      await db
        .update(appointments)
        .set({ travelKilometers: 5 })
        .where(eq(appointments.id, target.id));

      await createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: target.id,
        transactionDate: target.date,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 5,
        customerKilometers: 0,
        userId: auth.user.id,
      });

      const txsBefore = await getConsumptionTxs(target.id);
      expect(txsBefore.length).toBeGreaterThan(0);
      for (const t of txsBefore) {
        expect(t.transactionDate).toBe(target.date);
      }

      // 3. PATCH via Haupt-Termin-Route mit km + Datum + Dauer.
      //    Diese Kombination triggert sowohl die Series-Exception-Abspaltung
      //    (hasSchedulingChange via date) als auch den Auto-Rebook
      //    (km/date/duration/services changed).
      const newDateObj = new Date(target.date + "T00:00:00");
      newDateObj.setDate(newDateObj.getDate() + 1); // Mi → Do (kein Wochenende)
      const newDate = newDateObj.toISOString().slice(0, 10);

      const patch = await apiPatch(`/api/appointments/${target.id}`, {
        date: newDate,
        travelKilometers: 14.7,
        durationPromised: 90,
        services: [{ serviceId: hwServiceId, plannedDurationMinutes: 90 }],
      });
      expect(patch.status).toBe(200);

      // 4. Verifikation: Exception-Flag + budget_tx folgen den neuen Werten.
      const after = await getAppt(target.id);
      expect(after?.isSeriesException).toBe(true);
      expect(after?.date).toBe(newDate);
      expect(after?.travelKilometers).toBeCloseTo(14.7, 2);
      expect(after?.durationPromised).toBe(90);

      const txsAfter = await getConsumptionTxs(target.id);
      expect(txsAfter.length).toBeGreaterThan(0);

      // Datum: jede konsumierende tx-Zeile zeigt auf das neue Termin-Datum.
      for (const t of txsAfter) {
        expect(t.transactionDate).toBe(newDate);
      }

      // km: Σ tx.travelKilometers == appt.travelKilometers (≤ 0,05 km Toleranz).
      const txKm = txsAfter.reduce((s, t) => s + (t.travelKilometers ?? 0), 0);
      expect(Math.abs((after?.travelKilometers ?? 0) - txKm)).toBeLessThanOrEqual(0.05);

      // Minuten: Σ tx.hauswirtschaftMinutes folgt der neuen Service-Dauer.
      const hwSum = txsAfter.reduce(
        (s, t) => s + (t.hauswirtschaftMinutes ?? 0),
        0,
      );
      expect(hwSum).toBe(90);

      // Service-Junction in DB spiegelt den PATCH wider.
      const svcRows = await db
        .select()
        .from(appointmentServices)
        .where(eq(appointmentServices.appointmentId, target.id));
      expect(svcRows.length).toBe(1);
      expect(svcRows[0].plannedDurationMinutes).toBe(90);

      // 5. Audit: appointment_km_rebooked wurde geschrieben (Trigger einer
      //    der drei änderungs-relevanten Felder).
      const audits = await getRebookAuditEntries(target.id);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect([
        "appointment_edit:km_change",
        "appointment_edit:date_change",
        "appointment_edit:services_change",
        "appointment_edit:duration_change",
      ]).toContain(meta.trigger);
    } finally {
      await scenario.cleanup();
    }
  }, 180_000);
});
