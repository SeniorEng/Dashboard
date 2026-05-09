import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "./test-utils";
import { addMinutesToTimeHHMMSS as addMinutesToHHMMSS } from "@shared/utils/datetime";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let testEmployeeId: number;
let hwServiceId: number;
let abServiceId: number;
const createdIds: number[] = [];

function nextWeekday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() + 1);
  else if (dow === 6) d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

async function createKundentermin(
  date: string,
  start: string,
  services: { serviceId: number; durationMinutes: number }[],
): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId: testCustomerId,
    date,
    scheduledStart: start,
    services,
    assignedEmployeeId: testEmployeeId,
  });
  if (res.status !== 201) {
    throw new Error(`Termin-Anlage fehlgeschlagen: ${res.status} ${JSON.stringify(res.data)}`);
  }
  createdIds.push(res.data.id);
  return res.data.id;
}

async function findFreeSlot(
  services: { serviceId: number; durationMinutes: number }[],
  times: string[] = ["07:00", "07:30", "08:00", "20:00", "20:30"],
): Promise<number> {
  for (let offset = 5; offset <= 90; offset++) {
    const date = nextWeekday(offset);
    for (const start of times) {
      try {
        return await createKundentermin(date, start, services);
      } catch {
        // weiter suchen
      }
    }
  }
  throw new Error("Kein freier Slot gefunden");
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
  abServiceId = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "DurSync" });
  testEmployeeId = emp.id;

  const cust = await createTestCustomer({ nachname: `DurSync_${Date.now()}` });
  testCustomerId = cust.id;

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
});

afterAll(async () => {
  for (const id of createdIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Termin-Dauer ↔ Service-Zeilen Konsistenz (Marcel-Bug)", () => {
  it("PATCH durationPromised allein zieht Service-Zeile auf neue Dauer nach", async () => {
    const apptId = await findFreeSlot([{ serviceId: abServiceId, durationMinutes: 30 }]);

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      durationPromised: 60,
    });
    expect(patchRes.status).toBe(200);

    const svcRes = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    expect(svcRes.status).toBe(200);
    const sum = svcRes.data.reduce((s, sv: any) => s + (sv.plannedDurationMinutes || 0), 0);
    expect(sum).toBe(60);
    expect(svcRes.data).toHaveLength(1);
    expect(svcRes.data[0].plannedDurationMinutes).toBe(60);
  });

  it("PATCH durationPromised verteilt anteilig auf mehrere Service-Zeilen", async () => {
    const apptId = await findFreeSlot([
      { serviceId: hwServiceId, durationMinutes: 30 },
      { serviceId: abServiceId, durationMinutes: 30 },
    ]);

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      durationPromised: 90,
    });
    expect(patchRes.status).toBe(200);

    const svcRes = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    const sum = svcRes.data.reduce((s, sv: any) => s + (sv.plannedDurationMinutes || 0), 0);
    expect(sum).toBe(90);
  });

  it("PATCH services allein berechnet durationPromised aus der Summe neu", async () => {
    const apptId = await findFreeSlot([{ serviceId: hwServiceId, durationMinutes: 30 }]);

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      services: [
        { serviceId: hwServiceId, plannedDurationMinutes: 45 },
        { serviceId: abServiceId, plannedDurationMinutes: 30 },
      ],
    });
    expect(patchRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(fetchRes.data.durationPromised).toBe(75);

    const svcRes = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    const sum = svcRes.data.reduce((s, sv: any) => s + (sv.plannedDurationMinutes || 0), 0);
    expect(sum).toBe(75);
  });

  it("PATCH services allein zieht scheduledEnd automatisch nach (scheduledStart + neue Dauer)", async () => {
    const apptId = await findFreeSlot([{ serviceId: hwServiceId, durationMinutes: 30 }]);

    const beforeRes = await apiGet<any>(`/api/appointments/${apptId}`);
    const start: string = beforeRes.data.scheduledStart;
    expect(beforeRes.data.scheduledEnd).toBe(addMinutesToHHMMSS(start, 30));

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      services: [
        { serviceId: hwServiceId, plannedDurationMinutes: 45 },
        { serviceId: abServiceId, plannedDurationMinutes: 30 },
      ],
    });
    expect(patchRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(fetchRes.data.durationPromised).toBe(75);
    expect(fetchRes.data.scheduledEnd).toBe(addMinutesToHHMMSS(start, 75));
  });

  it("PATCH durationPromised allein zieht scheduledEnd automatisch nach (scheduledStart + neue Dauer)", async () => {
    const apptId = await findFreeSlot([{ serviceId: hwServiceId, durationMinutes: 30 }]);

    const beforeRes = await apiGet<any>(`/api/appointments/${apptId}`);
    const start: string = beforeRes.data.scheduledStart;
    expect(beforeRes.data.scheduledEnd).toBe(addMinutesToHHMMSS(start, 30));

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      durationPromised: 75,
    });
    expect(patchRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(fetchRes.data.durationPromised).toBe(75);
    expect(fetchRes.data.scheduledEnd).toBe(addMinutesToHHMMSS(start, 75));
  });

  it("PATCH services allein auf in-progress Termin wird mit 403 abgelehnt (kein Scheduling-Bypass)", async () => {
    const apptId = await findFreeSlot(
      [{ serviceId: hwServiceId, durationMinutes: 30 }],
      ["05:00", "05:30", "06:00"],
    );
    const startRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      status: "in-progress",
      actualStart: "05:00",
    });
    expect(startRes.status).toBe(200);

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      services: [{ serviceId: hwServiceId, plannedDurationMinutes: 60 }],
    });
    expect(patchRes.status).toBe(403);
  });

  it("PATCH mit widersprüchlicher Dauer + Services wird mit 400 abgelehnt", async () => {
    const apptId = await findFreeSlot([{ serviceId: hwServiceId, durationMinutes: 30 }]);

    const patchRes = await apiPatch<any>(`/api/appointments/${apptId}`, {
      durationPromised: 60,
      services: [{ serviceId: hwServiceId, plannedDurationMinutes: 30 }],
    });
    expect(patchRes.status).toBe(400);

    // sicherstellen: keine Änderung, alte 30-Minuten-Zeile bleibt erhalten
    const fetchRes = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(fetchRes.data.durationPromised).toBe(30);
    const svcRes = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    const sum = svcRes.data.reduce((s, sv: any) => s + (sv.plannedDurationMinutes || 0), 0);
    expect(sum).toBe(30);
  });
});
