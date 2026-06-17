/**
 * Task #1306 — §45b Juli-Boundary: symmetrische Allocated/ConsumedNet-Korrektur.
 *
 * Reine §45b-Pflegekasse-Kunden (kein Selbstzahler) mit einem Vorjahres-Übertrag
 * (`carryover`, läuft am 30.06. ab) UND einem per IB-Supersession verdrängten
 * Vorjahres-`initial_balance` bekamen ab Juli fälschlich ein zu KLEINES Budget:
 *
 *   - `Allocated` lässt ab Juli den abgelaufenen Übertrag + den verdrängten
 *     Vorjahres-Startwert fallen (korrekt).
 *   - `ConsumedNet` zog aber WEITER den Verbrauch ab, der im 1. Halbjahr gegen
 *     genau diese (nun entfernten) Töpfe gebucht wurde → der laufende Jahrestopf
 *     wurde doppelt belastet (#57 Helga Dienelt: Reader ~113 € statt ~798 €).
 *
 * Der Fix macht beide Seiten symmetrisch: Verbrauch gegen einen aus `Allocated`
 * entfernten Topf wird auch aus `ConsumedNet` herausgerechnet. Diese Tests
 * pinnen das Juli-Verhalten (keine Doppelbelastung), die Juni-Grenze (Verbrauch
 * gegen den DORT noch gültigen Übertrag zählt unverändert) und die
 * Overview==Booking-Gleichheit fest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import {
  computeFifoAvailability,
  createConsumptionTransaction,
} from "../../server/storage/budget/consumption-engine";
import {
  upsertInitialBalanceAllocation,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import { getAvailableForDate } from "../../server/storage/budget/import-availability";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup, apiGet } from "../test-utils";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;
const MONTHLY_45B_CENTS = 13100; // BUDGET_45B_MAX_MONTHLY_CENTS (monthlyLimitCents=null ⇒ Default)
const CARRYOVER_CENTS = 13100;
const PRIOR_IB_CENTS = 13100;

const CONSUMPTION_DATE = `${YEAR}-02-16`; // 1. Halbjahr → gegen den Übertrag
const JUNE_DATE = `${YEAR}-06-15`; // Übertrag noch gültig (expiresAt 30.06.)
const JULY_DATE = `${YEAR}-07-15`; // Übertrag abgelaufen + Vorjahres-IB verdrängt
const JULY_BOOK_DATE = `${YEAR}-07-10`; // < JULY_DATE, damit der Read die Buchung zählt

async function seedExpiringPots(customerId: number): Promise<void> {
  // Vorjahres-Übertrag → Fenster YEAR-01-01 .. YEAR-06-30 (carryoverWindowFor).
  await upsertCarryoverAllocation({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    sourceYear: PREV_YEAR,
    amountCents: CARRYOVER_CENTS,
  });
  // Vorjahres-Startwert (wird ab Juli per IB-Supersession aus `Allocated`
  // entfernt). Direkt-Seed umgeht NUR den Routen-Onboarding-Cap.
  await upsertInitialBalanceAllocation({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    year: PREV_YEAR,
    month: 1,
    amountCents: PRIOR_IB_CENTS,
    validFrom: `${PREV_YEAR}-01-01`,
    expiresAt: null,
  });
}

async function makeCustomer(prefix: string): Promise<BudgetScenarioHandle> {
  return setupBudgetScenario({
    customerNamePrefix: prefix,
    pflegegrad: 2,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    pflegegradSeit: "2024-01-01",
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
      { type: "umwandlung_45a", priority: 2, enabled: false },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
    ],
  });
}

describe("Task #1306 — §45b Juli-Boundary Symmetrie", () => {
  let withConsumption: BudgetScenarioHandle;
  let control: BudgetScenarioHandle;
  let hwId: number;
  const extraAppointmentIds: number[] = [];
  let consumedCents = 0;

  beforeAll(async () => {
    const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
    hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    withConsumption = await makeCustomer("T1306-CONSUMED");
    control = await makeCustomer("T1306-CONTROL");

    await seedExpiringPots(withConsumption.customerId);
    await seedExpiringPots(control.customerId);

    // Verbrauch im 1. Halbjahr → FIFO bucht zuerst gegen den Übertrag
    // (priority 0). Genau dieser Topf wird ab Juli aus `Allocated` entfernt.
    consumedCents = await bookConsumption(
      withConsumption.customerId,
      withConsumption.employeeId,
      CONSUMPTION_DATE,
    );
    expect(consumedCents).toBeGreaterThan(0);
    expect(consumedCents).toBeLessThan(CARRYOVER_CENTS);
  });

  afterAll(async () => {
    for (const apptId of extraAppointmentIds.reverse()) {
      try {
        await db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, apptId));
        await db.delete(appointments).where(eq(appointments.id, apptId));
      } catch { /* best-effort */ }
    }
    await withConsumption.cleanup();
    await control.cleanup();
  });

  async function bookConsumption(
    customerId: number,
    employeeId: number,
    date: string,
  ): Promise<number> {
    const [appt] = await db.insert(appointments).values({
      customerId,
      assignedEmployeeId: employeeId,
      appointmentType: "kundentermin",
      date,
      scheduledStart: "10:00:00",
      scheduledEnd: "11:00:00",
      durationPromised: 60,
      status: "scheduled",
      notes: "T1306 H1-Verbrauch",
    }).returning();
    extraAppointmentIds.push(appt.id);
    await db.insert(appointmentServices).values({
      appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: 60,
    });
    const tx = await createConsumptionTransaction({
      customerId,
      appointmentId: appt.id,
      transactionDate: date,
      hauswirtschaftMinutes: 60,
      alltagsbegleitungMinutes: 0,
      travelKilometers: 0,
      customerKilometers: 0,
      userId: employeeId,
    });
    return Math.abs(tx.amountCents);
  }

  it("Juli: Verbrauch gegen den abgelaufenen Übertrag belastet den laufenden Topf NICHT (symmetrisch zur Control)", async () => {
    const availWith = (await getAvailableForDate(withConsumption.customerId, JULY_DATE)).total45b;
    const availControl = (await getAvailableForDate(control.customerId, JULY_DATE)).total45b;

    // Kernaussage des Fixes: der H1-Verbrauch lief gegen einen ab Juli
    // entfernten Topf, also darf er den Juli-Stand NICHT unter die Control
    // drücken (vor dem Fix: availWith === availControl − consumedCents).
    expect(availWith).toBe(availControl);
    // Und der Juli-Stand ist NICHT auf ~Restkrümel kollabiert (Bug: ~113 € statt
    // ~786 €): er liegt um den GANZEN H1-Verbrauch über dem alten Buggy-Wert und
    // umfasst mehrere Monats-Akkumulationen.
    expect(availWith).toBeGreaterThan(availControl - consumedCents);
    expect(availWith).toBeGreaterThanOrEqual(5 * MONTHLY_45B_CENTS);
  });

  it("Juli: Overview-Reader == Booking-Reader (eine SSoT)", async () => {
    const overview = (await getAvailableForDate(withConsumption.customerId, JULY_DATE)).total45b;
    const booking = (await computeFifoAvailability(
      withConsumption.customerId,
      "entlastungsbetrag_45b",
      JULY_DATE,
    )).totalAvailable;
    expect(booking).toBe(overview);
  });

  it("Juli: ein Juli-Termin ist buchbar (kein BUDGET_HARD_BLOCK)", async () => {
    const before = (await getAvailableForDate(withConsumption.customerId, JULY_DATE)).total45b;
    const tx = await bookConsumption(
      withConsumption.customerId,
      withConsumption.employeeId,
      JULY_BOOK_DATE,
    );
    expect(tx).toBeGreaterThan(0);
    // Verfügbarkeit ist nach der Buchung exakt um die Buchung gesunken.
    const after = (await getAvailableForDate(withConsumption.customerId, JULY_DATE)).total45b;
    expect(after).toBe(before - tx);
  });

  it("Juni-Grenze: Verbrauch gegen den DORT noch gültigen Übertrag zählt unverändert (keine Über-Korrektur)", async () => {
    const availWith = (await getAvailableForDate(withConsumption.customerId, JUNE_DATE)).total45b;
    const availControl = (await getAvailableForDate(control.customerId, JUNE_DATE)).total45b;

    // Im Juni ist der Übertrag noch gültig (expiresAt 30.06.) und der
    // Vorjahres-Startwert im 1. Halbjahr noch gezählt → der Verbrauch wird
    // regulär abgezogen (excluded-Menge ist hier leer).
    expect(availWith).toBe(availControl - consumedCents);
    // Overview==Booking gilt auch an der Juni-Grenze.
    const booking = (await computeFifoAvailability(
      withConsumption.customerId,
      "entlastungsbetrag_45b",
      JUNE_DATE,
    )).totalAvailable;
    expect(booking).toBe(availWith);
  });
});
