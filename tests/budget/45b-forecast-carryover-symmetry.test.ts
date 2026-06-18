/**
 * Task #1340 — §45b „Verfügbar nach Planung" (Forecast): Carryover-Verfalls-Symmetrie.
 *
 * Die Task-#704-Vorausschau (`getBudgetSummary`) ließ für projizierte Monate
 * NACH dem 30.06. den abgelaufenen Vorjahres-Übertrag aus der projizierten
 * Allokation (`allocAtEnd`) fallen — der im 1. Halbjahr GEGEN diesen Übertrag
 * gebuchte Verbrauch blieb aber in `cumulativeUsed`/`netUsedCents` und belastete
 * so doppelt den laufenden Jahrestopf. Folge: falsche „Budget reicht nicht"-
 * Warnungen bzw. negative `availableAfterPlannedCents` für §45b-Kunden mit
 * langlaufenden Serien über die Juli-Grenze.
 *
 * Der Fix wendet dieselbe SSoT-Exklusion (`getExcluded45bConsumption` →
 * `calculateAllocated45b`, Task #1306) wie `unified-reader`/`consumption-engine`
 * an — MIT `projectFuture: true`, damit Allocation- und Exklusions-Fenster im
 * Forecast identisch sind. Diese Tests pinnen:
 *   1. Symmetrie über die Juli-Grenze (Verbrauch gegen den abgelaufenen Übertrag
 *      drückt den Forecast NICHT unter eine sonst identische Control) + nie negativ,
 *   2. keine Über-Korrektur an der Juni-Grenze (dort gültiger Übertrag → Verbrauch
 *      zählt regulär),
 *   3. keine Über-Unterdrückung: eine ECHTE Juli-Lücke wird weiter als Fehlbetrag
 *      mit `plannedShortfallMonth` gemeldet.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices } from "@shared/schema";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { upsertCarryoverAllocation } from "../../server/storage/budget/allocation-storage";
import { getBudgetSummary } from "../../server/storage/budget/summary-queries";
import { setupBudgetScenario, type BudgetScenarioHandle } from "../helpers/budget-scenarios";
import { getAuthCookie, runCleanup, apiGet } from "../test-utils";

beforeAll(async () => { await getAuthCookie(); });
afterAll(async () => { await runCleanup(); });

// Task #1306/#1340 — alle Datumsanker aus EINEM berechneten Anker ableiten, damit
// der Test nicht an der 30.06.-Grenze kippt. `getBudgetSummary` respektiert den
// übergebenen `asOfDate` (= internes „heute"), daher ist das Lesen deterministisch.
const YEAR = new Date().getFullYear();
const PREV_YEAR = YEAR - 1;
const MONTHLY_45B_CENTS = 2000; // kleines Monatslimit → handhabbare Zahlen
const CARRYOVER_CENTS = 5000; // Übertrag, läuft am 30.06. ab; fasst die H1-Buchung voll
const CONSUMPTION_MINUTES = 30; // < Übertrag ⇒ FIFO bucht voll gegen den Übertrag

const AS_OF_JUNE = `${YEAR}-06-10`; // Stichtag: Übertrag noch gültig
const CONSUMPTION_DATE = `${YEAR}-02-17`; // 1. Halbjahr → gegen den Übertrag
const JUNE_PLAN_DATE = `${YEAR}-06-20`; // geplanter Termin im laufenden Monat
const JULY_PLAN_DATE = `${YEAR}-07-20`; // geplanter Termin nach Übertrags-Verfall

const handles: BudgetScenarioHandle[] = [];
const directApptIds: number[] = [];
let hwId = 0;

async function makeCustomer(prefix: string): Promise<BudgetScenarioHandle> {
  const handle = await setupBudgetScenario({
    customerNamePrefix: prefix,
    pflegegrad: 2,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    pflegegradSeit: "2024-01-01",
    types: [
      { type: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: MONTHLY_45B_CENTS },
      { type: "umwandlung_45a", priority: 2, enabled: false },
      { type: "ersatzpflege_39_42a", priority: 3, enabled: false },
    ],
  });
  handles.push(handle);
  // Vorjahres-Übertrag → Fenster YEAR-01-01 .. YEAR-06-30 (carryoverWindowFor).
  await upsertCarryoverAllocation({
    customerId: handle.customerId,
    budgetType: "entlastungsbetrag_45b",
    sourceYear: PREV_YEAR,
    amountCents: CARRYOVER_CENTS,
  });
  return handle;
}

/** Direkte H1-Buchung (umgeht Routen-Datums-/Wochenend-Prüfungen). FIFO bucht
 *  zuerst gegen den Übertrag (Priorität 0) — genau der Topf, der ab Juli aus der
 *  projizierten Allokation fällt. Liefert den gebuchten Betrag (Cent). */
async function bookH1Consumption(customerId: number, employeeId: number): Promise<number> {
  const [appt] = await db.insert(appointments).values({
    customerId,
    assignedEmployeeId: employeeId,
    appointmentType: "kundentermin", // klein → NICHT als „geplant" gezählt
    date: CONSUMPTION_DATE,
    scheduledStart: "10:00:00",
    scheduledEnd: "10:30:00",
    durationPromised: CONSUMPTION_MINUTES,
    status: "scheduled",
    notes: "T1340 H1-Verbrauch",
  }).returning();
  directApptIds.push(appt.id);
  await db.insert(appointmentServices).values({
    appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: CONSUMPTION_MINUTES,
  });
  const tx = await createConsumptionTransaction({
    customerId,
    appointmentId: appt.id,
    transactionDate: CONSUMPTION_DATE,
    hauswirtschaftMinutes: CONSUMPTION_MINUTES,
    alltagsbegleitungMinutes: 0,
    travelKilometers: 0,
    customerKilometers: 0,
    userId: employeeId,
  });
  return Math.abs(tx.amountCents);
}

/** Geplanter (offener) Termin — wird von `getPlannedCostByAppointment`
 *  (status='scheduled', appointment_type='Kundentermin') als „geplant" gewertet. */
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
    notes: "T1340 geplant",
  }).returning();
  directApptIds.push(appt.id);
  await db.insert(appointmentServices).values({
    appointmentId: appt.id, serviceId: hwId, plannedDurationMinutes: minutes,
  });
}

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

describe("Task #1340 — §45b Forecast Carryover-Verfalls-Symmetrie", () => {
  it("Juli-Horizont: H1-Verbrauch gegen den abgelaufenen Übertrag drückt den Forecast NICHT unter die Control (und bleibt ≥ 0)", async () => {
    const consumed = await makeCustomer("T1340-CONSUMED");
    const control = await makeCustomer("T1340-CONTROL");

    // Beide Kunden identisch planen: je ein Juni- + Juli-Termin → der Horizont
    // erreicht Juli, wo der Übertrag verfällt.
    for (const h of [consumed, control]) {
      await addPlannedAppt(h.customerId, h.employeeId, JUNE_PLAN_DATE, CONSUMPTION_MINUTES);
      await addPlannedAppt(h.customerId, h.employeeId, JULY_PLAN_DATE, CONSUMPTION_MINUTES);
    }
    // NUR der „consumed"-Kunde hat den H1-Verbrauch gegen den Übertrag.
    const consumedCents = await bookH1Consumption(consumed.customerId, consumed.employeeId);
    expect(consumedCents).toBeGreaterThan(0);
    expect(consumedCents).toBeLessThan(CARRYOVER_CENTS);

    const sConsumed = await getBudgetSummary(consumed.customerId, undefined, undefined, AS_OF_JUNE);
    const sControl = await getBudgetSummary(control.customerId, undefined, undefined, AS_OF_JUNE);

    // Kernaussage des Fixes: der gegen den ab Juli entfernten Übertrag gebuchte
    // Verbrauch darf den projizierten Rest NICHT unter die sonst identische
    // Control drücken (vor dem Fix: sConsumed = sControl − consumedCents).
    expect(sConsumed.availableAfterPlannedCents).toBe(sControl.availableAfterPlannedCents);
    // Keine falsche „Budget reicht nicht"-Warnung.
    expect(sConsumed.availableAfterPlannedCents).toBeGreaterThanOrEqual(0);
    expect(sConsumed.plannedShortfallMonth).toBeNull();
  });

  it("Juni-Horizont: dort gültiger Übertrag → H1-Verbrauch zählt regulär (keine Über-Korrektur)", async () => {
    const consumed = await makeCustomer("T1340-JUN-CONSUMED");
    const control = await makeCustomer("T1340-JUN-CONTROL");

    // NUR Juni planen → Horizont bleibt im Juni, Übertrag noch gültig (30.06.).
    for (const h of [consumed, control]) {
      await addPlannedAppt(h.customerId, h.employeeId, JUNE_PLAN_DATE, CONSUMPTION_MINUTES);
    }
    const consumedCents = await bookH1Consumption(consumed.customerId, consumed.employeeId);
    expect(consumedCents).toBeGreaterThan(0);

    const sConsumed = await getBudgetSummary(consumed.customerId, undefined, undefined, AS_OF_JUNE);
    const sControl = await getBudgetSummary(control.customerId, undefined, undefined, AS_OF_JUNE);

    // Im Juni ist der Übertrag noch gültig → die Exklusion ist leer → der
    // Verbrauch wird regulär abgezogen (consumed liegt um den vollen Betrag
    // unter der Control). Das pinnt, dass der Fix die Juni-Seite NICHT verändert.
    expect(sConsumed.availableAfterPlannedCents).toBe(
      sControl.availableAfterPlannedCents - consumedCents,
    );
  });

  it("Juli-Horizont: eine ECHTE Über-Planung bleibt als Fehlbetrag gemeldet (keine Über-Unterdrückung)", async () => {
    const customer = await makeCustomer("T1340-SHORTFALL");
    await bookH1Consumption(customer.customerId, customer.employeeId);

    // Schwere Juli-Planung weit über der bis Juli aufgelaufenen Allokation
    // (7 × MONTHLY_45B_CENTS = 14000, Übertrag ab Juli weg). 600 Min HW ≫ 14000 Cent.
    await addPlannedAppt(customer.customerId, customer.employeeId, JULY_PLAN_DATE, 600);

    const summary = await getBudgetSummary(customer.customerId, undefined, undefined, AS_OF_JUNE);

    // Der Fehlbetrag muss erhalten bleiben (der Fix darf reale Lücken nicht
    // wegrechnen) und exakt im Juli-Monat verortet sein.
    expect(summary.availableAfterPlannedCents).toBeLessThan(0);
    expect(summary.plannedShortfallMonth).toBe(`${YEAR}-07`);
  });
});
