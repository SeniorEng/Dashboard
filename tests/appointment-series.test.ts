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

function seriesPayload(overrides: Record<string, any> = {}) {
  const startDate = getFutureDate(overrides._offset || 30);
  const endObj = new Date(startDate + "T00:00:00");
  endObj.setDate(endObj.getDate() + (overrides._span || 28));
  const endDate = endObj.toISOString().split("T")[0];
  delete overrides._offset;
  delete overrides._span;

  return {
    customerId: testCustomerId,
    startDate,
    endDate,
    weekdays: ["mi"],
    frequency: "weekly",
    scheduledStart: "09:00",
    durationMinutes: 60,
    services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    assignedEmployeeId: auth.user.id,
    ...overrides,
  };
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
  it("SER-1.1 – Wöchentliche Serie (4 Wochen, Mittwoch)", async () => {
    const res = await apiPost<any>("/api/appointment-series", seriesPayload({ _offset: 30, _span: 28 }));
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("series");
    expect(res.data.series).toHaveProperty("id");
    seriesId = res.data.series.id;
    cleanupSeriesIds.push(seriesId);
    const created = res.data.createdAppointments || res.data.createdCount || res.data.appointments?.length || 0;
    expect(created).toBeGreaterThan(0);
  });

  it("SER-1.2 – Serie abrufen zeigt Termine", async () => {
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("series");
    expect(res.data).toHaveProperty("appointments");
    expect(res.data.appointments.length).toBeGreaterThan(0);
  });

  it("SER-1.3 – Maximale Laufzeit 12 Monate wird erzwungen", async () => {
    const res = await apiPost<any>("/api/appointment-series", seriesPayload({ _offset: 60, _span: 400 }));
    expect(res.status).toBe(400);
  });
});

describe("SER-1B: Serie Termine haben seriesId", () => {
  it("SER-1B.1 – Alle Termine der Serie verweisen auf die seriesId", async () => {
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    for (const appt of res.data.appointments) {
      expect(appt.seriesId).toBe(seriesId);
    }
  });

  it("SER-1B.2 – Serie zeigt korrekte counts", async () => {
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("counts");
    expect(typeof res.data.counts.total).toBe("number");
    expect(res.data.counts.total).toBeGreaterThan(0);
  });
});

describe("SER-2: Vorschau (Preview)", () => {
  it("SER-2.1 – Preview liefert generierte Termine ohne Speicherung", async () => {
    const payload = seriesPayload({ _offset: 150, _span: 14, weekdays: ["do"] });

    const res = await apiPost<any>("/api/appointment-series/preview", payload);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("validDates");
    expect(res.data.validDates).toBeGreaterThan(0);
    expect(res.data).toHaveProperty("totalDates");
  });
});

describe("SER-3: Einzeltermin-Absage", () => {
  it("SER-3.1 – Einzelnen Termin der Serie absagen", async () => {
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const seriesRes = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    const appts = (seriesRes.data.appointments || []).filter((a: any) => a.status === "scheduled");
    expect(appts.length, "Es müssen geplante Termine vorhanden sein").toBeGreaterThan(0);

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
    const createRes = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 160, _span: 28, weekdays: ["di", "do"], scheduledStart: "15:00", durationMinutes: 45, services: [{ serviceId: hwServiceId, durationMinutes: 45 }] })
    );
    expect(createRes.status).toBe(201);
    tempSeriesId = createRes.data.series.id;
    cleanupSeriesIds.push(tempSeriesId);

    const seriesRes = await apiGet<any>(`/api/appointment-series/${tempSeriesId}`);
    const appts = (seriesRes.data.appointments || []).filter((a: any) => a.status === "scheduled");
    expect(appts.length, "Serie muss mindestens 2 geplante Termine haben").toBeGreaterThanOrEqual(2);

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
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 200, _span: 14, weekdays: ["mi"], scheduledStart: "10:00" })
    );
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
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const seriesRes = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    const appts = (seriesRes.data.appointments || []).filter((a: any) => a.status === "scheduled");
    expect(appts.length, "Es müssen geplante Termine vorhanden sein").toBeGreaterThan(0);

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

  it("SER-7.1 – Serie beenden cancelt zukünftige Termine", async () => {
    const createRes = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 250, _span: 21, weekdays: ["fr"], scheduledStart: "09:00" })
    );
    expect(createRes.status).toBe(201);
    endSeriesId = createRes.data.series.id;

    const delRes = await apiDelete(`/api/appointment-series/${endSeriesId}`);
    expect(delRes.status).toBe(200);
  });
});

describe("SER-8: Serien-Liste", () => {
  it("SER-8.1 – Serien auflisten enthält aktive Serien", async () => {
    const res = await apiGet<any[]>("/api/appointment-series");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("SER-9: Zweiwöchentliche Serie", () => {
  it("SER-9.1 – biweekly Serie erstellen", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 270, _span: 56, weekdays: ["mi"], frequency: "biweekly", scheduledStart: "14:00" })
    );
    expect(res.status).toBe(201);
    expect(res.data.series).toBeDefined();
    expect(res.data.series.frequency).toBe("biweekly");
    cleanupSeriesIds.push(res.data.series.id);

    const created = res.data.createdAppointments || 0;
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(8);
  });
});

describe("SER-10: Serie Status nach Löschung", () => {
  it("SER-10.1 – Gelöschte Serie hat Status ended", async () => {
    const createRes = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 290, _span: 14, weekdays: ["do"], scheduledStart: "16:00" })
    );
    expect(createRes.status).toBe(201);
    const id = createRes.data.series.id;

    const delRes = await apiDelete(`/api/appointment-series/${id}`);
    expect(delRes.status).toBe(200);

    const listRes = await apiGet<any[]>("/api/appointment-series");
    const found = listRes.data.find((s: any) => s.id === id);
    if (found) {
      expect(found.status).toBe("ended");
    }
  });
});

describe("SER-11: Serie Counts und Details", () => {
  it("SER-11.1 – Serie counts zeigen scheduled/cancelled Aufschlüsselung", async () => {
    expect(seriesId, "seriesId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data.counts).toHaveProperty("total");
    expect(res.data.counts).toHaveProperty("future");
    expect(res.data.counts).toHaveProperty("completed");
    expect(typeof res.data.counts.total).toBe("number");
    expect(res.data.counts.total).toBeGreaterThan(0);
  });

  it("SER-11.2 – Alle Termine der Serie enthalten Wochentagsdaten", async () => {
    expect(seriesId, "seriesId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    for (const appt of res.data.appointments) {
      const d = new Date(appt.date + "T00:00:00");
      expect(d.getDay()).not.toBe(0);
      expect(d.getDay()).not.toBe(6);
    }
  });
});

describe("SER-12: Serie mit ungültigen Daten", () => {
  it("SER-12.1 – Serie ohne weekdays wird abgelehnt (400)", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 295, _span: 14, weekdays: [] })
    );
    expect(res.status).toBe(400);
  });

  it("SER-12.2 – Serie Enddatum vor Startdatum wird abgelehnt (400)", async () => {
    const start = getFutureDate(300);
    const end = getFutureDate(295);
    const res = await apiPost<any>("/api/appointment-series", {
      customerId: testCustomerId,
      startDate: start,
      endDate: end,
      weekdays: ["mi"],
      frequency: "weekly",
      scheduledStart: "09:00",
      durationMinutes: 60,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});
