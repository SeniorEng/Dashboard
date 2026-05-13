/**
 * Task #425 — §45b Jahrestopf: Eine spätere Buchung darf die Verfügbarkeit
 * für ein früheres Termindatum NICHT reduzieren. Vor dem Fix subtrahierte
 * `getAvailableForDate` netConsumedAllTime (alle Buchungen). Jetzt wird
 * date-bounded (`transactionDate <= asOfDate`) subtrahiert.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { getAvailableForDate } from "../../server/storage/budget/import-availability";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup, apiGet } from "../test-utils";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

describe("Task #425 — §45b date-bounded netConsumed", () => {
  let scenario: BudgetScenarioHandle;
  let employeeId: number;
  let hwId: number;

  beforeAll(async () => {
    scenario = await setupBudgetScenario({
      customerNamePrefix: "T425-FUTURE-ISO",
      pflegegrad: 2,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      preferences: { budgetStartDate: "2026-01-01" },
      types: [
        { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
        { type: "umwandlung_45a", priority: 2, enabled: false },
        { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
      ],
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 100000, validFrom: "2026-01-01" },
      appointments: [],
    });
    employeeId = scenario.employeeId;
    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  });
  afterAll(async () => { await scenario.cleanup(); });

  async function bookAppt(date: string) {
    const [appt] = await db.insert(appointments).values({
      customerId: scenario.customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date,
      scheduledStart: "10:00:00",
      scheduledEnd: "11:00:00",
      durationPromised: 60,
      status: "scheduled",
      notes: "T425 isolation",
    }).returning();
    await db.insert(appointmentServices).values({
      appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: 60,
    });
    await createConsumptionTransaction({
      customerId: scenario.customerId,
      appointmentId: appt.id,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId: employeeId,
    });
  }

  it("Buchung im Folgemonat reduziert die Verfügbarkeit am Vormonats-Datum NICHT", async () => {
    const earlierDate = "2026-02-15";
    const laterDate = "2026-03-15";
    const availEarlierBefore = (await getAvailableForDate(scenario.customerId, earlierDate)).total45b;
    const availLaterBefore = (await getAvailableForDate(scenario.customerId, laterDate)).total45b;
    expect(availEarlierBefore).toBeGreaterThan(0);
    // Folgemonat hat mehr Akkrual → Verfügbarkeit größer.
    expect(availLaterBefore).toBeGreaterThan(availEarlierBefore);

    await bookAppt(laterDate);

    // Kernaussage: Verfügbarkeit am früheren Datum ist UNVERÄNDERT
    // (date-bounded netConsumed schließt die Buchung am späteren Datum aus).
    const availEarlierAfter = (await getAvailableForDate(scenario.customerId, earlierDate)).total45b;
    expect(availEarlierAfter).toBe(availEarlierBefore);

    // Verfügbarkeit am späteren Datum ist um die Buchung gesunken.
    const availLaterAfter = (await getAvailableForDate(scenario.customerId, laterDate)).total45b;
    expect(availLaterAfter).toBeLessThan(availLaterBefore);
  });
});
