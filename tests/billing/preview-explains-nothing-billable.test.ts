import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1881 — Der „Neue Rechnung erstellen"-Dialog (`GET /api/billing/preview`)
 * muss auch dann eine STRUKTURIERTE Vorschau liefern, wenn aktuell nichts
 * abrechenbar ist, statt mit einer generischen Meldung abzubrechen.
 *
 * Fall „Bernd Funke": Ein Pflegekassen-Kunde mit
 *   • EINEM bereits abgerechneten kundensignierten (`completed`) Termin UND
 *   • ZWEI weiteren dokumentierten Terminen unter einem NUR mitarbeiter-
 *     signierten (`employee_signed`) LN (bei Pflegekasse NICHT abrechenbar)
 * darf im Dialog NICHT nur „Alle Termine … bereits abgerechnet" zeigen. Die
 * Vorschau muss `totalCents === 0`, `coveredAppointments === 0` UND einen
 * termin-genauen `excludedAppointments`-Block mit BEIDEN Gründen liefern
 * (`already_billed` + `customer_signature_required`).
 *
 * ISOLATION: Immer nur der eigene Kunde per `customerId`, nie globale Summen.
 * DATUM: vollständig vergangener Vormonat (innerhalb der 3-Monats-Grenze).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { BillingInvoicePreview } from "@shared/api";
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
        notes: `PREV-${tag}-${uniqueId()}`,
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

async function createServiceRecord(customerId: number): Promise<number> {
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
  return srId;
}

async function signServiceRecord(srId: number, signerType: "employee" | "customer"): Promise<void> {
  const res = await apiPost<any>(`/api/service-records/${srId}/sign`, {
    signerType,
    signatureData: validSignatureDataUrl(),
  });
  if (res.status !== 200) {
    throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function assignPrimary(customerId: number): Promise<void> {
  await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
}

async function createPflegekasseCustomer(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "PREV",
    nachname: `Kasse-${uniqueId()}`,
    geburtsdatum: "1941-03-22",
    email: `prev-kasse-${uniqueId()}@test.local`,
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

async function generateAll(): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate-all", { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR });
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function resultFor(gaData: any, customerId: number): any {
  return (gaData.results ?? []).find((r: any) => r.customerId === customerId);
}

async function previewFor(customerId: number): Promise<{ status: number; data: BillingInvoicePreview }> {
  const res = await apiGet<BillingInvoicePreview>(
    `/api/billing/preview?customerId=${customerId}&month=${BILLING_MONTH}&year=${BILLING_YEAR}`,
  );
  return { status: res.status, data: res.data };
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestPREV" });
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

describe("PREVIEW: strukturierte Vorschau statt generischer Fehlermeldung (Task #1881)", () => {
  let funkeId: number;

  beforeAll(async () => {
    // 1 kundensignierter+abgerechneter Termin + 2 nur employee_signed.
    funkeId = await createPflegekasseCustomer();
    const first = await createApptInMonth(funkeId, 30, "billed");
    await documentAppointment(first.id, first.time, 30, "billed");
    const srSigned = await createServiceRecord(funkeId);
    await signServiceRecord(srSigned, "employee");
    await signServiceRecord(srSigned, "customer");
    const ga = await generateAll();
    expect(resultFor(ga, funkeId)?.status).toBe("created");

    for (const n of [1, 2]) {
      const appt = await createApptInMonth(funkeId, 30, `emp-${n}`);
      await documentAppointment(appt.id, appt.time, 30, `emp-${n}`);
    }
    const srEmployee = await createServiceRecord(funkeId);
    await signServiceRecord(srEmployee, "employee"); // ⇒ NUR employee_signed
  });

  it("liefert 200 mit Summe 0 € statt eines generischen badRequest", async () => {
    const { status, data } = await previewFor(funkeId);
    expect(status).toBe(200);
    expect(data.coveredAppointments).toBe(0);
    expect(data.totalCents).toBe(0);
  });

  it("erklärt termin-genau BEIDE Gründe (bereits abgerechnet + Kundenunterschrift fehlt)", async () => {
    const { data } = await previewFor(funkeId);
    const reasons = data.excludedAppointments.map((e) => e.reason);
    expect(reasons).toContain("already_billed");
    expect(reasons).toContain("customer_signature_required");
    // Genau 1 bereits abgerechnet + 2 warten auf Kundenunterschrift.
    expect(reasons.filter((r) => r === "already_billed").length).toBe(1);
    expect(reasons.filter((r) => r === "customer_signature_required").length).toBe(2);
    expect(data.alreadyBilledAppointments).toBe(1);
  });
});
