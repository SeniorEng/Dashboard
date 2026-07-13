import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * „Noch zu erstellen" — offene (geplante) Termine pro Kunde (Task #1743)
 *
 * `GET /api/billing/eligible-customers` liefert seit Task #1743 pro Kunde das
 * Feld `openAppointments`: die Anzahl der im gewählten Monat noch OFFENEN
 * (nicht terminalen) Termine. Das Frontend gruppiert die Karte „Noch zu
 * erstellen" danach in „Bereit zum Abrechnen" (`openAppointments === 0`) und
 * „Noch offene Termine" (`> 0`) — beide Kunden bleiben sichtbar.
 *
 * Dieser Test sichert, dass der Zähler aus DERSELBEN „offener Termin"-SSoT
 * (`FINAL_APPOINTMENT_STATUSES`) stammt wie die Monatsabschluss-Readiness:
 *   (a) ein Kunde mit ausschließlich dokumentierten Terminen → 0 offen,
 *   (b) ein Kunde mit einem zusätzlichen geplanten (undokumentierten) Termin
 *       im selben Monat → genau 1 offen.
 *
 * ISOLATION: Selbstzahler-Kunden (genau eine Rechnung, kein Budget-Split) und
 * wir prüfen IMMER nur die eigenen Kunden per `customerId` — nie globale Summen.
 *
 * DATUM: vollständig vergangener Vormonat (innerhalb der 3-Monats-Grenze für die
 * Termin-Anlage), in frühe (Tag 1–14) und späte (Tag 15–Ende) Hälfte geteilt,
 * damit zwei Termine pro Kunde garantiert auf verschiedenen Werktagen liegen.
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
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1; // 1-12
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();

async function createApptInDayRange(
  customerId: number,
  durationMinutes: number,
  dayMin: number,
  dayMax: number,
  tag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let day = dayMin; day <= Math.min(dayMax, LAST_DAY); day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue; // Wochenende überspringen
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `OPEN-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(
    `createApptInDayRange(${tag}): kein freier Werktag-Slot in Tagen ${dayMin}-${dayMax} von ${BILLING_YEAR}-${BILLING_MONTH}`,
  );
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

/** Erstellt einen Sammel-LN (deckt alle dokumentierten Termine) und signiert ihn. */
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
    vorname: "OPEN",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `open-${tag}-${uniqueId()}@test.local`,
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
        nachname: "OPEN",
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

type EligibleRow = {
  id: number;
  completedAppointments: number;
  coveredAppointments: number;
  openAppointments: number;
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

  const emp = await createTestEmployee({ nachnamePrefix: "TestOPEN" });
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

describe("OPEN: eligible-customers meldet offene (geplante) Termine pro Kunde", () => {
  let readyCustomerId: number;   // (a) nur dokumentierte Termine → 0 offen
  let withOpenCustomerId: number; // (b) zusätzlich ein geplanter Termin → 1 offen

  beforeAll(async () => {
    // (a) „Bereit zum Abrechnen": ein dokumentierter Termin, LN deckt ihn.
    readyCustomerId = await createSelbstzahlerCustomer("ready");
    const readyAppt = await createApptInDayRange(readyCustomerId, 30, 1, 14, "ready");
    await documentAppointment(readyAppt.id, readyAppt.time, 30, "ready");
    await createAndSignServiceRecord(readyCustomerId);

    // (b) „Noch offene Termine": realer Ablauf — der Kunde bekommt zuerst einen
    // dokumentierten Termin + signierten LN (macht ihn abrechnungs-berechtigt),
    // DANACH wird ein neuer Termin für denselben Monat geplant. Das ist der
    // einzige Weg, wie ein berechtigter Kunde noch offene Termine haben kann:
    // die LN-Erstellung ist blockiert, solange noch Termine undokumentiert sind.
    withOpenCustomerId = await createSelbstzahlerCustomer("withopen");
    const docAppt = await createApptInDayRange(withOpenCustomerId, 30, 1, 14, "wo-doc");
    await documentAppointment(docAppt.id, docAppt.time, 30, "wo-doc");
    await createAndSignServiceRecord(withOpenCustomerId); // deckt den dokumentierten
    await createApptInDayRange(withOpenCustomerId, 30, 15, LAST_DAY, "wo-open"); // danach: bleibt geplant
  });

  it("OPEN-1 — Kunde ohne offene Termine meldet openAppointments === 0", async () => {
    const row = await eligibleRowFor(readyCustomerId);
    expect(row).toBeDefined();
    expect(typeof row!.openAppointments).toBe("number");
    expect(row!.openAppointments).toBe(0);
  });

  it("OPEN-2 — Kunde mit einem geplanten Termin meldet openAppointments === 1", async () => {
    const row = await eligibleRowFor(withOpenCustomerId);
    expect(row).toBeDefined();
    // Der dokumentierte Termin zählt NICHT als offen, der geplante schon.
    expect(row!.completedAppointments).toBe(1);
    expect(row!.openAppointments).toBe(1);
  });
});
