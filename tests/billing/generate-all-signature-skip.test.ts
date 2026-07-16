import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Massenerstellung — signatur-blockierte Kunden als „übersprungen" (Task #1779)
 *
 * Pflegekasse-Kunden, deren Leistungsnachweis NUR mit der Mitarbeiter-Unterschrift
 * (`employee_signed`) versehen ist, warten noch auf die Kundenunterschrift. Sie
 * haben keine offenen (geplanten) Termine mehr, laufen aber im Signatur-Gate von
 * `generateInvoiceCore` in einen 400 — vor #1779 erschienen sie dadurch im
 * Ergebnis-Dialog rot als „Fehler". Dieser Test sichert ab, dass sie stattdessen
 * als „übersprungen" mit der Meldung „Wartet auf Kundenunterschrift" gemeldet
 * werden (nicht als Fehler), Eligibilität aus DERSELBEN SSoT
 * (`classifyBillingEligibility`) wie `/eligible-customers`.
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

const SIG_MSG = "Wartet auf Kundenunterschrift";

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
        notes: `SIGSKIP-${tag}-${uniqueId()}`,
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

async function createPflegekasseCustomer(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "SIGSKIP",
    nachname: `Kasse-${uniqueId()}`,
    geburtsdatum: "1941-03-22",
    email: `sigskip-kasse-${uniqueId()}@test.local`,
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

type GenResult = { customerId: number; status: string; message?: string; invoiceCount?: number };

async function generateAll(readyOnly?: boolean): Promise<GenResult[]> {
  const body: Record<string, any> = { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR };
  if (readyOnly !== undefined) body.readyOnly = readyOnly;
  const res = await apiPost<any>("/api/billing/generate-all", body);
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return (res.data.results ?? []) as GenResult[];
}

function resultFor(results: GenResult[], customerId: number): GenResult | undefined {
  return results.find((r) => r.customerId === customerId);
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestSIGSKIP" });
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

describe("SIGSKIP: generate-all meldet signatur-blockierte Kunden als übersprungen (Task #1779)", () => {
  let kasseCustomerId: number;

  beforeAll(async () => {
    // Pflegekasse: dokumentierter Termin + LN NUR mit Mitarbeiter-Unterschrift,
    // KEINE offenen Termine mehr → wartet nur noch auf die Kundenunterschrift.
    kasseCustomerId = await createPflegekasseCustomer();
    const kasseAppt = await createApptInMonth(kasseCustomerId, 30, "kasse");
    await documentAppointment(kasseAppt.id, kasseAppt.time, 30, "kasse");
    await createEmployeeSignedServiceRecord(kasseCustomerId);
  });

  it("SIGSKIP-1 — readyOnly=true: signatur-blockierter Kunde wird übersprungen, nicht als Fehler", async () => {
    const results = await generateAll(true);
    const kasse = resultFor(results, kasseCustomerId);
    expect(kasse, "Pflegekasse-Kunde muss im Ergebnis erscheinen").toBeDefined();
    expect(kasse!.status).toBe("skipped");
    expect(kasse!.message).toBe(SIG_MSG);
  });

  it("SIGSKIP-2 — auch ohne readyOnly wird der Kunde übersprungen (kein 400-Fehler)", async () => {
    const results = await generateAll();
    const kasse = resultFor(results, kasseCustomerId);
    expect(kasse, "Pflegekasse-Kunde muss im Ergebnis erscheinen").toBeDefined();
    expect(kasse!.status).toBe("skipped");
    expect(kasse!.message).toBe(SIG_MSG);
    expect(kasse!.status).not.toBe("error");
  });
});
