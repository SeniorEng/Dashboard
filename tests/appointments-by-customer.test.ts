import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiGetAs,
  getAuthCookie,
  loginAs,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
} from "./test-utils";

/**
 * Task #1145 — Absicherung des Admin-only Endpoints
 * GET /api/appointments/by-customer (eingeführt in Task #1144).
 *
 * Verifiziert:
 *  - Nicht-Admins (Mitarbeiter) erhalten 403.
 *  - Admins erhalten alle NICHT-stornierten Termine des Kunden
 *    (Vergangenheit + Zukunft), sortiert nach Datum, dann Startzeit.
 *  - Stornierte UND (soft-)gelöschte Termine sind ausgeschlossen.
 *  - Ungültige/fehlende customerId → 400.
 */

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let employeeAuth: Awaited<ReturnType<typeof loginAs>>;
let employeeId: number;
let customerId: number;
let hwServiceId: number;

let pastEarlyId: number;
let pastLateId: number;
let futureId: number;
let cancelledId: number;
let deletedId: number;

let pastDate: string;
let futureDate: string;
let cancelledDate: string;
let deletedDate: string;

/** Liefert ein Werktags-Datum, relativ zu heute um `offsetDays` verschoben. */
function weekdayDate(offsetDays: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const step = offsetDays < 0 ? -1 : 1;
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + step);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function createAppointment(dateStr: string, time: string): Promise<number> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: (await getAuthCookie()).user.id,
  });
  if (res.status !== 201) {
    throw new Error(`createAppointment failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.id as number;
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "ByCustomerMA" });
  employeeId = emp.id;
  employeeAuth = await loginAs(emp.email, emp.password);

  const cust = await createTestCustomer({ nachname: `ByCustomer_${Date.now()}` });
  customerId = cust.id as number;

  pastDate = weekdayDate(-12);
  futureDate = weekdayDate(14);
  cancelledDate = weekdayDate(21);
  deletedDate = weekdayDate(28);

  // Zwei Termine am selben (vergangenen) Tag mit unterschiedlichen Startzeiten,
  // bewusst in „falscher" Reihenfolge angelegt, um die Sortierung zu prüfen.
  pastLateId = await createAppointment(pastDate, "11:00");
  pastEarlyId = await createAppointment(pastDate, "08:00");
  futureId = await createAppointment(futureDate, "09:00");

  // Stornierter Termin: anlegen, dann auf Status "cancelled" patchen.
  cancelledId = await createAppointment(cancelledDate, "09:00");
  const cancelRes = await apiPatch(`/api/appointments/${cancelledId}`, { status: "cancelled" });
  expect(cancelRes.status).toBe(200);

  // Gelöschter Termin: anlegen, dann soft-deleten.
  deletedId = await createAppointment(deletedDate, "09:00");
  const delRes = await apiDelete(`/api/appointments/${deletedId}`);
  expect(delRes.status).toBe(200);
});

afterAll(async () => {
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("GET /api/appointments/by-customer — Admin-only & korrekt", () => {
  it("verweigert Nicht-Admins (Mitarbeiter) mit 403", async () => {
    const res = await apiGetAs<any>(employeeAuth, `/api/appointments/by-customer?customerId=${customerId}`);
    expect(res.status).toBe(403);
  });

  it("liefert Admins die nicht-stornierten Termine (Vergangenheit + Zukunft), sortiert nach Datum dann Startzeit", async () => {
    const res = await apiGet<any[]>(`/api/appointments/by-customer?customerId=${customerId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);

    // Alle zurückgegebenen Termine gehören dem angefragten Kunden.
    for (const appt of res.data) {
      expect(appt.customerId).toBe(customerId);
    }

    const returnedIds = res.data.map((a) => a.id);
    // Vergangenheit + Zukunft sind enthalten.
    expect(returnedIds).toContain(pastEarlyId);
    expect(returnedIds).toContain(pastLateId);
    expect(returnedIds).toContain(futureId);
    // Storniert und gelöscht sind ausgeschlossen.
    expect(returnedIds).not.toContain(cancelledId);
    expect(returnedIds).not.toContain(deletedId);

    // Sortierung: Datum aufsteigend, bei gleichem Datum Startzeit aufsteigend.
    const ours = res.data.filter((a) =>
      [pastEarlyId, pastLateId, futureId].includes(a.id),
    );
    expect(ours.map((a) => a.id)).toEqual([pastEarlyId, pastLateId, futureId]);

    // Globale Sortier-Invariante über die gesamte Liste.
    for (let i = 1; i < res.data.length; i++) {
      const prev = res.data[i - 1];
      const cur = res.data[i];
      const prevKey = `${prev.date} ${prev.scheduledStart ?? ""}`;
      const curKey = `${cur.date} ${cur.scheduledStart ?? ""}`;
      expect(prevKey <= curKey).toBe(true);
    }
  });

  it("antwortet mit 400 bei fehlender customerId", async () => {
    const res = await apiGet<any>(`/api/appointments/by-customer`);
    expect(res.status).toBe(400);
  });

  it("antwortet mit 400 bei nicht-numerischer customerId", async () => {
    const res = await apiGet<any>(`/api/appointments/by-customer?customerId=abc`);
    expect(res.status).toBe(400);
  });

  it("antwortet mit 400 bei customerId <= 0", async () => {
    const zero = await apiGet<any>(`/api/appointments/by-customer?customerId=0`);
    expect(zero.status).toBe(400);
    const negative = await apiGet<any>(`/api/appointments/by-customer?customerId=-5`);
    expect(negative.status).toBe(400);
  });
});
