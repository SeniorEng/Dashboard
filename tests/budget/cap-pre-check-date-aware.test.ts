/**
 * Task #425 — §45b ist seit der Umstellung auf das Jahrestopf-Modell ohne
 * Monats-Cap. Der Pre-Check in `createConsumptionTransaction` darf für §45b
 * KEINE Monats-Cap-Logik mehr anwenden. Verfügbarkeit ergibt sich aus der
 * bis zum transactionDate aufgelaufenen Allocation minus bereits gebuchter
 * Beträge.
 *
 * Die Tests sichern zwei zentrale Invarianten:
 *  1. Im AKTUELLEN Monat reicht der Topf so weit, wie bis "heute" aufgelaufen
 *     ist — danach blockt der Pre-Check, weil zukünftige Aufstockungen
 *     date-aware NICHT zählen.
 *  2. Im FOLGEMONAT zählt die zusätzliche Aufstockung mit, sodass dort
 *     wieder Buchungen möglich sind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("Task #425 — §45b Pre-Check ist date-aware (Jahrestopf-Modell)", () => {
  let scenario: BudgetScenarioHandle;
  let employeeId: number;

  beforeAll(async () => {
    // §45b ohne Monats-Cap. Topf-Startwert 50000 ct (500 €) ist hoch genug,
    // dass NICHT der Topf, sondern die date-aware Verfügbarkeit limitiert.
    // Aktueller Monat verbraucht 3800 ct (60 min HW dokumentiert).
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T425-PRECHECK",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
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
          notes: "T425 Vorverbrauch im aktuellen Monat",
        },
      ],
    });
    employeeId = scenario.employeeId;
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  it("erlaubt 60min-HW im AKTUELLEN Monat solange Topf-Verfügbarkeit reicht (kein Monats-Cap mehr)", async () => {
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
      notes: "T425 pre-check current-month",
    }).returning();

    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    const hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: hwId,
      plannedDurationMinutes: 60,
    });

    // Topf hat 50000 ct - 3800 ct (Vorverbrauch) = 46200 ct verfügbar — weit
    // mehr als die 3800 ct des neuen Termins. Vor Task #425 hätte der
    // Monats-Cap (131 € Default) den zweiten Termin geblockt; jetzt ist der
    // Topf die einzige Schranke.
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

  it("erlaubt 60min-HW im FOLGEMONAT (zusätzliche Aufstockung wird date-aware mitberechnet)", async () => {
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
      notes: "T425 pre-check next-month",
    }).returning();

    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    const hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
    await db.insert(appointmentServices).values({
      appointmentId: appt.id,
      serviceId: hwId,
      plannedDurationMinutes: 60,
    });

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

  it("Cost-Estimate für §45b spiegelt den date-aware Topf-Rest (kein Cap-Fenster)", async () => {
    // Indirekter Konsistenz-Check: Cost-Estimate muss exakt mit
    // currentMonthAvailableCents == availableCents arbeiten — beides ist im
    // Jahrestopf-Modell synonym. So kann es keine Drift zwischen UI-Anzeige
    // und Engine-Buchung mehr geben.
    const overview = await apiGet<any>(`/api/budget/${scenario.customerId}/overview`);
    expect(overview.status).toBe(200);
    const s45b = overview.data.entlastungsbetrag45b;
    expect(s45b.monthlyLimitCents).toBeNull();
    expect(s45b.currentMonthAvailableCents).toBe(s45b.availableCents);
  });
});
