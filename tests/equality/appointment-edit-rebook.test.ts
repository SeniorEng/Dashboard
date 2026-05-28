/**
 * Task #618 — Equality: Termin-Edit rebooked Budget-Consumption.
 *
 * Hintergrund: vor #618 hat der km-Rebook-Pfad (Task #613) ausschließlich
 * auf km-Änderungen reagiert. Wurde an einem dokumentierten Termin
 * nachträglich Datum, Service-Minuten oder die Services-Liste geändert,
 * blieben die zugehörigen `budget_transactions`-Zeilen auf den alten
 * Werten stehen — Anzeige (Termin) und Buchung (Ledger) driftete bis
 * zum nächsten Bulk-Rebook auseinander.
 *
 * Dieser Test deckt vier Edit-Pfade über die ECHTE PATCH-Route ab:
 *   1. km-Edit               → Σ tx.travelKm == appt.travelKm
 *   2. Datum-Edit            → tx.transactionDate == appt.date
 *   3. Service-Minuten-Edit  → Σ tx.hauswirtschaftMinutes == appt.servicesMinutes
 *   4. Services-Liste-Edit   → neuer Service spiegelt sich in tx-Minuten
 *
 * Zusätzlich wird der Audit-Trail (`appointment_km_rebooked` mit
 * `trigger`-Metadatum) verifiziert.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getAuthCookie,
  getTodayDate,
  apiPatch,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices, budgetTransactions, services, auditLog } from "@shared/schema";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function getAppt(id: number) {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
  return a;
}

async function getConsumptionTxs(appointmentId: number) {
  const rows = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
  return rows;
}

async function getRebookAuditEntries(appointmentId: number) {
  return db.select()
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "appointment_km_rebooked"),
      eq(auditLog.entityType, "appointment"),
      eq(auditLog.entityId, appointmentId),
    ));
}

async function getServiceIdByCode(code: string): Promise<number> {
  const [s] = await db.select({ id: services.id }).from(services).where(eq(services.code, code)).limit(1);
  if (!s) throw new Error(`Service ${code} nicht gefunden`);
  return s.id;
}

async function freshScenario(prefix: string) {
  return setupBudgetScenario({
    customerNamePrefix: prefix,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: true,
    preferences: { budgetStartDate: "2024-01-01" },
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a", priority: 2, enabled: false },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
    ],
    initialBalance: { type: "entlastungsbetrag_45b", amountCents: 100000, validFrom: "2024-01-01" },
  });
}

describe("Termin-Edit Auto-Rebook (Task #618)", () => {
  it("km-Edit: appt.travelKilometers == Σ budget_tx.travelKilometers nach PATCH", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    const scenario = await freshScenario("T618-KM");
    try {
      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes: 60,
        abMinutes: 0,
        travelKm: 5,
        customerKm: 0,
        userId: auth.user.id,
      });
      // Termin-km auf den Ursprungswert spiegeln (bookConsumption setzt sie nicht).
      await db.update(appointments).set({ travelKilometers: 5 })
        .where(eq(appointments.id, booked.appointmentId));

      const patch = await apiPatch(`/api/appointments/${booked.appointmentId}`, {
        travelKilometers: 12.4,
      });
      expect(patch.status).toBe(200);

      const appt = await getAppt(booked.appointmentId);
      const txs = await getConsumptionTxs(booked.appointmentId);
      expect(txs.length).toBeGreaterThan(0);
      const txTravelSum = txs.reduce((s, t) => s + (t.travelKilometers ?? 0), 0);
      expect(Math.abs((appt?.travelKilometers ?? 0) - txTravelSum)).toBeLessThanOrEqual(0.05);
      expect(appt?.travelKilometers).toBeCloseTo(12.4, 2);

      const audits = await getRebookAuditEntries(booked.appointmentId);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect(meta.trigger).toBe("appointment_edit:km_change");
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("Datums-Edit: tx.transactionDate folgt dem neuen Termin-Datum", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    const scenario = await freshScenario("T618-DATE");
    try {
      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes: 60,
        abMinutes: 0,
        travelKm: 0,
        customerKm: 0,
        userId: auth.user.id,
      });

      // Datum nach vorne verschieben — mindestens 2 Tage, aber bis zum
      // nächsten Werktag rollen. Sonst landet der neue Termin abhängig vom
      // Wochentag auf einem Samstag/Sonntag und die PATCH-Route lehnt
      // korrekt mit 400 ab ("Termine können nicht auf Samstage oder
      // Sonntage verschoben werden.").
      const newDateObj = new Date(date);
      newDateObj.setDate(newDateObj.getDate() + 2);
      while (newDateObj.getDay() === 0 || newDateObj.getDay() === 6) {
        newDateObj.setDate(newDateObj.getDate() + 1);
      }
      const newDate = newDateObj.toISOString().slice(0, 10);

      const patch = await apiPatch(`/api/appointments/${booked.appointmentId}`, {
        date: newDate,
      });
      expect(patch.status).toBe(200);

      const appt = await getAppt(booked.appointmentId);
      expect(appt?.date).toBe(newDate);

      const txs = await getConsumptionTxs(booked.appointmentId);
      expect(txs.length).toBeGreaterThan(0);
      for (const t of txs) {
        expect(t.transactionDate).toBe(newDate);
      }

      const audits = await getRebookAuditEntries(booked.appointmentId);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect(meta.trigger).toBe("appointment_edit:date_change");
      expect(meta.previousTransactionDate).toBe(date);
      expect(meta.transactionDate).toBe(newDate);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("Service-Minuten-Edit: Σ tx.hauswirtschaftMinutes folgt der neuen Service-Dauer", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    const scenario = await freshScenario("T618-MIN");
    const hwServiceId = await getServiceIdByCode("hauswirtschaft");
    try {
      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes: 60,
        abMinutes: 0,
        travelKm: 0,
        customerKm: 0,
        userId: auth.user.id,
      });

      // Service-Dauer von 60 → 90 Minuten via PATCH (services + durationPromised).
      const patch = await apiPatch(`/api/appointments/${booked.appointmentId}`, {
        durationPromised: 90,
        services: [{ serviceId: hwServiceId, plannedDurationMinutes: 90 }],
      });
      expect(patch.status).toBe(200);

      const txs = await getConsumptionTxs(booked.appointmentId);
      expect(txs.length).toBeGreaterThan(0);
      const hwSum = txs.reduce((s, t) => s + (t.hauswirtschaftMinutes ?? 0), 0);
      expect(hwSum).toBe(90);

      const audits = await getRebookAuditEntries(booked.appointmentId);
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const meta = audits[audits.length - 1].metadata as Record<string, unknown>;
      expect([
        "appointment_edit:services_change",
        "appointment_edit:duration_change",
      ]).toContain(meta.trigger);
      expect(meta.previousHauswirtschaftMinutes).toBe(60);
      expect(meta.hauswirtschaftMinutes).toBe(90);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);

  it("Services-Liste-Edit: Hinzufügen eines AB-Services spiegelt sich in tx", async () => {
    const auth = await getAuthCookie();
    const date = getTodayDate();
    const scenario = await freshScenario("T618-SVC");
    const hwServiceId = await getServiceIdByCode("hauswirtschaft");
    const abServiceId = await getServiceIdByCode("alltagsbegleitung");
    try {
      const booked = await bookConsumption({
        customerId: scenario.customerId,
        employeeId: scenario.employeeId,
        date,
        hwMinutes: 60,
        abMinutes: 0,
        travelKm: 0,
        customerKm: 0,
        userId: auth.user.id,
      });

      const patch = await apiPatch(`/api/appointments/${booked.appointmentId}`, {
        durationPromised: 90,
        services: [
          { serviceId: hwServiceId, plannedDurationMinutes: 60 },
          { serviceId: abServiceId, plannedDurationMinutes: 30 },
        ],
      });
      expect(patch.status).toBe(200);

      const txs = await getConsumptionTxs(booked.appointmentId);
      expect(txs.length).toBeGreaterThan(0);
      const hwSum = txs.reduce((s, t) => s + (t.hauswirtschaftMinutes ?? 0), 0);
      const abSum = txs.reduce((s, t) => s + (t.alltagsbegleitungMinutes ?? 0), 0);
      expect(hwSum).toBe(60);
      expect(abSum).toBe(30);

      // Cross-check: Service-Junctions in DB stimmen mit PATCH-Payload.
      const svcRows = await db.select()
        .from(appointmentServices)
        .where(eq(appointmentServices.appointmentId, booked.appointmentId));
      expect(svcRows.length).toBe(2);
    } finally {
      await scenario.cleanup();
    }
  }, 120_000);
});
