import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1878 — „Wartende-Kundenunterschrift"-Kunden bleiben in der Erstellen-Liste sichtbar.
 *
 * Regressions-Sicherung für den Fall „Bernd Funke": Ein Pflegekassen-Kunde mit
 *   • EINEM Termin unter einem kundensignierten (`completed`) Leistungsnachweis,
 *     der bereits abgerechnet ist, UND
 *   • MEHREREN weiteren dokumentierten Terminen unter einem NUR mitarbeiter-
 *     signierten (`employee_signed`) LN (bei Pflegekasse NICHT abrechenbar)
 * darf NICHT still aus `GET /api/billing/eligible-customers` verschwinden. Er
 * muss sichtbar bleiben und über die geteilte SSoT (`isAwaitingCustomerSignature`)
 * als „Wartet auf Kundenunterschrift" erkennbar sein.
 *
 * Gegenprobe:
 *   • Ein Pflegekassen-Kunde, dessen JEDER dokumentierte Termin abrechenbar-
 *     signiert UND abgerechnet ist, fällt weiterhin aus der Liste (kein Regress
 *     zu #1790/#1873).
 *   • Ein Selbstzahler mit nur `employee_signed` LN bleibt abrechenbar (eligible).
 *
 * ISOLATION: Immer nur der eigene Kunde per `customerId`, nie globale Summen.
 * DATUM: vollständig vergangener Vormonat (innerhalb der 3-Monats-Grenze).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isAwaitingCustomerSignature,
  isMonthFullyBilledAndSigned,
} from "@shared/domain/billing-eligibility";
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
        notes: `FUNKE-${tag}-${uniqueId()}`,
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

/** Sammel-LN erstellen; auto-selektiert noch nicht abgedeckte dokumentierte Termine. */
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

async function createSelbstzahlerCustomer(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "FUNKE",
    nachname: `Privat-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `funke-privat-${uniqueId()}@test.local`,
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
        nachname: "FUNKE",
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
    vorname: "FUNKE",
    nachname: `Kasse-${uniqueId()}`,
    geburtsdatum: "1941-03-22",
    email: `funke-kasse-${uniqueId()}@test.local`,
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

  // §45b-Topf finanzieren, damit die Termine dokumentiert/gebucht werden können.
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

type EligibleRow = {
  id: number;
  billingType: string;
  completedAppointments: number;
  coveredAppointments: number;
  signedAppointmentCount: number;
  unbilledAppointmentCount: number;
  eligibility?: { status: "eligible" | "blocked"; reason: string | null };
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

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestFUNKE" });
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

describe("FUNKE: Wartende-Kundenunterschrift-Kunden bleiben sichtbar (Task #1878)", () => {
  let funkeId: number;
  let fullyBilledId: number;
  let selbstzahlerId: number;

  beforeAll(async () => {
    // ── Funke: 1 kundensignierter+abgerechneter Termin + 3 nur employee_signed. ──
    funkeId = await createPflegekasseCustomer();
    const first = await createApptInMonth(funkeId, 30, "funke-billed");
    await documentAppointment(first.id, first.time, 30, "funke-billed");
    const srSigned = await createServiceRecord(funkeId); // deckt den 1. Termin ab
    await signServiceRecord(srSigned, "employee");
    await signServiceRecord(srSigned, "customer"); // ⇒ completed LN
    const ga = await generateAll();
    expect(resultFor(ga, funkeId)?.status).toBe("created"); // 1. Termin abgerechnet

    for (const n of [1, 2, 3]) {
      const appt = await createApptInMonth(funkeId, 30, `funke-emp-${n}`);
      await documentAppointment(appt.id, appt.time, 30, `funke-emp-${n}`);
    }
    const srEmployee = await createServiceRecord(funkeId); // deckt die 3 weiteren Termine ab
    await signServiceRecord(srEmployee, "employee"); // ⇒ NUR employee_signed

    // ── Gegenprobe A: Pflegekasse vollständig abgerechnet ⇒ fällt raus. ──
    fullyBilledId = await createPflegekasseCustomer();
    const fbAppt = await createApptInMonth(fullyBilledId, 30, "fully");
    await documentAppointment(fbAppt.id, fbAppt.time, 30, "fully");
    const fbSr = await createServiceRecord(fullyBilledId);
    await signServiceRecord(fbSr, "employee");
    await signServiceRecord(fbSr, "customer");
    const ga2 = await generateAll();
    expect(resultFor(ga2, fullyBilledId)?.status).toBe("created");

    // ── Gegenprobe B: Selbstzahler mit nur employee_signed LN ⇒ bleibt eligible. ──
    selbstzahlerId = await createSelbstzahlerCustomer();
    const szAppt = await createApptInMonth(selbstzahlerId, 30, "sz");
    await documentAppointment(szAppt.id, szAppt.time, 30, "sz");
    const szSr = await createServiceRecord(selbstzahlerId);
    await signServiceRecord(szSr, "employee");
  });

  it("FUNKE-1 — Funke bleibt in der Liste sichtbar (nicht mehr still entfernt)", async () => {
    const row = await eligibleRowFor(funkeId);
    expect(row, "Funke muss sichtbar bleiben").toBeDefined();
    expect(row!.billingType).toBe("pflegekasse_gesetzlich");
    // 4 dokumentiert, 1 abrechenbar-signiert+abgerechnet, keine unabgerechneten.
    expect(row!.completedAppointments).toBe(4);
    expect(row!.signedAppointmentCount).toBe(1);
    expect(row!.unbilledAppointmentCount).toBe(0);
  });

  it("FUNKE-2 — Funke wird als wartend auf Kundenunterschrift erkannt (geteilte SSoT)", async () => {
    const row = await eligibleRowFor(funkeId);
    expect(row).toBeDefined();
    expect(isAwaitingCustomerSignature(row!)).toBe(true);
    // Er ist NICHT vollständig abgerechnet ⇒ Ausschluss-Guard hält ihn sichtbar.
    expect(isMonthFullyBilledAndSigned(row!)).toBe(false);
    // Eligibilität spiegelt buildInvoiceDraft (1 Termin bereits abgerechnet).
    expect(row!.eligibility!.status).toBe("blocked");
    expect(row!.eligibility!.reason).toBe("already_billed");
  });

  it("FUNKE-3 — vollständig abgerechnete Pflegekasse fällt weiterhin aus der Liste", async () => {
    const row = await eligibleRowFor(fullyBilledId);
    expect(row, "vollständig abgerechneter Kunde darf NICHT gelistet sein").toBeUndefined();
  });

  it("FUNKE-4 — Selbstzahler mit employee_signed LN bleibt abrechenbar (kein Regress)", async () => {
    const row = await eligibleRowFor(selbstzahlerId);
    expect(row, "Selbstzahler muss gelistet sein").toBeDefined();
    expect(row!.billingType).toBe("selbstzahler");
    expect(row!.eligibility!.status).toBe("eligible");
    expect(row!.eligibility!.reason).toBeNull();
    expect(isAwaitingCustomerSignature(row!)).toBe(false);
  });
});
