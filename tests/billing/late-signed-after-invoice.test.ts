import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1790 — Spät signierte Nachzügler-Termine tauchen wieder als offener
 * Abrechnungsschritt auf.
 *
 * Regressions-Sicherung: Wenn ein Monat bereits eine Rechnung hat und DANACH
 * ein WEITERER Termin desselben Monats dokumentiert + signiert wird, muss der
 * Kunde OHNE Datumsbereich
 *   1. wieder in `GET /api/billing/eligible-customers` erscheinen, und
 *   2. in `POST /api/billing/generate-all` eine zweite Rechnung erhalten
 *      (nicht mehr fälschlich als „Bereits abgerechnet" übersprungen werden).
 *
 * Der frühere kunde-grobe „hat irgendeine aktive Rechnung im Monat →
 * ausschließen/skip"-Filter machte solche Nachzügler unsichtbar. Beide Pfade
 * teilen jetzt DIE EINE termin-genaue SSoT
 * (`getUnbilledSignedAppointmentFactsByCustomer`).
 *
 * ISOLATION: Selbstzahler-Kunde (kein Budget-Split, genau eine Rechnung pro
 * Lauf), es wird IMMER nur der eigene Kunde per `customerId` geprüft — nie
 * globale Summen. Vollständig vergangener Vormonat (innerhalb der
 * 3-Monats-Vergangenheits-Grenze für die Termin-Anlage).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
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
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1;
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();

/** Legt einen Kundentermin auf einem freien Werktag des Abrechnungsmonats an. */
async function createAppt(
  customerId: number,
  durationMinutes: number,
  dayMin: number,
  dayMax: number,
  tag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let day = dayMin; day <= Math.min(dayMax, LAST_DAY); day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `LSA-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
    }
  }
  throw new Error(`createAppt(${tag}): kein freier Werktag-Slot in Tagen ${dayMin}-${dayMax}`);
}

async function documentAppointment(appointmentId: number, startTime: string, actualMinutes: number, details: string): Promise<void> {
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

/** Erstellt + signiert (Mitarbeiter + Kunde) einen Sammel-Leistungsnachweis für den Monat. Auto-Auswahl der noch nicht abgedeckten dokumentierten Termine. */
async function createAndSignServiceRecord(customerId: number): Promise<number> {
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
  for (const signerType of ["employee", "customer"] as const) {
    const signRes = await apiPost<any>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (signRes.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${signRes.status} ${JSON.stringify(signRes.data)}`);
    }
  }
  return srId;
}

async function createSelbstzahlerCustomer(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "LSA",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `lsa-${tag}-${uniqueId()}@test.local`,
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
        nachname: "LSA",
        mobilnummer: "+4917600000010",
      },
    ],
  });
  if (res.status !== 201) {
    throw new Error(`createSelbstzahlerCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
  return id;
}

async function eligibleContains(customerId: number): Promise<boolean> {
  const res = await apiGet<any[]>(`/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`);
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.some((c: any) => c.id === customerId);
}

async function generateAll(): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate-all", { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR });
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function listInvoices(customerId: number): Promise<any[]> {
  const res = await apiGet<any[]>(`/api/billing?customerId=${customerId}&year=${BILLING_YEAR}&month=${BILLING_MONTH}`);
  if (res.status !== 200) {
    throw new Error(`listInvoices(${customerId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
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

  const emp = await createTestEmployee({ nachnamePrefix: "TestLSA" });
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

describe("LSA: Spät signierte Nachzügler-Termine erscheinen erneut als offener Abrechnungsschritt", () => {
  let customerId: number;
  let firstApptId: number;
  let lateApptId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("late");

    // Termin 1: dokumentieren, LN erstellen+signieren, abrechnen.
    const first = await createAppt(customerId, 30, 1, 10, "first");
    firstApptId = first.id;
    await documentAppointment(first.id, first.time, 30, "late-first");
    await createAndSignServiceRecord(customerId);
    const ga1 = await generateAll();
    expect(resultFor(ga1, customerId)?.status).toBe("created");
  });

  it("LSA-1 — nach der ersten Rechnung, aber vor dem Nachzügler ist der Kunde NICHT mehr berechtigt", async () => {
    expect(await eligibleContains(customerId)).toBe(false);
    const all = await listInvoices(customerId);
    expect(all.filter((inv) => inv.status !== "storniert").length).toBe(1);
  });

  it("LSA-2 — ein danach dokumentierter + signierter Nachzügler-Termin macht den Kunden wieder berechtigt", async () => {
    const late = await createAppt(customerId, 30, 11, LAST_DAY, "late");
    lateApptId = late.id;
    await documentAppointment(late.id, late.time, 30, "late-late");
    await createAndSignServiceRecord(customerId);

    expect(await eligibleContains(customerId)).toBe(true);
  });

  it("LSA-3 — generate-all erzeugt für den Nachzügler eine zweite Rechnung (kein Bereits-abgerechnet-Skip)", async () => {
    const ga2 = await generateAll();
    const r = resultFor(ga2, customerId);
    expect(r?.status).toBe("created");

    const all = (await listInvoices(customerId)).filter((inv) => inv.status !== "storniert");
    expect(all.length).toBe(2);

    // Nach dem zweiten Lauf sind alle Termine abgerechnet → nicht mehr berechtigt.
    expect(await eligibleContains(customerId)).toBe(false);

    // Beide Termine sind über die zwei Rechnungen abgedeckt.
    expect(firstApptId).toBeGreaterThan(0);
    expect(lateApptId).toBeGreaterThan(0);
  });
});
