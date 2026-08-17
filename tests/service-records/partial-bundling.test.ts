/**
 * Teilweises Bündeln: dokumentierte Termine sind abrechenbar, auch wenn im
 * selben Kunden-Monat noch offene Termine stehen.
 *
 * ── Der Defekt, vorher ──────────────────────────────────────────────────
 * Das Bündeln war all-or-nothing. `POST /api/service-records` warf 400, sobald
 * IRGENDEIN Termin des Kunden-Monats noch `scheduled`/`documenting` war — auch
 * für die bereits dokumentierten. Dieselbe Formel stand zusätzlich in zwei
 * Anzeige-Endpunkten (`/overview`, `/check-period`).
 *
 * Zusammen mit der Bucket-Priorität der Übersicht war die Folge härter als
 * „unbequem": ein dokumentierter, noch nicht gebündelter Termin fiel in KEINE
 * sichtbare Kategorie. Die Übersicht ordnete den Kunden nach dem ersten
 * Treffer unter „noch zu dokumentieren" ein und zeigte nur die offene Zahl —
 * die fertige Arbeit war unsichtbar UND unabrechenbar. Im laufenden Monat ist
 * dieser Mischzustand der Normalfall.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 *  1. Mischzustand: check-period meldet `canCreateRecord`, obwohl offene
 *     Termine im Monat stehen
 *  2. eine Teilmenge lässt sich tatsächlich bündeln
 *  3. der offene Termin bleibt offen und bleibt als undokumentiert gezählt —
 *     er wandert NICHT stillschweigend in den Nachweis
 *  4. ein zweiter Sammel-LN für den Rest ist möglich
 *
 * Gegenprobe gegen `main`: 1, 2 und 4 müssen dort ROT sein (400 bzw.
 * `canCreateRecord === false`). 3 ist auch dort grün — er hält fest, dass die
 * Lockerung nicht zu weit geht.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  deactivateTestEmployee,
} from "../test-utils";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Werktag im LAUFENDEN Monat — vermeidet das Monatsabschluss-Gate. */
function pastWeekday(): Date {
  const now = new Date();
  for (let i = 1; i <= 10; i++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - i);
    const dow = cand.getDay();
    if (dow !== 0 && dow !== 6 && cand.getMonth() === now.getMonth()) return cand;
  }
  return now;
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let hwServiceId: number;
let year: number;
let month: number;
let dateStr: string;
const cleanupApptIds: number[] = [];
const cleanupRecordIds: number[] = [];

let dokumentiertA: number;
let dokumentiertB: number;
let offenerTermin: number;

async function termin(time: string): Promise<number> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: auth.user.id,
    notes: `teilbuendeln-${uniqueId()}`,
  });
  if (res.status !== 201) throw new Error(`Termin ${time}: ${res.status} ${JSON.stringify(res.data)}`);
  cleanupApptIds.push(res.data.id);
  return res.data.id;
}

async function dokumentieren(id: number, time: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "teilbuendeln" }],
    performedByEmployeeId: auth.user.id,
  });
  if (res.status !== 200) throw new Error(`Doku ${id}: ${res.status} ${JSON.stringify(res.data)}`);
}

function checkPeriod() {
  return apiGet<any>(`/api/service-records/check-period?customerId=${customerId}&year=${year}&month=${month}`);
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "Teilbuendeln" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `Teilbuendeln_${uniqueId()}` });
  customerId = cust.id as number;

  const zuweisung = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: employeeId,
    backupEmployeeId2: null,
  });
  expect(zuweisung.status).toBe(200);

  const day = pastWeekday();
  year = day.getFullYear();
  month = day.getMonth() + 1;
  dateStr = ymd(day);

  // Der Mischzustand: zwei dokumentierte, einer offen — alle im selben
  // Kunden-Monat, alle bei derselben Kraft.
  dokumentiertA = await termin("07:00");
  await dokumentieren(dokumentiertA, "07:00");
  dokumentiertB = await termin("08:00");
  await dokumentieren(dokumentiertB, "08:00");
  offenerTermin = await termin("09:00");
});

afterAll(async () => {
  for (const id of cleanupRecordIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* egal */ } }
  for (const id of cleanupApptIds) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* egal */ } }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Teilweises Bündeln — offene Termine sperren die fertige Arbeit nicht", () => {
  it("1 — check-period meldet buendelbar, obwohl ein Termin offen ist", async () => {
    const res = await checkPeriod();
    expect(res.status).toBe(200);
    // Vorbedingung: der Mischzustand steht wirklich. Ohne diese Zusicherung
    // koennte der Test gruen sein, weil gar nichts offen ist.
    expect(res.data.undocumentedCount, "Vorbedingung: ein Termin muss offen sein").toBe(1);
    expect(res.data.uncoveredDocumentedCount).toBe(2);
    expect(res.data.canCreateRecord, "offener Termin darf die fertige Arbeit nicht sperren").toBe(true);
    expect(res.data.selectableAppointments.map((a: any) => a.id).sort()).toEqual(
      [dokumentiertA, dokumentiertB].sort(),
    );
  });

  it("2 — eine Teilmenge laesst sich buendeln", async () => {
    const res = await apiPost<any>("/api/service-records", {
      customerId, year, month, employeeId: auth.user.id, appointmentIds: [dokumentiertA],
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    cleanupRecordIds.push(res.data.id);

    const nachher = await checkPeriod();
    expect(nachher.data.uncoveredDocumentedCount, "nur noch der zweite ist offen").toBe(1);
    expect(nachher.data.selectableAppointments.map((a: any) => a.id)).toEqual([dokumentiertB]);
  });

  it("3 — der offene Termin bleibt offen und wandert NICHT in den Nachweis", async () => {
    const appt = await apiGet<any>(`/api/appointments/${offenerTermin}`);
    expect(appt.data.status).toBe("scheduled");

    const res = await checkPeriod();
    expect(res.data.undocumentedCount, "er zaehlt weiterhin als undokumentiert").toBe(1);
    // Und er ist in keiner Auswahl: die Auswahl arbeitet ausschliesslich auf
    // dokumentierten, noch nicht abgedeckten Terminen.
    expect(res.data.selectableAppointments.map((a: any) => a.id)).not.toContain(offenerTermin);
  });

  it("4 — ein zweiter Sammel-LN fuer den Rest ist moeglich", async () => {
    const res = await apiPost<any>("/api/service-records", { customerId, year, month, employeeId: auth.user.id });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    cleanupRecordIds.push(res.data.id);

    const nachher = await checkPeriod();
    expect(nachher.data.uncoveredDocumentedCount).toBe(0);
    expect(nachher.data.canCreateRecord, "nichts mehr zu buendeln").toBe(false);
    // Der offene Termin steht immer noch offen — zwei Nachweise spaeter.
    expect(nachher.data.undocumentedCount).toBe(1);
  });
});
