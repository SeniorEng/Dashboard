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
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let testEmployeeId: number;
let hwServiceId: number;
let abServiceId: number;
const cleanupApptIds: number[] = [];

function nextWeekday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() + 1);
  else if (dow === 6) d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

async function createKundentermin(start: string, services: { serviceId: number; durationMinutes: number }[]): Promise<number> {
  for (let offset = 5; offset <= 90; offset++) {
    const date = nextWeekday(offset);
    const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: start,
      services,
      assignedEmployeeId: testEmployeeId,
    });
    if (res.status === 201) {
      cleanupApptIds.push(res.data.id);
      return res.data.id;
    }
  }
  throw new Error("Kein freier Slot gefunden");
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
  abServiceId = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "CorrSwap" });
  testEmployeeId = emp.id;

  const cust = await createTestCustomer({ nachname: `CorrSwap_${Date.now()}` });
  testCustomerId = cust.id;

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Dokumentations-Korrektur: Service-Austausch (Helga-Bug)", () => {
  it("ersetzt Hauswirtschaft durch Alltagsbegleitung beim erneuten /document nach Reopen", async () => {
    const apptId = await createKundentermin("09:00", [{ serviceId: hwServiceId, durationMinutes: 60 }]);

    // Erstdokumentation: Hauswirtschaft 60 Min
    const doc1 = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Reinigung" }],
    });
    expect(doc1.status).toBe(200);

    let svc = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    expect(svc.data).toHaveLength(1);
    expect(svc.data[0].serviceCode).toBe("hauswirtschaft");

    // Korrektur öffnen → Status zurück auf documenting
    const reopen = await apiPost<any>(`/api/appointments/${apptId}/reopen`, {});
    expect(reopen.status).toBe(200);

    // Erneut dokumentieren — diesmal Alltagsbegleitung statt Hauswirtschaft
    const doc2 = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Spaziergang" }],
    });
    expect(doc2.status).toBe(200);

    svc = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    expect(svc.data).toHaveLength(1);
    expect(svc.data[0].serviceCode).toBe("alltagsbegleitung");
    expect(svc.data[0].actualDurationMinutes).toBe(60);
    expect(svc.data[0].plannedDurationMinutes).toBe(60);
    expect(svc.data[0].details).toBe("Spaziergang");

    // durationPromised bleibt mit den Service-Zeilen konsistent
    const appt = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(appt.data.durationPromised).toBe(60);
  });

  it("erweitert um zusätzlichen Service und reduziert wieder auf einen", async () => {
    const apptId = await createKundentermin("09:00", [{ serviceId: hwServiceId, durationMinutes: 30 }]);

    const doc1 = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "HW" }],
    });
    expect(doc1.status).toBe(200);

    // Korrektur: zwei Services
    expect((await apiPost<any>(`/api/appointments/${apptId}/reopen`, {})).status).toBe(200);
    const doc2 = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [
        { serviceId: hwServiceId, actualDurationMinutes: 30, details: "HW" },
        { serviceId: abServiceId, actualDurationMinutes: 45, details: "AB" },
      ],
    });
    expect(doc2.status).toBe(200);

    let svc = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    expect(svc.data).toHaveLength(2);
    let appt = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(appt.data.durationPromised).toBe(75);

    // Korrektur: zurück auf einen Service
    expect((await apiPost<any>(`/api/appointments/${apptId}/reopen`, {})).status).toBe(200);
    const doc3 = await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 45, details: "AB only" }],
    });
    expect(doc3.status).toBe(200);

    svc = await apiGet<any[]>(`/api/appointments/${apptId}/services`);
    expect(svc.data).toHaveLength(1);
    expect(svc.data[0].serviceCode).toBe("alltagsbegleitung");
    appt = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(appt.data.durationPromised).toBe(45);
  });
});
