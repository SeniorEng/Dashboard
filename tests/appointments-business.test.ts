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

function getWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

async function createAppointmentOnSlot(
  customerId: number,
  dateStr: string,
  time: string,
  serviceId: number,
  durationMinutes: number,
  employeeId: number
) {
  return apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId, durationMinutes }],
    assignedEmployeeId: employeeId,
  });
}

async function findFreeSlot(opts: { offsetRange: [number, number]; times: string[]; past?: boolean }) {
  const { offsetRange, times, past } = opts;
  for (let offset = offsetRange[0]; offset <= offsetRange[1]; offset++) {
    const candidate = new Date();
    if (past) {
      candidate.setDate(candidate.getDate() - offset);
    } else {
      candidate.setDate(candidate.getDate() + offset);
    }
    getWeekday(candidate);
    const dateStr = candidate.toISOString().split("T")[0];
    for (const time of times) {
      const res = await createAppointmentOnSlot(testCustomerId, dateStr, time, hwServiceId, 30, auth.user.id);
      if (res.status === 201) {
        createdIds.push(res.data.id);
        return res;
      }
    }
  }
  return null;
}

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
  const overlapDate = getFutureDate(220);

  it("BIZ-2.1 – Erstellt Basis-Termin 10:00-11:30", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: overlapDate,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 90 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.status).toBe("scheduled");
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
    const date = getFutureDate(222);
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

  it("BIZ-3.2 – Einzelner Service berechnet scheduledEnd korrekt", async () => {
    const date = getFutureDate(223);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "14:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 45 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(201);
    createdIds.push(res.data.id);
    expect(res.data.durationPromised).toBe(45);
    expect(res.data.scheduledEnd).toBe("14:45:00");
  });
});

describe("BIZ-4: Leere Services", () => {
  it("BIZ-4.1 – Termin ohne Services wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(224),
      scheduledStart: "10:00",
      services: [],
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("BIZ-5: Status-Workflow", () => {
  let apptId: number;
  const statusDate = getFutureDate(225);

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
    expect(apptId, "apptId muss aus BIZ-5.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/appointments/${apptId}/start`, {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("in-progress");
  });

  it("BIZ-5.3 – End => documenting", async () => {
    expect(apptId, "apptId muss aus BIZ-5.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/appointments/${apptId}/end`, {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("documenting");
  });

  it("BIZ-5.4 – Doppeltes Starten im documenting-Status wird abgelehnt (403)", async () => {
    expect(apptId, "apptId muss aus BIZ-5.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>(`/api/appointments/${apptId}/start`, {});
    expect(res.status).toBe(403);
  });

  it("BIZ-5.5 – Geplanter Termin löschen als Absage-Äquivalent", async () => {
    const cancelDate = getFutureDate(226);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: cancelDate,
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);

    const delRes = await apiDelete(`/api/appointments/${createRes.data.id}`);
    expect(delRes.status).toBe(200);
  });
});

describe("BIZ-6: Löschschutz bei abgeschlossenen Terminen", () => {
  let completedId: number;

  it("BIZ-6.1 – Erstellt und dokumentiert einen Termin", async () => {
    const res = await findFreeSlot({
      offsetRange: [2, 60],
      times: ["06:00", "06:30", "18:00", "18:30", "19:00"],
      past: true,
    });
    expect(res, "Freier Termin-Slot muss gefunden werden").toBeTruthy();
    expect(res!.status).toBe(201);
    completedId = res!.data.id;

    const docRes = await apiPost<any>(`/api/appointments/${completedId}/document`, {
      actualStart: "06:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "BIZ-Test" }],
    });
    expect(docRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${completedId}`);
    expect(fetchRes.data.status).toBe("completed");
  });

  it("BIZ-6.2 – Abgeschlossener Termin: Admin kann löschen (mit Budget-Rollback)", async () => {
    expect(completedId, "completedId muss aus BIZ-6.1 gesetzt sein").toBeTruthy();
    const delRes = await apiDelete(`/api/appointments/${completedId}`);
    expect(delRes.status).toBe(200);
  });
});

describe("BIZ-7: Termin bearbeiten", () => {
  let editApptId: number;

  it("BIZ-7.1 – Termin-Zeit verschieben", async () => {
    const date = getFutureDate(228);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    editApptId = createRes.data.id;
    createdIds.push(editApptId);

    const updateRes = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      scheduledStart: "11:00",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.data.scheduledStart).toBe("11:00:00");
  });

  it("BIZ-7.2 – Notizen eines geplanten Termins ändern", async () => {
    expect(editApptId, "editApptId muss aus BIZ-7.1 gesetzt sein").toBeTruthy();
    const updateRes = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      notes: "Aktualisierte Notiz BIZ-7.2",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.data.notes).toBe("Aktualisierte Notiz BIZ-7.2");
  });
});

describe("BIZ-8: Dokumentation", () => {
  let docApptId: number;

  it("BIZ-8.1 – Termin dokumentieren setzt Status auf completed", async () => {
    const res = await findFreeSlot({
      offsetRange: [2, 60],
      times: ["05:00", "05:30", "19:30", "20:00"],
      past: true,
    });
    expect(res, "Freier Slot für Dokumentation muss gefunden werden").toBeTruthy();
    docApptId = res!.data.id;

    const docRes = await apiPost<any>(`/api/appointments/${docApptId}/document`, {
      actualStart: "05:00",
      travelOriginType: "home",
      travelKilometers: 5,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Dokumentation-Test" }],
    });
    expect(docRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${docApptId}`);
    expect(fetchRes.data.status).toBe("completed");
    expect(fetchRes.data.travelKilometers).toBe(5);
  });
});

describe("BIZ-9: Geplanter Termin löschen", () => {
  it("BIZ-9.1 – Geplanter Termin kann gelöscht werden", async () => {
    const date = getFutureDate(229);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "15:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    const tmpId = createRes.data.id;

    const delRes = await apiDelete(`/api/appointments/${tmpId}`);
    expect(delRes.status).toBe(200);
  });

  it("BIZ-9.2 – Gelöschter Termin liefert 404 beim erneuten Abrufen", async () => {
    const date = getFutureDate(230);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "15:30",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    const tmpId = createRes.data.id;
    await apiDelete(`/api/appointments/${tmpId}`);

    const fetchRes = await apiGet<any>(`/api/appointments/${tmpId}`);
    expect(fetchRes.status).toBe(404);
  });
});

describe("BIZ-10: Kunden-Überlappung", () => {
  it("BIZ-10.1 – Zweiter Termin für gleichen Kunden zur gleichen Zeit wird abgelehnt", async () => {
    const date = getFutureDate(231);
    const res1 = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res1.status).toBe(201);
    createdIds.push(res1.data.id);

    const res2 = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "10:30",
      services: [{ serviceId: abServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(res2.status).toBe(409);
  });
});

describe("BIZ-11: PATCH Wochenend-Validierung", () => {
  it("BIZ-11.1 – Termin auf Wochenende verschieben wird abgelehnt", async () => {
    const date = getFutureDate(232);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    createdIds.push(createRes.data.id);

    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat + 7);
    const satStr = sat.toISOString().split("T")[0];

    const patchRes = await apiPatch<any>(`/api/appointments/${createRes.data.id}`, {
      date: satStr,
    });
    expect(patchRes.status).toBe(400);
  });
});

describe("BIZ-12: Vergangenheits-Einschränkung", () => {
  it("BIZ-12.1 – Admin kann Termin in der Vergangenheit erstellen", async () => {
    const pastDate = new Date();
    pastDate.setMonth(pastDate.getMonth() - 4);
    const dow = pastDate.getDay();
    if (dow === 0) pastDate.setDate(pastDate.getDate() + 1);
    else if (dow === 6) pastDate.setDate(pastDate.getDate() + 2);
    const dateStr = pastDate.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "07:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    if (res.status === 201) {
      createdIds.push(res.data.id);
      expect(res.data.id).toBeDefined();
    } else {
      expect(res.status).toBe(409);
    }
  });
});

describe("BIZ-13: Status-Workflow Reihenfolge", () => {
  it("BIZ-13.1 – Direktes End ohne Start wird abgelehnt (403)", async () => {
    const date = getFutureDate(233);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "06:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    createdIds.push(createRes.data.id);

    const endRes = await apiPost<any>(`/api/appointments/${createRes.data.id}/end`, {});
    expect(endRes.status).toBe(403);
  });

  it("BIZ-13.2 – Doppeltes End im documenting-Status wird abgelehnt (403)", async () => {
    const date = getFutureDate(234);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "06:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    createdIds.push(createRes.data.id);

    await apiPost<any>(`/api/appointments/${createRes.data.id}/start`, {});
    const endRes1 = await apiPost<any>(`/api/appointments/${createRes.data.id}/end`, {});
    expect(endRes1.status).toBe(200);

    const endRes2 = await apiPost<any>(`/api/appointments/${createRes.data.id}/end`, {});
    expect(endRes2.status).toBe(403);
  });
});

describe("BIZ-14: Scheduling-Felder Sperre im documenting-Status", () => {
  let docApptId: number;

  it("BIZ-14.1 – Termin in documenting-Status: Zeit ändern wird abgelehnt", async () => {
    const date = getFutureDate(235);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "08:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    docApptId = createRes.data.id;
    createdIds.push(docApptId);

    await apiPost<any>(`/api/appointments/${docApptId}/start`, {});
    await apiPost<any>(`/api/appointments/${docApptId}/end`, {});

    const verify = await apiGet<any>(`/api/appointments/${docApptId}`);
    expect(verify.data.status).toBe("documenting");

    const patchRes = await apiPatch<any>(`/api/appointments/${docApptId}`, {
      scheduledStart: "14:00",
    });
    expect(patchRes.status).toBe(403);
  });

  it("BIZ-14.2 – Termin in documenting-Status: Datum ändern wird abgelehnt (403)", async () => {
    expect(docApptId, "docApptId muss gesetzt sein").toBeTruthy();
    const patchRes = await apiPatch<any>(`/api/appointments/${docApptId}`, {
      date: getFutureDate(300),
    });
    expect(patchRes.status).toBe(403);
  });
});

describe("BIZ-15: Abgeschlossener Termin kann nicht per PATCH geändert werden", () => {
  it("BIZ-15.1 – completed-Termin: PATCH wird abgelehnt", async () => {
    const res = await findFreeSlot({
      offsetRange: [2, 60],
      times: ["04:00", "04:30", "20:30", "21:00"],
      past: true,
    });
    expect(res, "Freier Slot muss gefunden werden").toBeTruthy();
    const id = res!.data.id;

    await apiPost<any>(`/api/appointments/${id}/document`, {
      actualStart: "04:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Completed-Test" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${id}`);
    expect(verify.data.status).toBe("completed");

    const patchRes = await apiPatch<any>(`/api/appointments/${id}`, {
      notes: "Sollte nicht funktionieren",
    });
    expect(patchRes.status).toBe(403);
  });
});

describe("BIZ-16: Completed -> Reopen -> Documenting", () => {
  it("BIZ-16.1 – Abgeschlossenen Termin wiedereröffnen", async () => {
    const res = await findFreeSlot({
      offsetRange: [2, 60],
      times: ["03:00", "03:30", "21:30", "22:00"],
      past: true,
    });
    expect(res, "Freier Slot muss gefunden werden").toBeTruthy();
    const id = res!.data.id;

    await apiPost<any>(`/api/appointments/${id}/document`, {
      actualStart: "03:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Reopen-Test" }],
    });

    const reopenRes = await apiPost<any>(`/api/appointments/${id}/reopen`, {});
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.data.status).toBe("documenting");
  });
});

describe("BIZ-17: durationPromised wird bei Erstellung aus Services berechnet", () => {
  it("BIZ-17.1 – durationPromised = Summe aller Service-Dauern", async () => {
    const date = getFutureDate(236);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "07:00",
      services: [
        { serviceId: hwServiceId, durationMinutes: 30 },
        { serviceId: abServiceId, durationMinutes: 45 },
      ],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    createdIds.push(createRes.data.id);
    expect(createRes.data.durationPromised).toBe(75);
  });

  it("BIZ-17.2 – Einzelner Service: durationPromised = Einzeldauer", async () => {
    const date = getFutureDate(237);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "07:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    createdIds.push(createRes.data.id);
    expect(createRes.data.durationPromised).toBe(60);
  });
});
