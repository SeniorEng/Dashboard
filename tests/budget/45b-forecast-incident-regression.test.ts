/**
 * Task #1395 — §45b „Verfügbar (nach Planung)" Produktions-Inzident (anonymisiert).
 *
 * Die Live-§45b-Übersicht zeigte für einen PG-3-/`pflegekasse_gesetzlich`-Kunden
 * mit
 *   - Vorjahres-Übertrag 1.572 € (gültig bis 30.06., source `carryover`),
 *   - Startwert (`initial_balance`) 250 € ab Mai,
 *   - monatlicher Aufstockung 65,50 € („Unser Anteil" = halbes §45b-Maximum),
 *   - EINER Verbrauchsbuchung 59,52 € (im 1. Halbjahr, gegen den Übertrag) und
 *   - nur im JUNI geplanten Terminen (Horizont = 30.06., Übertrag noch gültig)
 * fälschlich „Verfügbar (nach Planung) = -184,02 €" (= 65,50 − 59,52 − 190).
 *
 * Dieser Wert ist die Signatur der ALTEN, ASYMMETRISCHEN §45b-Forecast-Mathe: am
 * projizierten Monatsende fielen Übertrag UND Startwert aus der Allokation, der
 * gegen den Übertrag gebuchte Verbrauch blieb aber stehen. Der #1340-Fix
 * (symmetrische Carryover-Verfalls-Exklusion über die EINE SSoT
 * `netAvailable45bAt`) behebt das.
 *
 * Anders als der abstrakte #1340-Symmetrietest pinnt dieser Test die für den
 * Inzident charakteristische KOMBINATION Übertrag + Startwert am JUNI-Horizont
 * (gültiger Übertrag): beide bleiben in der Allokation, der Verbrauch wird NICHT
 * doppelt belastet, und „Verfügbar (nach Planung)" bleibt deutlich positiv —
 * niemals der -184,02-€-Regressionswert.
 *
 * Datumsanker sind jahr-relativ (Übertrags-Verfall = 30.06. des laufenden Jahres)
 * und `asOfDate` wird `getBudgetSummary` explizit übergeben → deterministisch
 * unabhängig von der realen Uhr.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { getBudgetSummary } from "../../server/storage/budget/summary-queries";
import { netAvailable45bAt } from "../../server/storage/budget/net-available-45b";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup, apiGet } from "../test-utils";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;

// Reale Inzident-Größen (Cent).
const CARRYOVER_CENTS = 157200; // 1.572 € Übertrag, läuft am 30.06. ab
const INITIAL_BALANCE_CENTS = 25000; // 250 € Startwert ab Mai
const MONTHLY_45B_CENTS = 6550; // 65,50 € monatliche Aufstockung („Unser Anteil")

const IB_VALID_FROM = `${YEAR}-05-01`;
const CONSUMPTION_DATE = `${YEAR}-06-04`; // gegen den (im Juni noch gültigen) Übertrag
const AS_OF_JUNE = `${YEAR}-06-23`; // Stichtag wie im Inzident
const JUNE_HORIZON = `${YEAR}-06-30`; // Forecast-Horizont (alle Termine im Juni)
// Geplante Juni-Termine (Minuten wie in Prod: 120/120/90/90).
const JUNE_PLAN = [
  { date: `${YEAR}-06-12`, minutes: 120 },
  { date: `${YEAR}-06-18`, minutes: 120 },
  { date: `${YEAR}-06-23`, minutes: 90 },
  { date: `${YEAR}-06-29`, minutes: 90 },
];

const handles: BudgetScenarioHandle[] = [];
const directApptIds: number[] = [];
let hwId = 0;

beforeAll(async () => {
  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
});

afterAll(async () => {
  for (const apptId of directApptIds.reverse()) {
    try {
      await db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, apptId));
      await db.delete(appointments).where(eq(appointments.id, apptId));
    } catch { /* best-effort */ }
  }
  for (const h of handles.reverse()) {
    try { await h.cleanup(); } catch { /* best-effort */ }
  }
});

async function makeIncidentCustomer(): Promise<BudgetScenarioHandle> {
  const handle = await setupBudgetScenario({
    customerNamePrefix: "T1395-FORECAST",
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    pflegegradSeit: "2024-01-01",
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: MONTHLY_45B_CENTS },
      { type: "umwandlung_45a", priority: 2, enabled: false },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
    ],
    carryover: { type: "entlastungsbetrag_45b", amountCents: CARRYOVER_CENTS, year: PREV_YEAR },
    initialBalance: { type: "entlastungsbetrag_45b", amountCents: INITIAL_BALANCE_CENTS, validFrom: IB_VALID_FROM },
  });
  handles.push(handle);
  return handle;
}

/** Verbrauch im 1. Halbjahr → FIFO bucht zuerst gegen den Übertrag. */
async function bookH1Consumption(customerId: number, employeeId: number, minutes: number): Promise<number> {
  const [appt] = await db.insert(appointments).values({
    customerId,
    assignedEmployeeId: employeeId,
    appointmentType: "kundentermin", // klein → NICHT als „geplant" gezählt
    date: CONSUMPTION_DATE,
    scheduledStart: "10:00:00",
    scheduledEnd: "10:30:00",
    durationPromised: minutes,
    status: "scheduled",
    notes: "T1395 H1-Verbrauch",
  }).returning();
  directApptIds.push(appt.id);
  await db.insert(appointmentServices).values({
    appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: minutes,
  });
  const tx = await createConsumptionTransaction({
    customerId,
    appointmentId: appt.id,
    transactionDate: CONSUMPTION_DATE,
    hauswirtschaftMinutes: minutes,
    alltagsbegleitungMinutes: 0,
    travelKilometers: 0,
    customerKilometers: 0,
    userId: employeeId,
  });
  return Math.abs(tx.amountCents);
}

async function addPlannedAppt(customerId: number, employeeId: number, date: string, minutes: number): Promise<void> {
  const [appt] = await db.insert(appointments).values({
    customerId,
    assignedEmployeeId: employeeId,
    appointmentType: "Kundentermin", // groß → planned-cost-Query trifft
    date,
    scheduledStart: "12:00:00",
    scheduledEnd: "13:00:00",
    durationPromised: minutes,
    status: "scheduled",
    notes: "T1395 geplant",
  }).returning();
  directApptIds.push(appt.id);
  await db.insert(appointmentServices).values({
    appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: minutes,
  });
}

describe("Task #1395 — §45b Forecast Prod-Inzident (Übertrag + Startwert, Juni-Horizont)", () => {
  it("Allokation am 30.06.-Horizont enthält Übertrag + Startwert + Monats-Aufstockung; KEINE Verbrauchs-Exklusion (Übertrag noch gültig)", async () => {
    const h = await makeIncidentCustomer();
    const consumed = await bookH1Consumption(h.customerId, h.employeeId, 30);
    expect(consumed).toBeGreaterThan(0);
    expect(consumed).toBeLessThan(CARRYOVER_CENTS);

    const net = await netAvailable45bAt(h.customerId, JUNE_HORIZON, { projectFuture: true, holds: "ignore" });

    // Übertrag (1.572) + Startwert (250) + 1× Monats-Aufstockung Juni (65,50) = 1.887,50 €.
    expect(net.allocatedCents).toBe(CARRYOVER_CENTS + INITIAL_BALANCE_CENTS + MONTHLY_45B_CENTS);
    // Am 30.06. ist der Übertrag noch gültig → die #1340-Exklusion ist leer.
    expect(net.excludedConsumedNetCents).toBe(0);
    // Der Verbrauch wird genau einmal abgezogen (keine Doppelbelastung).
    expect(net.consumedNetCents).toBe(consumed);
    // Vorzeichenbehaftete Verfügbarkeit (Alrik-Gate #95) ist deutlich positiv.
    expect(net.allocatedCents - net.consumedNetCents).toBeGreaterThan(150000);
  });

  it("„Verfügbar (nach Planung)“ bleibt stark positiv und meldet KEINEN Fehlbetrag (nie -184,02 €)", async () => {
    const h = await makeIncidentCustomer();
    await bookH1Consumption(h.customerId, h.employeeId, 30);
    for (const p of JUNE_PLAN) {
      await addPlannedAppt(h.customerId, h.employeeId, p.date, p.minutes);
    }

    const summary = await getBudgetSummary(h.customerId, undefined, undefined, AS_OF_JUNE);

    // Regressionskern: der Inzident-Wert war NEGATIV (-184,02 €). Mit dem
    // #1340-Fix bleibt der projizierte Rest klar positiv (Übertrag deckt die
    // Juni-Planung locker), und es darf KEINE „Budget reicht nicht"-Warnung
    // entstehen.
    expect(summary.availableAfterPlannedCents).toBeGreaterThan(0);
    expect(summary.plannedShortfallMonth).toBeNull();
  });
});
