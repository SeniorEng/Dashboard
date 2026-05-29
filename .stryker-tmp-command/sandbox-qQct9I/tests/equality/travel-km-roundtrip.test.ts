/**
 * Task #611 — Equality: appointment.travelKilometers == Σ budget_transactions.travelKilometers.
 *
 * Hintergrund: vor #611 hat `buildConsumptionTxData` die km-Spalte mit
 * `Math.round(km * ratio)` auf Integer-km eingedampft. Dadurch driftete
 * der in der Budgetübersicht (`BudgetLedgerSection`) angezeigte km-Wert
 * vom Termin-Detail (`AppointmentTravelCard`) ab — z.B. 7,3 km im Termin
 * vs. 7 km in der Budget-Zeile. Bei verschachtelten Bestands-Bugs (z.B.
 * ursprünglich 70 km eingegeben, später auf 7,3 korrigiert ohne Rebook)
 * waren bis zu Faktor-10-Drifts sichtbar.
 *
 * Dieser Test bucht über die ECHTE Engine (`createConsumptionTransaction`)
 * und prüft pro Termin:
 *   Σ tx.travelKilometers       == appt.travelKilometers   (±0,15 km)
 *   Σ tx.customerKilometers     == appt.customerKilometers (±0,15 km)
 *
 * Toleranz 0,15 km deckt Rundungs-Drift durch Multi-Allocation-Splits ab,
 * fängt aber den Integer-Truncation-Bug zuverlässig (Δ = 0,3 km bei 7,3
 * gerundet auf 7).
 */
// @ts-nocheck

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getAuthCookie,
  getTodayDate,
  runCleanup,
} from "../test-utils";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { bookConsumption } from "../helpers/budget-booking";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions } from "@shared/schema";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function getAppointmentKm(appointmentId: number) {
  const [a] = await db
    .select({
      travelKm: appointments.travelKilometers,
      customerKm: appointments.customerKilometers,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  return a;
}

async function getConsumptionKmSum(appointmentId: number) {
  const rows = await db
    .select({
      type: budgetTransactions.transactionType,
      travelKm: budgetTransactions.travelKilometers,
      customerKm: budgetTransactions.customerKilometers,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, appointmentId));
  const consume = rows.filter(r => r.type === "consumption");
  return {
    travelKmSum: consume.reduce((s, r) => s + (r.travelKm ?? 0), 0),
    customerKmSum: consume.reduce((s, r) => s + (r.customerKm ?? 0), 0),
  };
}

describe("Equality km — appt.travelKilometers == Σ budget_tx.travelKilometers (Task #611)", () => {
  const cases: Array<{ name: string; travelKm: number; customerKm: number; hwMinutes: number }> = [
    { name: "Dezimal 7,3 km Anfahrt (Regressionsfall)", travelKm: 7.3, customerKm: 0, hwMinutes: 60 },
    { name: "Dezimal 7,3 km + 2,4 km customer-km", travelKm: 7.3, customerKm: 2.4, hwMinutes: 60 },
    { name: "Nur customer-km dezimal (3,8 km)", travelKm: 0, customerKm: 3.8, hwMinutes: 60 },
    { name: "Ganzzahlige km (Kontrollfall, kein Drift)", travelKm: 10, customerKm: 0, hwMinutes: 60 },
  ];

  for (const c of cases) {
    it(`[${c.name}] Σ tx.km == appt.km (±0,15)`, async () => {
      const auth = await getAuthCookie();
      const date = getTodayDate();
      const scenario = await setupBudgetScenario({
        customerNamePrefix: "T611-KM",
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
      try {
        const booked = await bookConsumption({
          customerId: scenario.customerId,
          employeeId: scenario.employeeId,
          date,
          hwMinutes: c.hwMinutes,
          abMinutes: 0,
          travelKm: c.travelKm,
          customerKm: c.customerKm,
          userId: auth.user.id,
        });

        // Termin-Detail-Wert (das, was die AppointmentTravelCard zeigt) auf
        // den Buchungswert setzen — bookConsumption legt den Termin ohne
        // travelKilometers an, also patchen wir, was der reale POST-Pfad
        // (appointment-documentation.ts) tun würde.
        await db.update(appointments).set({
          travelKilometers: c.travelKm,
          customerKilometers: c.customerKm,
        }).where(eq(appointments.id, booked.appointmentId));

        const appt = await getAppointmentKm(booked.appointmentId);
        const sums = await getConsumptionKmSum(booked.appointmentId);

        const travelDrift = Math.abs((appt?.travelKm ?? 0) - sums.travelKmSum);
        const customerDrift = Math.abs((appt?.customerKm ?? 0) - sums.customerKmSum);

        expect(
          travelDrift,
          `appt.travelKilometers=${appt?.travelKm} ≠ Σ tx.travelKilometers=${sums.travelKmSum} ` +
          `(Drift ${travelDrift.toFixed(2)} km > 0,15)`,
        ).toBeLessThanOrEqual(0.15);
        expect(
          customerDrift,
          `appt.customerKilometers=${appt?.customerKm} ≠ Σ tx.customerKilometers=${sums.customerKmSum} ` +
          `(Drift ${customerDrift.toFixed(2)} km > 0,15)`,
        ).toBeLessThanOrEqual(0.15);
      } finally {
        await scenario.cleanup();
      }
    }, 120_000);
  }
});
