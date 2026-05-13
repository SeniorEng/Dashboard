/**
 * Task #423 (Architect-Befund Runde 3): Der Vorab-Check in
 * `createConsumptionTransaction` darf NICHT pauschal mit dem Cap-Rest des
 * heutigen Monats prüfen. Wenn ein Termin in einem ANDEREN Monat dokumentiert
 * wird (z.B. ein Nachtrag im Vormonat), gilt der Cap-Verbrauch des heutigen
 * Monats nicht. Sonst entsteht ein falscher "Budget reicht nicht"-Block,
 * obwohl der per-Datum-aware `computeCapSlot` in der Cascade die Buchung
 * korrekt durchlassen würde.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup, apiGet } from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

function weekdayInCurrentMonth(): string {
  const today = new Date();
  const month = today.getMonth();
  const year = today.getFullYear();
  for (let offset = 0; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  for (let offset = 1; offset <= 28; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (d.getMonth() !== month || d.getFullYear() !== year) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im aktuellen Monat gefunden");
}

function weekdayInNextMonth(): string {
  const next = new Date();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(next);
    d.setDate(next.getDate() + offset);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().split("T")[0];
  }
  throw new Error("Kein Werktag im nächsten Monat gefunden");
}

describe("Task #423 — consumption-engine pre-check ist date-aware", () => {
  let scenario: BudgetScenarioHandle;
  let employeeId: number;

  beforeAll(async () => {
    // Cap = 5000 ct, Pott = 50000 ct. Aktueller Monat verbraucht 3800 ct
    // (60min HW dokumentiert) → Cap-Rest aktueller Monat = 1200 ct.
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T423-PRECHECK",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 5000 },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: {
        type: "entlastungsbetrag_45b",
        amountCents: 50000,
        validFrom: "2026-01-01",
      },
      appointments: [
        {
          date: weekdayInCurrentMonth(),
          scheduledStart: "09:00",
          services: [{ code: "hauswirtschaft", durationMinutes: 60 }],
          document: true,
          notes: "T423 Cap-Verbrauch im aktuellen Monat",
        },
      ],
    });
    employeeId = scenario.employeeId;
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("blockt 60min-HW im AKTUELLEN Monat (Cap erschöpft)", async () => {
    const date = weekdayInCurrentMonth();
    const [appt] = await db.insert(appointments).values({
      customerId: scenario.customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date,
      scheduledStart: "10:00:00",
      scheduledEnd: "11:00:00",
      durationPromised: 60,
      status: "scheduled",
      notes: "T423 pre-check current-month",
    }).returning();

    // hauswirtschaft service id ermitteln
    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    const hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: hwId,
      plannedDurationMinutes: 60,
    });

    await expect(
      createConsumptionTransaction({
        customerId: scenario.customerId,
        appointmentId: appt.id,
        transactionDate: date,
        hauswirtschaftMinutes: 60,
        alltagsbegleitungMinutes: 0,
        travelKilometers: 0,
        customerKilometers: 0,
        userId: employeeId,
      }),
    ).rejects.toThrow(/Budget reicht nicht/i);
  });

  it("erlaubt 60min-HW im FOLGEMONAT obwohl der aktuelle Monats-Cap erschöpft ist", async () => {
    const date = weekdayInNextMonth();
    const [appt] = await db.insert(appointments).values({
      customerId: scenario.customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date,
      scheduledStart: "10:00:00",
      scheduledEnd: "11:00:00",
      durationPromised: 60,
      status: "scheduled",
      notes: "T423 pre-check next-month",
    }).returning();

    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    const hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: hwId,
      plannedDurationMinutes: 60,
    });

    // Sollte NICHT blocken — Folgemonat hat noch 5000 ct Cap.
    const txn = await createConsumptionTransaction({
      customerId: scenario.customerId,
      appointmentId: appt.id,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId: employeeId,
    });
    expect(txn).toBeDefined();
  });
});
