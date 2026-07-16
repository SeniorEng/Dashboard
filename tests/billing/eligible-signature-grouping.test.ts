import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Unterschrifts-Gruppierung der Abrechnungskarte (Task #1776 / basiert auf #1774)
 *
 * `GET /api/billing/eligible-customers` liefert pro Kunde das Feld
 * `eligibility {status, reason}`, gespeist aus der PURE SSoT
 * `classifyBillingEligibility` (identisch zum Generate-Pfad `buildInvoiceDraft`).
 *
 * Dieser End-to-End-Test sichert das kassen-/zahlerabhängige Signatur-Gate:
 *   • Pflegekasse (gesetzlich): ein Leistungsnachweis mit NUR
 *     Mitarbeiter-Unterschrift (`employee_signed`) genügt NICHT →
 *     `eligibility.status === "blocked"` und
 *     `eligibility.reason === "customer_signature_required"`.
 *   • Selbstzahler: derselbe LN-Status (`employee_signed`) reicht →
 *     `eligibility.status === "eligible"` (kein Reason).
 *
 * Ohne diesen Test kann ein späteres Refactoring der Route die Gruppierung
 * „Bereit zum Abrechnen" still zerbrechen.
 *
 * ISOLATION: Wir prüfen IMMER nur die eigenen Kunden per `customerId`, nie
 * globale Summen. DATUM: vollständig vergangener Vormonat (innerhalb der
 * 3-Monats-Grenze für die Termin-Anlage).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testEmployeeId: number;
let hwServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

const NOW = new Date();
const FIRST_OF_THIS_MONTH = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
const LAST_OF_PREV_MONTH = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
const BILLING_YEAR = LAST_OF_PREV_MONTH.getFullYear();
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1; // 1-12
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();
const MONTH_START_ISO = `${BILLING_YEAR}-${String(BILLING_MONTH).padStart(2, "0")}-01`;

async function createApptInMonth(
  customerId: number,
  durationMinutes: number,
  tag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let day = 1; day <= LAST_DAY; day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue; // Wochenende überspringen
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `SIG-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`createApptInMonth(${tag}): kein freier Werktag-Slot in ${BILLING_YEAR}-${BILLING_MONTH}`);
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  actualMinutes: number,
  details: string,
): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: actualMinutes, details }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

/** Erstellt einen Sammel-LN und signiert ihn NUR mit der Mitarbeiter-Unterschrift
 *  (Status bleibt `employee_signed` — KEINE Kundenunterschrift). */
async function createEmployeeSignedServiceRecord(customerId: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year: BILLING_YEAR,
    month: BILLING_MONTH,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  const signRes = await apiPost<any>(`/api/service-records/${srId}/sign`, {
    signerType: "employee",
    signatureData: validSignatureDataUrl(),
  });
  if (signRes.status !== 200) {
    throw new Error(`signServiceRecord(${srId}, employee) failed: ${signRes.status} ${JSON.stringify(signRes.data)}`);
  }
  return srId;
}

async function assignPrimary(customerId: number): Promise<void> {
  await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
}

async function createSelbstzahlerCustomer(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "SIG",
    nachname: `Privat-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `sig-privat-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "SIG",
        mobilnummer: "+4917600000010",
      },
    ],
  });
  if (res.status !== 201) {
    throw new Error(`createSelbstzahlerCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await assignPrimary(id);
  return id;
}

async function createPflegekasseCustomer(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "SIG",
    nachname: `Kasse-${uniqueId()}`,
    geburtsdatum: "1941-03-22",
    email: `sig-kasse-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "7",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000099",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  if (res.status !== 201) {
    throw new Error(`createPflegekasseCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await assignPrimary(id);

  // §45b-Topf finanzieren, damit der Termin dokumentiert/gebucht werden kann.
  const init45b = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: MONTH_START_ISO,
  });
  if (![200, 201].includes(init45b.status)) {
    throw new Error(`init §45b failed: ${init45b.status} ${JSON.stringify(init45b.data)}`);
  }
  const typesRes = await apiPut<any>(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  if (typesRes.status !== 200) {
    throw new Error(`type-settings failed: ${typesRes.status} ${JSON.stringify(typesRes.data)}`);
  }
  return id;
}

type Eligibility = { status: "eligible" | "blocked"; reason: string | null };
type EligibleRow = {
  id: number;
  billingType: string;
  eligibility?: Eligibility;
};

async function eligibleRowFor(customerId: number): Promise<EligibleRow | undefined> {
  const res = await apiGet<EligibleRow[]>(
    `/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`,
  );
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.find((c) => c.id === customerId);
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestSIG" });
  testEmployeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ }
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ }
  }
  await deactivateTestEmployee(testEmployeeId);
});

describe("SIG: eligible-customers Unterschrifts-Gate (Task #1776)", () => {
  let kasseCustomerId: number;
  let privatCustomerId: number;

  beforeAll(async () => {
    // Pflegekasse: dokumentierter Termin + LN NUR mit Mitarbeiter-Unterschrift.
    kasseCustomerId = await createPflegekasseCustomer();
    const kasseAppt = await createApptInMonth(kasseCustomerId, 30, "kasse");
    await documentAppointment(kasseAppt.id, kasseAppt.time, 30, "kasse");
    await createEmployeeSignedServiceRecord(kasseCustomerId);

    // Selbstzahler: dokumentierter Termin + LN NUR mit Mitarbeiter-Unterschrift.
    privatCustomerId = await createSelbstzahlerCustomer();
    const privatAppt = await createApptInMonth(privatCustomerId, 30, "privat");
    await documentAppointment(privatAppt.id, privatAppt.time, 30, "privat");
    await createEmployeeSignedServiceRecord(privatCustomerId);
  });

  it("SIG-1 — Pflegekasse mit nur employee_signed LN ist blocked/customer_signature_required", async () => {
    const row = await eligibleRowFor(kasseCustomerId);
    expect(row, "Pflegekasse-Kunde muss gelistet sein").toBeDefined();
    expect(row!.billingType).toBe("pflegekasse_gesetzlich");
    expect(row!.eligibility).toBeDefined();
    expect(row!.eligibility!.status).toBe("blocked");
    expect(row!.eligibility!.reason).toBe("customer_signature_required");
  });

  it("SIG-2 — Selbstzahler mit employee_signed LN ist eligible", async () => {
    const row = await eligibleRowFor(privatCustomerId);
    expect(row, "Selbstzahler-Kunde muss gelistet sein").toBeDefined();
    expect(row!.billingType).toBe("selbstzahler");
    expect(row!.eligibility).toBeDefined();
    expect(row!.eligibility!.status).toBe("eligible");
    expect(row!.eligibility!.reason).toBeNull();
  });
});
