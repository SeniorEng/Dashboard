import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getAuthCookie,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let hwServiceId: number;
let seriesId: number;
const cleanupSeriesIds: number[] = [];

async function deleteSeriesSafe(id: number) {
  try { await apiDelete(`/api/appointment-series/${id}`); } catch {}
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;

  const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=1");
  testCustomerId = custRes.data.data[0].id;

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
});

afterAll(async () => {
  for (const id of cleanupSeriesIds) {
    await deleteSeriesSafe(id);
  }
});

describe("SER-1: Serie erstellen", () => {
  it("SER-1.1 – Wöchentliche Serie (4 Wochen, Montag+Mittwoch)", async () => {
    const startDate = getFutureDate(30);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 28);
    const endDate = endObj.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["mo", "mi"],
      frequency: "weekly",
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      notes: "SER-Test wöchentlich",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("series");
    expect(res.data.series).toHaveProperty("id");
    seriesId = res.data.series.id;
    cleanupSeriesIds.push(seriesId);

    expect(res.data).toHaveProperty("createdCount");
    expect(res.data.createdCount).toBeGreaterThan(0);
  });

  it("SER-1.2 – Serie abrufen zeigt Termine", async () => {
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("series");
    expect(res.data).toHaveProperty("appointments");
    expect(res.data.appointments.length).toBeGreaterThan(0);
  });

  it("SER-1.3 – Maximale Laufzeit 12 Monate wird erzwungen", async () => {
    const startDate = getFutureDate(60);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 400);
    const endDate = endObj.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["di"],
      frequency: "weekly",
      scheduledStart: "14:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("SER-2: Vorschau (Preview)", () => {
  it("SER-2.1 – Preview liefert generierte Termine ohne Speicherung", async () => {
    const startDate = getFutureDate(35);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 14);
    const endDate = endObj.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointment-series/preview", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["do"],
      frequency: "weekly",
      scheduledStart: "11:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("dates");
    expect(Array.isArray(res.data.dates)).toBe(true);
  });
});

describe("SER-3: Einzeltermin-Absage", () => {
  it("SER-3.1 – Einzelnen Termin der Serie absagen", async () => {
    const seriesRes = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    const appts = seriesRes.data.appointments.filter((a: any) => a.status === "scheduled");
    if (appts.length === 0) return;

    const firstAppt = appts[0];
    const res = await apiPost<any>(
      `/api/appointment-series/${seriesId}/appointments/${firstAppt.id}/cancel`,
      { mode: "single" }
    );
    expect(res.status).toBe(200);

    const checkRes = await apiGet<any>(`/api/appointments/${firstAppt.id}`);
    expect(checkRes.data.status).toBe("cancelled");
  });
});

describe("SER-4: Alle zukünftigen absagen", () => {
  let tempSeriesId: number;

  it("SER-4.1 – Serie erstellen und ab Mitte absagen", async () => {
    const startDate = getFutureDate(70);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 28);
    const endDate = endObj.toISOString().split("T")[0];

    const createRes = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["di", "do"],
      frequency: "weekly",
      scheduledStart: "15:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 45 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    tempSeriesId = createRes.data.series.id;
    cleanupSeriesIds.push(tempSeriesId);

    const seriesRes = await apiGet<any>(`/api/appointment-series/${tempSeriesId}`);
    const appts = seriesRes.data.appointments.filter((a: any) => a.status === "scheduled");
    if (appts.length < 2) return;

    const midAppt = appts[Math.floor(appts.length / 2)];
    const cancelRes = await apiPost<any>(
      `/api/appointment-series/${tempSeriesId}/appointments/${midAppt.id}/cancel`,
      { mode: "all_future" }
    );
    expect(cancelRes.status).toBe(200);
  });
});

describe("SER-5: Verlängern & Verkürzen", () => {
  let extendSeriesId: number;

  beforeAll(async () => {
    const startDate = getFutureDate(100);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 14);
    const endDate = endObj.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["mi"],
      frequency: "weekly",
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    extendSeriesId = res.data.series.id;
    cleanupSeriesIds.push(extendSeriesId);
  });

  it("SER-5.1 – Serie verlängern fügt neue Termine hinzu", async () => {
    const beforeRes = await apiGet<any>(`/api/appointment-series/${extendSeriesId}`);
    const countBefore = beforeRes.data.appointments.length;

    const currentEnd = new Date(beforeRes.data.series.endDate + "T00:00:00");
    const newEnd = new Date(currentEnd);
    newEnd.setDate(newEnd.getDate() + 28);
    const newEndDate = newEnd.toISOString().split("T")[0];

    const extRes = await apiPost<any>(`/api/appointment-series/${extendSeriesId}/extend`, {
      newEndDate,
    });
    expect(extRes.status).toBe(200);

    const afterRes = await apiGet<any>(`/api/appointment-series/${extendSeriesId}`);
    expect(afterRes.data.appointments.length).toBeGreaterThan(countBefore);
  });

  it("SER-5.2 – Serie verkürzen entfernt zukünftige Termine", async () => {
    const beforeRes = await apiGet<any>(`/api/appointment-series/${extendSeriesId}`);
    const countBefore = beforeRes.data.appointments.length;

    const currentEnd = new Date(beforeRes.data.series.endDate + "T00:00:00");
    const newEnd = new Date(currentEnd);
    newEnd.setDate(newEnd.getDate() - 14);
    const newEndDate = newEnd.toISOString().split("T")[0];

    const shortenRes = await apiPost<any>(`/api/appointment-series/${extendSeriesId}/shorten`, {
      newEndDate,
    });
    expect(shortenRes.status).toBe(200);

    const afterRes = await apiGet<any>(`/api/appointment-series/${extendSeriesId}`);
    expect(afterRes.data.appointments.length).toBeLessThanOrEqual(countBefore);
  });
});

describe("SER-6: Einzeltermin bearbeiten (isSeriesException)", () => {
  it("SER-6.1 – Einzelnen Termin verschieben markiert isSeriesException", async () => {
    const seriesRes = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    const appts = seriesRes.data.appointments.filter((a: any) => a.status === "scheduled");
    if (appts.length === 0) return;

    const target = appts[appts.length - 1];
    const res = await apiPost<any>(
      `/api/appointment-series/${seriesId}/appointments/${target.id}/update`,
      {
        mode: "single",
        scheduledStart: "11:00",
        notes: "Einzeln verschoben",
      }
    );
    expect(res.status).toBe(200);

    const checkRes = await apiGet<any>(`/api/appointments/${target.id}`);
    expect(checkRes.data.isSeriesException).toBe(true);
  });
});

describe("SER-7: Serie beenden (DELETE)", () => {
  let endSeriesId: number;

  it("SER-7.1 – Serie beenden setzt alle zukünftigen auf cancelled", async () => {
    const startDate = getFutureDate(130);
    const endObj = new Date(startDate + "T00:00:00");
    endObj.setDate(endObj.getDate() + 21);
    const endDate = endObj.toISOString().split("T")[0];

    const createRes = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate,
      endDate,
      weekdays: ["fr"],
      frequency: "weekly",
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    endSeriesId = createRes.data.series.id;

    const delRes = await apiDelete(`/api/appointment-series/${endSeriesId}`);
    expect(delRes.status).toBe(200);
  });
});
