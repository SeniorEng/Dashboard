/**
 * Phase-2 Bug-Tests — K8: Termin-Lock nach LN-Sign
 *
 * Heute liefert PATCH /api/appointments/:id für gesperrte Termine pauschal
 * 403 (APPOINTMENT_LOCKED). Erwartet wird in Phase-2:
 *   - 409 Conflict für geschützte Felder, die Abrechnungs-Konsistenz brechen
 *     (scheduledStart, actualStart, services[].actualDurationMinutes,
 *     travelKilometers, customerKilometers, customerId, assignedEmployeeId).
 *   - Whitelist `notes` darf weiterhin geändert werden (200).
 *
 * Bis der Fix landet, sind die 409-Erwartungen mit `it.fails` markiert. Der
 * Whitelist-Case wird gegen einen UNGESPERRTEN Termin geprüft (regulärer
 * `it`), damit die Baseline „notes-PATCH funktioniert" auch heute grün ist.
 *
 * Mapping: Test → K-Punkt → Fix-Status
 *   K8 → it.fails (heute 403 statt 409, kippt nach Lock-Routing-Fix)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
  createTestCustomer,
  cleanupCustomer,
  apiGet,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let testEmployeeId: number;
let altEmployeeId: number;
let customerLockedId: number;
let customerNotesId: number;
let customerAltId: number;
let lockedApptId: number;
let unlockedApptId: number;

const cleanupApptIds: number[] = [];
const cleanupCustomerIds: number[] = [];
const cleanupSrIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

async function findFreeSlotAndCreate(customerId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let offset = 1; offset <= 60; offset++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - offset);
    shiftToWeekday(cand);
    const dateStr = ymd(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `LK8-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`findFreeSlotAndCreate(${tag}): kein freier Slot gefunden`);
}

async function documentAppointment(id: number, time: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "K8-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function createAndSignServiceRecord(customerId: number, year: number, month: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) throw new Error(`SR create failed: ${res.status} ${JSON.stringify(res.data)}`);
  cleanupSrIds.push(res.data.id);
  for (const signerType of ["employee", "customer"] as const) {
    const sigRes = await apiPost<any>(`/api/service-records/${res.data.id}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (sigRes.status !== 200) throw new Error(`SR sign(${signerType}) failed: ${sigRes.status} ${JSON.stringify(sigRes.data)}`);
  }
  return res.data.id;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "K8Lock" });
  testEmployeeId = emp.id;
  const altEmp = await createTestEmployee({ nachnamePrefix: "K8Alt" });
  altEmployeeId = altEmp.id;

  const cust1 = await createTestCustomer({ nachname: `Privat-K8Locked-${uniqueId()}` });
  customerLockedId = cust1.id as number;
  cleanupCustomerIds.push(customerLockedId);

  const cust2 = await createTestCustomer({ nachname: `Privat-K8Notes-${uniqueId()}` });
  customerNotesId = cust2.id as number;
  cleanupCustomerIds.push(customerNotesId);

  const cust3 = await createTestCustomer({ nachname: `Privat-K8Alt-${uniqueId()}` });
  customerAltId = cust3.id as number;
  cleanupCustomerIds.push(customerAltId);

  // Locked appointment: dokumentiert + LN beidseitig signiert
  const slot = await findFreeSlotAndCreate(customerLockedId, "L");
  await documentAppointment(slot.id, slot.time);
  const d = new Date(slot.date);
  await createAndSignServiceRecord(customerLockedId, d.getFullYear(), d.getMonth() + 1);
  lockedApptId = slot.id;

  // Unlocked appointment für notes-Whitelist (kein LN signiert)
  const slot2 = await findFreeSlotAndCreate(customerNotesId, "N");
  unlockedApptId = slot2.id;
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupCustomerIds) {
    await cleanupCustomer(id);
  }
  await deactivateTestEmployee(testEmployeeId);
  await deactivateTestEmployee(altEmployeeId);
});

describe("K8 — Termin-Lock nach LN-Sign liefert 409 statt 403 für geschützte Felder", () => {
  it("K8.1 — PATCH scheduledStart auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { scheduledStart: "10:00" });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.2 — PATCH actualStart auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { actualStart: "10:00" });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.3 — PATCH services[].actualDurationMinutes auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, {
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 45 }],
    });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.4 — PATCH travelKilometers auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { travelKilometers: 5 });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.5 — PATCH customerKilometers auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { customerKilometers: 3 });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.6 — PATCH customerId auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { customerId: customerAltId });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  it("K8.7 — PATCH assignedEmployeeId auf gesperrtem Termin liefert 409", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lockedApptId}`, { assignedEmployeeId: altEmployeeId });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
  });

  // Whitelist-Baseline: notes-PATCH funktioniert auf nicht gesperrtem Termin
  // bereits heute. Nach dem K8-Fix soll notes auch auf gesperrten Terminen
  // weiterhin funktionieren (eigener Test, sobald Fix landet).
  it("K8.8 — PATCH notes auf nicht gesperrtem Termin liefert 200 (Whitelist-Baseline)", async () => {
    const res = await apiPatch<any>(`/api/appointments/${unlockedApptId}`, { notes: `K8-notes-${uniqueId()}` });
    expect(res.status, `got ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
  });
});
