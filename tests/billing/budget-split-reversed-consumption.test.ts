/**
 * Task #1011 — Regression: Der Rechnungs-Topf-Split (`getBudgetSplitForAppointments`)
 * darf nur die AKTIVE (nicht stornierte) Budget-Belegung berücksichtigen.
 *
 * Prod-Bug (Egon Uhlig, April 2026): Die einzige §45a-Buchung eines Termins
 * wurde am selben Tag wieder storniert (netto null). Der alte Split zählte die
 * stornierte `consumption`-Zeile trotzdem mit → es entstand eine Phantom-§45a-
 * Folgerechnung für einen Topf, der real gar nicht (mehr) belegt war.
 *
 * Drei Szenarien (deterministisch über synthetische budget_transactions):
 *  A) Termin mit LIVE §45b + storniertem §45a → Split nur §45b.
 *  B) Termin, dessen EINZIGE Belegung (§45a) storniert wurde (netto null) →
 *     NICHT auf private fallen, sondern aus der aktuellen Allocation re-derivieren
 *     (§45b verfügbar, höchste Priorität) → Split §45b.
 *  C) Kontrolle: Termin mit echter, nicht stornierter §45a-Belegung → Split §45a
 *     bleibt unverändert (kein Cent-Drift).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { getBudgetSplitForAppointments } from "../../server/services/invoice-data";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

let customerId: number;
let employeeId: number;
let abServiceId: number;
let apptA: number;
let apptB: number;
let apptC: number;
const cleanupApptIds: number[] = [];

async function createAppt(scheduledStart: string, scheduledEnd: string): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date: APPT_DATE,
    scheduledStart,
    scheduledEnd,
    notes: `Split-Reversal-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId: abServiceId, durationMinutes: 30 }],
  });
  expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
  cleanupApptIds.push(res.data.id);
  return res.data.id;
}

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Reversal",
    nachname: `Split-${uniqueId()}`,
    geburtsdatum: "1942-05-10",
    email: `reversal-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "12",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000001",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  customerId = custRes.data.id;

  const emp = await createTestEmployee({ vorname: "Marcel", nachnamePrefix: "Split_Integ" });
  employeeId = emp.id;
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // §45b komfortabel ausgestattet (für die Re-Derivation in Szenario B) +
  // §45a aktiv mit niedrigerer Priorität.
  const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-0${MONTH}-01`,
  });
  expect([200, 201]).toContain(init45b.status);
  const init45a = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "umwandlung_45a",
    currentMonthAmountCents: 59880,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-0${MONTH}-01`,
  });
  expect([200, 201]).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 59880, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  apptA = await createAppt("13:00", "13:30");
  apptB = await createAppt("14:00", "14:30");
  apptC = await createAppt("15:00", "15:30");

  // --- Synthetische Buchungen (INSERT ist der normale Pfad; Immutabilitäts-
  // Trigger greifen nur bei UPDATE/DELETE). ---

  // Szenario A: LIVE §45b (1058) + stornierte §45a (1200).
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "entlastungsbetrag_45b", transactionDate: APPT_DATE,
    transactionType: "consumption", amountCents: -1058, appointmentId: apptA,
    notes: "A: live §45b",
  });
  const [aOrig45a] = await db.insert(budgetTransactions).values({
    customerId, budgetType: "umwandlung_45a", transactionDate: APPT_DATE,
    transactionType: "consumption", amountCents: -1200, appointmentId: apptA,
    notes: "A: §45a (wird storniert)",
  }).returning({ id: budgetTransactions.id });
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "umwandlung_45a", transactionDate: APPT_DATE,
    transactionType: "reversal", amountCents: 1200, appointmentId: apptA,
    reversedTransactionId: aOrig45a.id, notes: "A: Storno §45a",
  });

  // Szenario B: EINZIGE Belegung §45a (2380) → storniert (netto null).
  const [bOrig45a] = await db.insert(budgetTransactions).values({
    customerId, budgetType: "umwandlung_45a", transactionDate: APPT_DATE,
    transactionType: "consumption", amountCents: -2380, appointmentId: apptB,
    notes: "B: §45a (wird storniert)",
  }).returning({ id: budgetTransactions.id });
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "umwandlung_45a", transactionDate: APPT_DATE,
    transactionType: "reversal", amountCents: 2380, appointmentId: apptB,
    reversedTransactionId: bOrig45a.id, notes: "B: Storno §45a",
  });

  // Szenario C: echte, nicht stornierte §45a-Belegung (1500).
  await db.insert(budgetTransactions).values({
    customerId, budgetType: "umwandlung_45a", transactionDate: APPT_DATE,
    transactionType: "consumption", amountCents: -1500, appointmentId: apptC,
    notes: "C: live §45a",
  });
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("getBudgetSplitForAppointments — stornierte Belegung (Task #1011)", () => {
  it("zählt stornierte Konsumption nicht, re-deriviert netto-null-Termine aus der Allocation", async () => {
    const split = await getBudgetSplitForAppointments(customerId, [apptA, apptB, apptC]);

    // A: stornierte §45a entfällt, nur LIVE §45b bleibt.
    expect(split.get(apptA)?.cents).toEqual({ entlastungsbetrag_45b: 1058 });

    // B: netto null → KEIN private-Fallback, sondern Re-Derivation auf §45b
    //    (höchste Priorität, ausreichend verfügbar). Kein Phantom-§45a.
    expect(split.get(apptB)?.cents).toEqual({ entlastungsbetrag_45b: 2380 });

    // C: echte §45a-Belegung unverändert (kein Cent-Drift).
    expect(split.get(apptC)?.cents).toEqual({ umwandlung_45a: 1500 });
  }, 120_000);
});
