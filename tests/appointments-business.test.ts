import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let hwServiceId: number;
let abServiceId: number;
const createdIds: number[] = [];

async function cleanup() {
  for (const id of createdIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
  abServiceId = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung")!.id;

  const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=1");
  testCustomerId = custRes.data.data[0].id;

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
});

afterAll(cleanup);

describe("BIZ-1: Wochenend-Validierung", () => {
  it("BIZ-1.1 – Termin am Samstag wird abgelehnt", async () => {
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat);
    const satStr = sat.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: satStr,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("BIZ-1.2 – Termin am Sonntag wird abgelehnt", async () => {
    const today = new Date();
    const daysUntilSun = (7 - today.getDay()) % 7 || 7;
    const sun = new Date(today);
    sun.setDate(sun.getDate() + daysUntilSun);
    const sunStr = sun.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: sunStr,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("BIZ-2: Überlappungsprüfung", () => {
  const overlapDate = getFutureDate(20);

  afterAll(async () => {
    for (const id of [...createdIds]) {
      try { await apiDelete(`/api/appointments/${id}`); } catch {}
    }
  });

  it("BIZ-2.1 – Erstellt Basis-Termin 10:00-11:30", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: overlapDate,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 90 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    createdIds.push(res.data.id);
  });

  it("BIZ-2.2 – Überlappender Termin gleicher Mitarbeiter wird abgelehnt (409)", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: overlapDate,
      scheduledStart: "11:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(409);
  });

  it("BIZ-2.3 – Nicht-überlappender Termin um 12:00 wird akzeptiert", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: overlapDate,
      scheduledStart: "12:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    createdIds.push(res.data.id);
  });
});

describe("BIZ-3: scheduledEnd Berechnung", () => {
  it("BIZ-3.1 – scheduledEnd = start + summe(durationMinutes)", async () => {
    const date = getFutureDate(22);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "09:00",
      services: [
        { serviceId: hwServiceId, durationMinutes: 60 },
        { serviceId: abServiceId, durationMinutes: 30 },
      ],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    createdIds.push(res.data.id);
    expect(res.data.durationPromised).toBe(90);
    expect(res.data.scheduledEnd).toBe("10:30:00");
  });
});

describe("BIZ-4: Leere Services", () => {
  it("BIZ-4.1 – Termin ohne Services wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(23),
      scheduledStart: "10:00",
      services: [],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("BIZ-5: Status-Workflow", () => {
  let apptId: number;
  const statusDate = getFutureDate(25);

  it("BIZ-5.1 – Neuer Termin hat Status 'scheduled'", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: statusDate,
      scheduledStart: "08:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("scheduled");
    apptId = res.data.id;
    createdIds.push(apptId);
  });

  it("BIZ-5.2 – Start => in-progress", async () => {
    const res = await apiPost<any>(`/api/appointments/${apptId}/start`, {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("in-progress");
  });

  it("BIZ-5.3 – End => documenting", async () => {
    const res = await apiPost<any>(`/api/appointments/${apptId}/end`, {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("documenting");
  });

  it("BIZ-5.4 – Doppeltes Starten nicht möglich", async () => {
    const res = await apiPost<any>(`/api/appointments/${apptId}/start`, {});
    expect([400, 403]).toContain(res.status);
  });
});

describe("BIZ-6: Löschschutz bei abgeschlossenen Terminen", () => {
  let completedId: number;

  it("BIZ-6.1 – Erstellt und dokumentiert einen Termin", async () => {
    function getWeekday(d: Date): Date {
      const dow = d.getDay();
      if (dow === 0) d.setDate(d.getDate() - 2);
      else if (dow === 6) d.setDate(d.getDate() - 1);
      return d;
    }

    const timeSlots = ["07:00", "07:30", "16:00", "16:30", "17:00"];
    let createRes: any = null;

    outer:
    for (let offset = 2; offset <= 60; offset++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() - offset);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];

      for (const time of timeSlots) {
        createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: dateStr,
          scheduledStart: time,
          services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
          assignedEmployeeId: auth.user.id,
        });
        if (createRes.status === 201) break outer;
      }
    }

    if (!createRes || createRes.status !== 201) return;
    completedId = createRes.data.id;
    createdIds.push(completedId);

    const docRes = await apiPost<any>(`/api/appointments/${completedId}/document`, {
      actualStart: "07:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "BIZ-Test" }],
    });
    expect(docRes.status).toBe(200);
  });

  it("BIZ-6.2 – Abgeschlossener Termin kann nicht gelöscht werden", async () => {
    if (!completedId) return;
    const delRes = await apiDelete(`/api/appointments/${completedId}`);
    expect([400, 403]).toContain(delRes.status);
  });
});
