import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getAuthCookie,
  createTestCustomer,
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
  const startDate = getFutureDate(overrides._offset || 730);
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

  const newCust = await createTestCustomer({
    vorname: "Test",
    nachname: `Auto_SER-${Date.now()}`,
  });
  testCustomerId = newCust.id;

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
  if (testCustomerId) {
    try { await apiDelete(`/api/admin/customers/${testCustomerId}`); } catch {}
  }
});

describe("SER-1: Serie erstellen", () => {
  it("SER-1.1 – Wöchentliche Serie (4 Wochen, Mittwoch)", async () => {
    const res = await apiPost<any>("/api/appointment-series", seriesPayload({ _offset: 940, _span: 28 }));
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

describe("SER-1B: Serie Termine haben seriesId und counts", () => {
  it("SER-1B.1 – Alle Termine der Serie verweisen auf die seriesId", async () => {
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    for (const appt of res.data.appointments) {
      expect(appt.seriesId).toBe(seriesId);
    }
  });

  it("SER-1B.2 – Serie counts enthalten total, future, completed", async () => {
    expect(seriesId, "seriesId muss aus SER-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("counts");
    expect(typeof res.data.counts.total).toBe("number");
    expect(typeof res.data.counts.future).toBe("number");
    expect(typeof res.data.counts.completed).toBe("number");
    expect(res.data.counts.total).toBeGreaterThan(0);
    expect(res.data.counts.total).toBe(res.data.appointments.length);
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
  it("SER-3.1 – Einzelnen Termin der Serie absagen und Status prüfen", async () => {
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

    const otherAppts = appts.filter((a: any) => a.id !== firstAppt.id);
    for (const other of otherAppts) {
      const otherRes = await apiGet<any>(`/api/appointments/${other.id}`);
      expect(otherRes.data.status).toBe("scheduled");
    }
  });
});

describe("SER-4: Alle zukünftigen absagen mit Verifikation", () => {
  let tempSeriesId: number;
  let cancelledFromDate: string;

  it("SER-4.1 – Serie erstellen und ab Mitte alle zukünftigen absagen", async () => {
    const createRes = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 980, _span: 28, weekdays: ["di", "do"], scheduledStart: "15:00", durationMinutes: 45, services: [{ serviceId: hwServiceId, durationMinutes: 45 }] })
    );
    expect(createRes.status).toBe(201);
    tempSeriesId = createRes.data.series.id;
    cleanupSeriesIds.push(tempSeriesId);

    const seriesRes = await apiGet<any>(`/api/appointment-series/${tempSeriesId}`);
    const appts = (seriesRes.data.appointments || []).filter((a: any) => a.status === "scheduled");
    expect(appts.length, "Serie muss mindestens 2 geplante Termine haben").toBeGreaterThanOrEqual(2);

    const sorted = [...appts].sort((a: any, b: any) => a.date.localeCompare(b.date));
    const midIndex = Math.floor(sorted.length / 2);
    const midAppt = sorted[midIndex];
    cancelledFromDate = midAppt.date;

    const cancelRes = await apiPost<any>(
      `/api/appointment-series/${tempSeriesId}/appointments/${midAppt.id}/cancel`,
      { mode: "all_future" }
    );
    expect(cancelRes.status).toBe(200);
  });

  it("SER-4.2 – Verifikation: Termine ab Absagepunkt-Datum sind nicht mehr scheduled", async () => {
    expect(tempSeriesId, "tempSeriesId muss gesetzt sein").toBeTruthy();
    expect(cancelledFromDate, "cancelledFromDate muss gesetzt sein").toBeTruthy();
    const afterRes = await apiGet<any>(`/api/appointment-series/${tempSeriesId}`);
    expect(afterRes.status).toBe(200);
    const scheduledAfterDate = (afterRes.data.appointments || []).filter(
      (a: any) => a.status === "scheduled" && a.date >= cancelledFromDate
    );
    expect(scheduledAfterDate.length).toBe(0);
  });
});

describe("SER-5: Verlängern & Verkürzen", () => {
  let extendSeriesId: number;

  beforeAll(async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 800, _span: 14, weekdays: ["mi"], scheduledStart: "05:00" })
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
    expect(afterRes.data.appointments.length).toBeLessThan(countBefore);
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
        scheduledStart: "05:30",
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
      seriesPayload({ _offset: 850, _span: 21, weekdays: ["fr"], scheduledStart: "09:00" })
    );
    expect(createRes.status).toBe(201);
    endSeriesId = createRes.data.series.id;

    const beforeRes = await apiGet<any>(`/api/appointment-series/${endSeriesId}`);
    const scheduledBefore = beforeRes.data.appointments.filter((a: any) => a.status === "scheduled");
    expect(scheduledBefore.length).toBeGreaterThan(0);

    const delRes = await apiDelete(`/api/appointment-series/${endSeriesId}`);
    expect(delRes.status).toBe(200);

    const afterRes = await apiGet<any>(`/api/appointment-series/${endSeriesId}`);
    expect(afterRes.status).toBe(200);
    const scheduledAfter = afterRes.data.appointments.filter((a: any) => a.status === "scheduled");
    expect(scheduledAfter.length).toBe(0);
  });
});

describe("SER-8: Serien-Liste mit remainingCount", () => {
  it("SER-8.1 – Serien auflisten enthält aktive Serien mit remainingCount", async () => {
    const res = await apiGet<any[]>("/api/appointment-series");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    const activeSeries = res.data.find((s: any) => s.id === seriesId);
    expect(activeSeries, `Serie ${seriesId} muss in der aktiven Liste enthalten sein`).toBeDefined();
    expect(typeof activeSeries.remainingCount).toBe("number");
  });
});

describe("SER-9: Zweiwöchentliche Serie", () => {
  it("SER-9.1 – biweekly Serie erstellen", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 870, _span: 56, weekdays: ["mi"], frequency: "biweekly", scheduledStart: "14:00" })
    );
    expect(res.status).toBe(201);
    expect(res.data.series).toBeDefined();
    expect(res.data.series.frequency).toBe("biweekly");
    cleanupSeriesIds.push(res.data.series.id);

    const created = res.data.createdAppointments || 0;
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThanOrEqual(5);
  });
});

describe("SER-10: Serie Status nach Löschung", () => {
  it("SER-10.1 – Gelöschte Serie hat Status ended", async () => {
    const createRes = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 890, _span: 14, weekdays: ["do"], scheduledStart: "16:00" })
    );
    expect(createRes.status).toBe(201);
    const id = createRes.data.series.id;

    const delRes = await apiDelete(`/api/appointment-series/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.data.status).toBe("ended");

    const detailRes = await apiGet<any>(`/api/appointment-series/${id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.data.series.status).toBe("ended");
  });
});

describe("SER-11: Serie Counts und Details", () => {
  it("SER-11.1 – Serie counts zeigen total/future/completed Aufschlüsselung", async () => {
    expect(seriesId, "seriesId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    expect(res.data.counts).toHaveProperty("total");
    expect(res.data.counts).toHaveProperty("future");
    expect(res.data.counts).toHaveProperty("completed");
    expect(typeof res.data.counts.total).toBe("number");
    expect(res.data.counts.total).toBeGreaterThan(0);
  });

  it("SER-11.2 – Alle Termine der Serie fallen auf Werktage", async () => {
    expect(seriesId, "seriesId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointment-series/${seriesId}`);
    expect(res.status).toBe(200);
    for (const appt of res.data.appointments) {
      const d = new Date(appt.date + "T00:00:00");
      expect(d.getDay(), `${appt.date} darf kein Sonntag sein`).not.toBe(0);
      expect(d.getDay(), `${appt.date} darf kein Samstag sein`).not.toBe(6);
    }
  });
});

describe("SER-12A: Wochenendtag-Filterung", () => {
  it("SER-12A.1 – Serie mit ungültigen Wochenendtagen sa/so wird abgelehnt (400)", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 905, _span: 21, weekdays: ["sa", "so"], scheduledStart: "10:00" })
    );
    expect(res.status).toBe(400);
  });

  it("SER-12A.2 – Serie mit nur Wochentagen enthält keine Wochenenden", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 906, _span: 14, weekdays: ["mo", "di", "mi"], scheduledStart: "10:30" })
    );
    expect(res.status).toBe(201);
    cleanupSeriesIds.push(res.data.series.id);
    const detail = await apiGet<any>(`/api/appointment-series/${res.data.series.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data.appointments.length).toBeGreaterThan(0);
    for (const appt of detail.data.appointments) {
      const day = new Date(appt.date + "T00:00:00").getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
      expect([1, 2, 3]).toContain(day);
    }
  });
});

describe("SER-12: Serie mit ungültigen Daten", () => {
  it("SER-12.1 – Serie ohne weekdays wird abgelehnt (400)", async () => {
    const res = await apiPost<any>("/api/appointment-series",
      seriesPayload({ _offset: 920, _span: 14, weekdays: [] })
    );
    expect(res.status).toBe(400);
  });

  it("SER-12.2 – Serie Enddatum vor Startdatum wird abgelehnt (400)", async () => {
    const start = getFutureDate(930);
    const end = getFutureDate(925);
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
