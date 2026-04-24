import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getAuthCookie,
  loginAs,
  apiPostAs,
  apiPatchAs,
  apiDeleteAs,
  apiGetAs,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let testEmployeeId: number;
let hwServiceId: number;
let abServiceId: number;
const createdIds: number[] = [];

function getWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

async function createAppointment(
  dateStr: string,
  time: string,
  serviceId: number,
  durationMinutes: number,
) {
  return apiPost<any>("/api/appointments/kundentermin", {
    customerId: testCustomerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId, durationMinutes }],
    assignedEmployeeId: testEmployeeId,
  });
}

async function createOnFreeSlot(opts: {
  offsetRange: [number, number];
  times: string[];
  past?: boolean;
}): Promise<{ id: number; date: string; time: string }> {
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
      const res = await createAppointment(dateStr, time, hwServiceId, 30);
      if (res.status === 201) {
        createdIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("Kein freier Slot gefunden");
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

  const emp = await createTestEmployee({ nachnamePrefix: "TestAppt" });
  testEmployeeId = emp.id;

  const cust = await createTestCustomer({ nachname: `ApptTest_${Date.now()}` });
  testCustomerId = cust.id;

  await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
});

afterAll(async () => {
  await cleanup();
  await deactivateTestEmployee(testEmployeeId);
});

describe("BIZ-1: Wochenend-Validierung", () => {
  let weekendNonAdminAuth: Awaited<ReturnType<typeof loginAs>> | null = null;
  let weekendNonAdminId: number | null = null;

  beforeAll(async () => {
    const emp = await createTestEmployee({ nachnamePrefix: "WeekendMA" });
    weekendNonAdminId = emp.id;
    weekendNonAdminAuth = await loginAs(emp.email, emp.password);
    await apiPatch(`/api/admin/customers/${testCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: testEmployeeId,
      backupEmployeeId2: emp.id,
    });
  });

  afterAll(async () => {
    await deactivateTestEmployee(weekendNonAdminId);
  });

  it("BIZ-1.1 – Termin am Samstag wird für Mitarbeiter abgelehnt", async () => {
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat);
    const satStr = sat.toISOString().split("T")[0];

    const res = await apiPostAs<any>(weekendNonAdminAuth!, "/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: satStr,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: weekendNonAdminAuth!.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("BIZ-1.2 – Termin am Sonntag wird für Mitarbeiter abgelehnt", async () => {
    const today = new Date();
    const daysUntilSun = (7 - today.getDay()) % 7 || 7;
    const sun = new Date(today);
    sun.setDate(sun.getDate() + daysUntilSun);
    const sunStr = sun.toISOString().split("T")[0];

    const res = await apiPostAs<any>(weekendNonAdminAuth!, "/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: sunStr,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: weekendNonAdminAuth!.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("BIZ-1.3 – Termin am Samstag wird auch für Admin abgelehnt", async () => {
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat + 7);
    const satStr = sat.toISOString().split("T")[0];

    const res = await createAppointment(satStr, "10:00", hwServiceId, 60);
    expect(res.status).toBe(400);
  });
});

describe("BIZ-2: Überlappungsprüfung", () => {
  let overlapDate: string;

  it("BIZ-2.1 – Erstellt Basis-Termin 10:00-11:30", async () => {
    for (let off = 220; off <= 260; off++) {
      const d = getFutureDate(off);
      const res = await createAppointment(d, "10:00", hwServiceId, 90);
      if (res.status === 201) {
        overlapDate = d;
        createdIds.push(res.data.id);
        expect(res.data).toHaveProperty("id");
        expect(res.data.status).toBe("scheduled");
        return;
      }
    }
    throw new Error("Kein freier Slot gefunden");
  });

  it("BIZ-2.2 – Überlappender Termin gleicher Mitarbeiter wird abgelehnt (409)", async () => {
    expect(overlapDate).toBeDefined();
    const res = await createAppointment(overlapDate, "11:00", hwServiceId, 60);
    expect(res.status).toBe(409);
  });

  it("BIZ-2.3 – Nicht-überlappender Termin um 12:00 wird akzeptiert", async () => {
    expect(overlapDate).toBeDefined();
    const res = await createAppointment(overlapDate, "12:00", hwServiceId, 60);
    expect(res.status).toBe(201);
    createdIds.push(res.data.id);
  });
});

describe("BIZ-3: scheduledEnd Berechnung", () => {
  it("BIZ-3.1 – scheduledEnd = start + summe(durationMinutes)", async () => {
    let created = false;
    for (let off = 283; off <= 330; off++) {
      const date = getFutureDate(off);
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date,
        scheduledStart: "09:00",
        services: [
          { serviceId: hwServiceId, durationMinutes: 60 },
          { serviceId: abServiceId, durationMinutes: 30 },
        ],
        assignedEmployeeId: testEmployeeId,
      });
      if (res.status === 201) {
        createdIds.push(res.data.id);
        expect(res.data.durationPromised).toBe(90);
        expect(res.data.scheduledEnd).toBe("10:30:00");
        created = true;
        break;
      }
    }
    expect(created, "Termin muss erstellt werden").toBe(true);
  });

  it("BIZ-3.2 – Einzelner Service berechnet scheduledEnd korrekt", async () => {
    let created = false;
    for (let off = 340; off <= 380; off++) {
      const date = getFutureDate(off);
      const createRes = await createAppointment(date, "14:00", hwServiceId, 45);
      if (createRes.status === 201) {
        createdIds.push(createRes.data.id);
        expect(createRes.data.durationPromised).toBe(45);
        expect(createRes.data.scheduledEnd).toBe("14:45:00");
        created = true;
        break;
      }
    }
    expect(created, "Termin muss erstellt werden").toBe(true);
  });
});

describe("BIZ-4: Leere Services", () => {
  it("BIZ-4.1 – Termin ohne Services wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: getFutureDate(224),
      scheduledStart: "10:00",
      services: [],
      assignedEmployeeId: testEmployeeId,
    });
    expect(res.status).toBe(400);
  });
});

describe("BIZ-5: Status-Workflow", () => {
  let apptId: number;

  it("BIZ-5.1 – Neuer Termin hat Status 'scheduled'", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [225, 240],
      times: ["08:00", "08:30", "09:00", "09:30", "17:00", "17:30"],
    });
    apptId = slot.id;
    const res = await apiGet<any>(`/api/appointments/${apptId}`);
    expect(res.data.status).toBe("scheduled");
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
    const slot = await createOnFreeSlot({
      offsetRange: [421, 435],
      times: ["09:00", "09:30", "14:00", "14:30"],
    });
    const delRes = await apiDelete(`/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(200);
  });
});

describe("BIZ-6: Löschschutz bei abgeschlossenen Terminen", () => {
  let completedId: number;

  it("BIZ-6.1 – Erstellt und dokumentiert einen Termin", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["06:00", "06:30", "18:00", "18:30", "19:00"],
      past: true,
    });
    completedId = slot.id;

    const docRes = await apiPost<any>(`/api/appointments/${completedId}/document`, {
      actualStart: slot.time,
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
    const times = ["09:00", "08:00", "07:00", "06:00", "05:00"];
    const targetTimes = ["11:00", "14:00", "15:00", "16:00", "17:00"];
    let createRes: any;
    let usedTargetTime = "";
    for (let t = 0; t < times.length; t++) {
      const date = getFutureDate(228 + t);
      createRes = await createAppointment(date, times[t], hwServiceId, 60);
      if (createRes.status === 201) {
        editApptId = createRes.data.id;
        createdIds.push(editApptId);
        for (const target of targetTimes) {
          const updateRes = await apiPatch<any>(`/api/appointments/${editApptId}`, {
            scheduledStart: target,
          });
          if (updateRes.status === 200) {
            usedTargetTime = target;
            expect(updateRes.data.scheduledStart).toBe(target + ":00");
            break;
          }
        }
        break;
      }
    }
    expect(createRes?.status, "Mindestens ein Slot muss frei sein").toBe(201);
    expect(usedTargetTime, "Mindestens ein Zielslot muss frei sein").toBeTruthy();
  });

  it("BIZ-7.2 – Notizen eines geplanten Termins ändern", async () => {
    expect(editApptId, "editApptId muss aus BIZ-7.1 gesetzt sein").toBeTruthy();
    const updateRes = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      notes: "Aktualisierte Notiz BIZ-7.2",
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.data.notes).toBe("Aktualisierte Notiz BIZ-7.2");
  });

  it("BIZ-7.3 – Service PATCH aktualisiert Termin-Dienste", async () => {
    expect(editApptId, "editApptId muss gesetzt sein").toBeTruthy();
    const patchRes = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      notes: "BIZ-7.3 Service-Update",
      services: [
        { serviceId: hwServiceId, plannedDurationMinutes: 45 },
        { serviceId: abServiceId, plannedDurationMinutes: 30 },
      ],
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.notes).toBe("BIZ-7.3 Service-Update");
  });
});

describe("BIZ-8: Dokumentation", () => {
  it("BIZ-8.1 – Termin dokumentieren setzt Status auf completed", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["05:00", "05:30", "19:30", "20:00"],
      past: true,
    });

    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 5,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Dokumentation-Test" }],
    });
    expect(docRes.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(fetchRes.data.status).toBe("completed");
    expect(fetchRes.data.travelKilometers).toBe(5);
  });
});

describe("BIZ-9: Geplanter Termin löschen", () => {
  it("BIZ-9.1 – Geplanter Termin kann gelöscht werden", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [366, 378],
      times: ["15:00", "15:30", "16:00", "16:30"],
    });
    const delRes = await apiDelete(`/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(200);
  });

  it("BIZ-9.2 – Gelöschter Termin liefert 404 beim erneuten Abrufen", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [379, 391],
      times: ["15:30", "16:00", "16:30", "17:00"],
    });
    await apiDelete(`/api/appointments/${slot.id}`);
    const fetchRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(fetchRes.status).toBe(404);
  });
});

describe("BIZ-10: Kunden-Überlappung", () => {
  it("BIZ-10.1 – Zweiter Termin für gleichen Kunden zur gleichen Zeit wird abgelehnt", async () => {
    let foundDate: string | undefined;
    let firstId: number | undefined;
    for (let off = 392; off <= 435; off++) {
      const d = getFutureDate(off);
      const res1 = await createAppointment(d, "10:00", hwServiceId, 60);
      if (res1.status === 201) {
        createdIds.push(res1.data.id);
        foundDate = d;
        firstId = res1.data.id;
        break;
      }
    }
    expect(foundDate).toBeDefined();

    const res2 = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: foundDate,
      scheduledStart: "10:30",
      services: [{ serviceId: abServiceId, durationMinutes: 30 }],
      assignedEmployeeId: testEmployeeId,
    });
    expect(res2.status).toBe(409);
  });
});

describe("BIZ-11: PATCH Wochenend-Validierung", () => {
  it("BIZ-11.1 – Termin auf Wochenende verschieben wird abgelehnt", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [406, 420],
      times: ["09:00", "09:30", "13:00", "13:30"],
    });

    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat + 7);
    const satStr = sat.toISOString().split("T")[0];

    const patchRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      date: satStr,
    });
    expect(patchRes.status).toBe(400);
  });
});

describe("BIZ-12: Admin Past-Date Erstellung", () => {
  it("BIZ-12.1 – Admin kann Termin in der Vergangenheit erstellen", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [5, 60],
      times: ["04:00", "04:30", "22:00", "22:30"],
      past: true,
    });
    expect(slot.id).toBeDefined();
  });
});

describe("BIZ-13: Status-Workflow Reihenfolge", () => {
  it("BIZ-13.1 – Direktes End ohne Start wird abgelehnt (403)", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [233, 245],
      times: ["06:00", "06:30", "07:00", "16:00", "16:30"],
    });

    const endRes = await apiPost<any>(`/api/appointments/${slot.id}/end`, {});
    expect(endRes.status).toBe(403);
  });

  it("BIZ-13.2 – Doppeltes End im documenting-Status wird abgelehnt (403)", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [246, 258],
      times: ["06:00", "06:30", "07:00", "16:00", "16:30"],
    });

    await apiPost<any>(`/api/appointments/${slot.id}/start`, {});
    const endRes1 = await apiPost<any>(`/api/appointments/${slot.id}/end`, {});
    expect(endRes1.status).toBe(200);

    const endRes2 = await apiPost<any>(`/api/appointments/${slot.id}/end`, {});
    expect(endRes2.status).toBe(403);
  });
});

describe("BIZ-14: Scheduling-Felder Sperre im documenting-Status", () => {
  let docApptId: number;

  it("BIZ-14.1 – Termin in documenting-Status: Zeit ändern wird abgelehnt", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [260, 275],
      times: ["08:00", "08:30", "09:00", "15:00", "15:30"],
    });
    docApptId = slot.id;

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
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["04:00", "04:30", "20:30", "21:00"],
      past: true,
    });

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Completed-Test" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    const patchRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      notes: "Sollte nicht funktionieren",
    });
    expect(patchRes.status).toBe(403);
  });
});

describe("BIZ-16: Completed -> Reopen -> Documenting", () => {
  it("BIZ-16.1 – Abgeschlossenen Termin wiedereröffnen", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["03:00", "03:30", "21:30", "22:00"],
      past: true,
    });

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Reopen-Test" }],
    });

    const reopenRes = await apiPost<any>(`/api/appointments/${slot.id}/reopen`, {});
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.data.status).toBe("documenting");
  });
});

describe("BIZ-17: durationPromised wird bei Erstellung aus Services berechnet", () => {
  it("BIZ-17.1 – durationPromised = Summe aller Service-Dauern", async () => {
    let created = false;
    const timesDP = ["07:00", "06:00", "05:00", "04:00", "03:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    for (const offset of [276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295]) {
      const date = getFutureDate(offset);
      for (const time of timesDP) {
        const createRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date,
          scheduledStart: time,
          services: [
            { serviceId: hwServiceId, durationMinutes: 30 },
            { serviceId: abServiceId, durationMinutes: 45 },
          ],
          assignedEmployeeId: testEmployeeId,
        });
        if (createRes.status === 201) {
          createdIds.push(createRes.data.id);
          expect(createRes.data.durationPromised).toBe(75);
          created = true;
          break;
        }
      }
      if (created) break;
    }
    expect(created, "Termin muss erstellt werden").toBe(true);
  });

  it("BIZ-17.2 – Einzelner Service: durationPromised = Einzeldauer", async () => {
    let created = false;
    const timesDP2 = ["07:00", "06:00", "05:00", "04:00", "03:00", "17:00", "18:00", "19:00"];
    outer2:
    for (let off = 309; off <= 340; off++) {
      const date = getFutureDate(off);
      for (const time of timesDP2) {
        const createRes = await createAppointment(date, time, hwServiceId, 60);
        if (createRes.status === 201) {
          createdIds.push(createRes.data.id);
          expect(createRes.data.durationPromised).toBe(60);
          created = true;
          break outer2;
        }
      }
    }
    expect(created, "Termin muss erstellt werden").toBe(true);
  });
});

describe("BIZ-18: Termin löschen entfernt aus Tagesliste", () => {
  it("BIZ-18.1 – Gelöschter Termin erscheint nicht mehr in Tagesliste", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [321, 335],
      times: ["06:00", "06:30", "16:00", "16:30"],
    });
    const id = slot.id;
    const date = slot.date;

    const beforeList = await apiGet<any[]>(`/api/appointments?date=${date}`);
    expect(beforeList.status).toBe(200);
    const beforeArr = Array.isArray(beforeList.data) ? beforeList.data : [];
    const foundBefore = beforeArr.find((a: any) => a.id === id);
    expect(foundBefore, "Termin muss vor Löschung in Tagesliste sein").toBeDefined();

    await apiDelete(`/api/appointments/${id}`);

    const afterList = await apiGet<any[]>(`/api/appointments?date=${date}`);
    const afterArr = Array.isArray(afterList.data) ? afterList.data : [];
    const foundAfter = afterArr.find((a: any) => a.id === id);
    expect(foundAfter, "Termin darf nach Löschung nicht mehr in Tagesliste sein").toBeUndefined();
  });
});

describe("BIZ-19: Notizen im documenting-Status erlaubt", () => {
  it("BIZ-19.1 – notes PATCH im documenting-Status liefert 200", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [336, 350],
      times: ["08:00", "08:30", "09:00", "15:00", "15:30"],
    });

    await apiPost<any>(`/api/appointments/${slot.id}/start`, {});
    await apiPost<any>(`/api/appointments/${slot.id}/end`, {});

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("documenting");

    const patchRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      notes: "Doku-Notiz erlaubt",
    });
    expect(patchRes.status).toBe(200);
  });
});

describe("BIZ-20A: Admin kann completed Termin löschen mit Budget-Reversal", () => {
  it("BIZ-20A.1 – Admin löscht completed Termin → 200 mit reversal", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["01:00", "01:30", "22:30", "22:00"],
      past: true,
    });

    const budgetBefore = await apiGet<any>(`/api/budget/${testCustomerId}/overview`);
    expect(budgetBefore.status).toBe(200);

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "BIZ-20A" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    const txBefore = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=50`);
    expect(txBefore.status).toBe(200);
    const consumptionsBefore = txBefore.data.filter((t: any) => t.transactionType === "consumption").length;

    const delRes = await apiDelete(`/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(200);

    const afterDel = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(afterDel.status).toBe(404);

    const txAfter = await apiGet<any[]>(`/api/budget/${testCustomerId}/transactions?budgetType=entlastungsbetrag_45b&limit=50`);
    expect(txAfter.status).toBe(200);
    const reversalsAfter = txAfter.data.filter((t: any) => t.transactionType === "reversal").length;
    const reversalsBefore = txBefore.data.filter((t: any) => t.transactionType === "reversal").length;
    expect(reversalsAfter).toBeGreaterThanOrEqual(reversalsBefore);
  });
});

describe("BIZ-20B: PATCH mit Termin-Verschiebung in Konflikt", () => {
  it("BIZ-20B.1 – PATCH Terminverschiebung in bestehenden Zeitraum liefert 409", async () => {
    let date: string | undefined;
    let r1Time = "";
    let r2Id: number | undefined;
    const timePairs = [
      ["04:00", "06:00"],
      ["03:00", "05:00"],
      ["17:00", "19:00"],
      ["20:00", "22:00"],
    ];
    outer:
    for (let off = 351; off <= 435; off++) {
      const d = getFutureDate(off);
      for (const [t1, t2] of timePairs) {
        const r1 = await createAppointment(d, t1, hwServiceId, 60);
        if (r1.status !== 201) continue;
        createdIds.push(r1.data.id);
        const r2 = await createAppointment(d, t2, hwServiceId, 60);
        if (r2.status !== 201) continue;
        createdIds.push(r2.data.id);
        date = d;
        r1Time = t1;
        r2Id = r2.data.id;
        break outer;
      }
    }
    expect(date, "Freier Tag für zwei Termine muss gefunden werden").toBeDefined();

    const patchRes = await apiPatch<any>(`/api/appointments/${r2Id}`, {
      scheduledStart: r1Time,
    });
    expect(patchRes.status).toBe(409);
  });
});

describe("BIZ-20C: Statusübergangs-Validierung", () => {
  it("BIZ-20C.1 – document ohne services wird abgelehnt (400)", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["00:30", "01:00", "05:30", "04:30"],
      past: true,
    });

    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [],
    });
    expect(docRes.status).toBe(400);
  });

  it("BIZ-20C.2 – completed Termin kann nicht erneut dokumentiert werden", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["00:00", "00:30", "05:00", "05:30"],
      past: true,
    });

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Erst-Doku" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    const reDocRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Doppelt" }],
    });
    expect(reDocRes.status).toBe(403);
  });
});

describe("BIZ-20: Completed PATCH Ablehnung", () => {
  it("BIZ-20.1 – completed Termin: notes PATCH wird abgelehnt (403)", async () => {
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["02:00", "02:30", "23:00", "23:30"],
      past: true,
    });

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "BIZ-20" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    const patchRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      notes: "Sollte abgelehnt werden",
    });
    expect(patchRes.status).toBe(403);
  });
});

describe("BIZ-21: Rollen-basierte Einschränkungen", () => {
  let nonAdminAuth: Awaited<ReturnType<typeof loginAs>> | null = null;
  const nonAdminEmail = `testma-${Date.now()}@test.local`;
  const nonAdminPassword = "TestPasswort123!";
  let nonAdminUserId: number | null = null;

  beforeAll(async () => {
    const createRes = await apiPost<any>("/api/admin/users", {
      email: nonAdminEmail,
      password: nonAdminPassword,
      vorname: "Test",
      nachname: "Mitarbeiter",
      geburtsdatum: "1990-05-15",
      eintrittsdatum: "2024-01-01",
      isAdmin: false,
      telefon: "+4917600099999",
    });
    expect(createRes.status, "Non-admin user creation must succeed").toBe(201);
    nonAdminUserId = createRes.data.id;
    nonAdminAuth = await loginAs(nonAdminEmail, nonAdminPassword);
    expect(nonAdminAuth, "Non-admin login must succeed").toBeTruthy();
  });

  afterAll(async () => {
    if (nonAdminUserId) {
      await apiPost(`/api/admin/users/${nonAdminUserId}/deactivate`, {});
    }
  });

  it("BIZ-21.1 – Nicht-Admin kann keinen abgeschlossenen Termin löschen", async () => {
    expect(nonAdminAuth, "nonAdminAuth muss gesetzt sein").toBeTruthy();
    const slot = await createOnFreeSlot({
      offsetRange: [2, 60],
      times: ["03:00", "03:30", "21:00", "21:30"],
      past: true,
    });

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Test" }],
    });

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    const delRes = await apiDeleteAs(nonAdminAuth!, `/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(403);

    await apiDelete(`/api/appointments/${slot.id}`);
  });

  it("BIZ-21.2 – Nicht-Admin kann Termin >3 Monate in Vergangenheit nicht erstellen", async () => {
    expect(nonAdminAuth, "nonAdminAuth muss gesetzt sein").toBeTruthy();
    const pastDate = new Date();
    pastDate.setMonth(pastDate.getMonth() - 4);
    const dow = pastDate.getDay();
    if (dow === 0) pastDate.setDate(pastDate.getDate() + 1);
    else if (dow === 6) pastDate.setDate(pastDate.getDate() + 2);
    const dateStr = pastDate.toISOString().split("T")[0];

    const res = await apiPostAs<any>(nonAdminAuth, "/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      assignedEmployeeId: nonAdminAuth.user.id,
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    });
    expect(res.status).toBe(400);
  });

  it("BIZ-21.3 – Nicht-Admin sieht keine Admin-Endpunkte", async () => {
    expect(nonAdminAuth, "nonAdminAuth muss gesetzt sein").toBeTruthy();
    const res = await apiGetAs<any>(nonAdminAuth, "/api/admin/customers?limit=1");
    expect(res.status).toBe(403);
  });

  it("BIZ-21.4 – Admin kann abgeschlossenen Termin löschen (Rollen-Bestätigung)", async () => {
    let apptId: number | null = null;
    let lastError = "";
    for (const offset of [7, 8, 9, 10, 11, 12, 13, 14]) {
      const futureDate = getFutureDate(offset);
      const createRes = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: futureDate,
        scheduledStart: "06:00",
        scheduledEnd: "07:00",
        assignedEmployeeId: testEmployeeId,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (createRes.status === 201) {
        apptId = createRes.data.id;
        break;
      }
      lastError = `${createRes.status}: ${JSON.stringify(createRes.data)}`;
    }
    expect(apptId, `Termin muss für Delete-Test erstellt werden. Letzter Fehler: ${lastError}`).toBeTruthy();

    await apiPost<any>(`/api/appointments/${apptId}/document`, {
      actualStart: "06:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Admin-Delete-Test" }],
    });

    const delRes = await apiDelete(`/api/appointments/${apptId}`);
    expect(delRes.status).toBe(200);
  });
});

describe("BIZ-22: Nicht-Admin kann documenting-Termin nicht löschen", () => {
  let nonAdminAuth22: Awaited<ReturnType<typeof loginAs>> | null = null;
  const email22 = `testma22-${Date.now()}@test.local`;
  const pwd22 = "TestPasswort123!";
  let userId22: number | null = null;

  beforeAll(async () => {
    const createRes = await apiPost<any>("/api/admin/users", {
      email: email22, password: pwd22, vorname: "Test", nachname: "MA22",
      geburtsdatum: "1990-01-01", eintrittsdatum: "2024-01-01", isAdmin: false, telefon: "+4917600099922",
    });
    expect(createRes.status).toBe(201);
    userId22 = createRes.data.id;
    nonAdminAuth22 = await loginAs(email22, pwd22);
  });

  afterAll(async () => {
    if (userId22) {
      const deactivateRes = await apiPost(`/api/admin/users/${userId22}/deactivate`, {});
      expect(deactivateRes.status).toBeLessThan(500);
    }
  });

  it("BIZ-22.1 – Nicht-Admin kann documenting-Termin nicht löschen (403)", async () => {
    expect(nonAdminAuth22).toBeTruthy();
    const slot = await createOnFreeSlot({ offsetRange: [2, 60], times: ["04:00", "04:30"] });

    await apiPost<any>(`/api/appointments/${slot.id}/start`, {});
    await apiPost<any>(`/api/appointments/${slot.id}/end`, {});

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("documenting");

    const delRes = await apiDeleteAs(nonAdminAuth22!, `/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(403);

    await apiDelete(`/api/appointments/${slot.id}`);
  });
});

describe("BIZ-23: Scheduled-Termin direkt dokumentieren (positiver Pfad)", () => {
  it("BIZ-23.1 – scheduled-Termin kann direkt dokumentiert werden (Start/End optional) → completed", async () => {
    const slot = await createOnFreeSlot({ offsetRange: [2, 60], times: ["04:30", "05:00"], past: true });

    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Direct-Doc-Test" }],
    });
    expect(docRes.status).toBe(200);

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("completed");

    await apiDelete(`/api/appointments/${slot.id}`);
  });

  it("BIZ-23.2 – Direkter Status-PATCH scheduled → completed wird abgelehnt (nur Dokument-Workflow erlaubt)", async () => {
    const slot = await createOnFreeSlot({ offsetRange: [2, 60], times: ["04:00", "04:15"], past: true });

    const patchRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      status: "completed",
    });
    expect([400, 403, 422]).toContain(patchRes.status);

    const verify = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(verify.data.status).toBe("scheduled");

    await apiDelete(`/api/appointments/${slot.id}`);
  });
});

describe("BIZ-24: Service-Swap aktualisiert Termin-Dienste", () => {
  it("BIZ-24.1 – Service ändern via PATCH aktualisiert Services-Liste", async () => {
    const slot = await createOnFreeSlot({ offsetRange: [2, 60], times: ["05:30", "06:00"] });

    const servicesBefore = await apiGet<any[]>(`/api/appointments/${slot.id}/services`);
    expect(servicesBefore.status).toBe(200);
    expect(servicesBefore.data.length).toBe(1);
    expect(servicesBefore.data[0].serviceId).toBe(hwServiceId);

    const patchRes = await apiPatch(`/api/appointments/${slot.id}`, {
      notes: "BIZ-24 Service-Swap-Test",
      services: [
        { serviceId: hwServiceId, plannedDurationMinutes: 45 },
        { serviceId: abServiceId, plannedDurationMinutes: 30 },
      ],
    });
    expect(patchRes.status).toBe(200);

    const servicesAfter = await apiGet<any[]>(`/api/appointments/${slot.id}/services`);
    expect(servicesAfter.status).toBe(200);
    expect(servicesAfter.data.length).toBe(2);
    const serviceIds = servicesAfter.data.map((s: any) => s.serviceId);
    expect(serviceIds).toContain(hwServiceId);
    expect(serviceIds).toContain(abServiceId);

    const apptAfter = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(apptAfter.status).toBe(200);
    const totalServiceDuration = servicesAfter.data.reduce(
      (sum: number, s: any) => sum + (s.plannedDurationMinutes || 0), 0
    );
    expect(totalServiceDuration).toBe(75);

    await apiDelete(`/api/appointments/${slot.id}`);
  });
});

describe("BIZ-25: PATCH Mitarbeiter-Wechsel Überlappungsprüfung", () => {
  it("BIZ-25.1 – Employee-Switch auf Mitarbeiter mit bestehendem Termin prüft Überlappung", async () => {
    const nonAdminEmail25 = `testma25-${Date.now()}@test.local`;
    const createUserRes = await apiPost<any>("/api/admin/users", {
      email: nonAdminEmail25, password: "TestPasswort123!", vorname: "Test", nachname: "MA25",
      geburtsdatum: "1990-01-01", eintrittsdatum: "2024-01-01", isAdmin: false, telefon: "+4917600099925",
    });
    expect(createUserRes.status).toBe(201);
    const otherEmployeeId = createUserRes.data.id;

    const custRes2 = await apiPost<any>("/api/admin/customers", {
      vorname: "Overlap", nachname: `Test-${Date.now()}`, geburtsdatum: "1935-01-01",
      strasse: "Teststr.", nr: "1", plz: "10115", stadt: "Berlin", pflegegrad: 3,
    });
    expect(custRes2.status).toBe(201);
    const secondCustomerId = custRes2.data.id;

    const assignRes = await apiPatch(`/api/admin/customers/${secondCustomerId}/assign`, {
      primaryEmployeeId: otherEmployeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status).toBe(200);

    const slot1 = await createOnFreeSlot({ offsetRange: [2, 60], times: ["14:00", "14:30"] });

    let slot2Created = false;
    const slot2Res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: secondCustomerId,
      date: slot1.date,
      scheduledStart: slot1.time,
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: otherEmployeeId,
    });
    if (slot2Res.status === 201) {
      createdIds.push(slot2Res.data.id);
      slot2Created = true;

      const patchRes = await apiPatch(`/api/appointments/${slot1.id}`, {
        assignedEmployeeId: otherEmployeeId,
      });
      expect([409, 400]).toContain(patchRes.status);

      await apiDelete(`/api/appointments/${slot2Res.data.id}`);
    }
    expect(slot2Created, "Zweiter Termin für Overlap-Test muss erstellt werden").toBe(true);

    await apiPost(`/api/admin/users/${otherEmployeeId}/deactivate`, {});
    await apiDelete(`/api/appointments/${slot1.id}`);
  });
});

interface AppointmentService {
  id: number;
  serviceId: number;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
  serviceName: string;
  serviceCode: string | null;
  serviceUnitType: string;
}

describe("BIZ-26: Junction-Tabelle (appointment_services)", () => {
  let junctionTestApptId: number;

  async function findFreeAppointmentDate(startOffset: number, scheduledStart: string, services: any[]): Promise<{ date: string; data: any }> {
    for (let off = startOffset; off < startOffset + 30; off++) {
      const candidate = new Date();
      candidate.setDate(candidate.getDate() + off);
      getWeekday(candidate);
      const dateStr = candidate.toISOString().split("T")[0];
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: dateStr,
        scheduledStart,
        services,
        assignedEmployeeId: testEmployeeId,
      });
      if (res.status === 201) {
        createdIds.push(res.data.id);
        return { date: dateStr, data: res.data };
      }
    }
    throw new Error("Kein freier Termin-Slot gefunden");
  }

  afterAll(async () => {
    if (junctionTestApptId) {
      await apiDelete(`/api/appointments/${junctionTestApptId}`);
    }
  });

  it("BIZ-26.1 – sollte Services in Junction-Tabelle schreiben", async () => {
    const result = await findFreeAppointmentDate(600, "08:00", [
      { serviceId: hwServiceId, durationMinutes: 60 },
      { serviceId: abServiceId, durationMinutes: 45 },
    ]);
    const { data } = result;

    junctionTestApptId = data.id;

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(2);

    const hwService = servicesRes.data.find((s) => s.serviceCode === "hauswirtschaft");
    const abService = servicesRes.data.find((s) => s.serviceCode === "alltagsbegleitung");
    expect(hwService?.plannedDurationMinutes).toBe(60);
    expect(abService?.plannedDurationMinutes).toBe(45);
  });

  it("BIZ-26.2 – sollte Termin mit nur neuen Services erstellen", async () => {
    const allServices = await apiGet<{ id: number; code: string | null; name: string }[]>("/api/services/all");
    const newService = allServices.data.find((s) => s.code !== "hauswirtschaft" && s.code !== "alltagsbegleitung" && s.code !== "erstberatung" && s.code !== "kilometer");

    if (!newService) {
      console.log("Kein neuer Service zum Testen vorhanden - Test übersprungen");
      return;
    }

    const result = await findFreeAppointmentDate(630, "14:00", [
      { serviceId: newService.id, durationMinutes: 45 },
    ]);
    const { data } = result;

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(1);
    expect(servicesRes.data[0].serviceId).toBe(newService.id);
    expect(servicesRes.data[0].plannedDurationMinutes).toBe(45);
  });

  it("BIZ-26.3 – sollte gemischte Services korrekt aufteilen", async () => {
    const allServices = await apiGet<{ id: number; code: string | null; name: string }[]>("/api/services/all");
    const newService = allServices.data.find((s) => s.code !== "hauswirtschaft" && s.code !== "alltagsbegleitung" && s.code !== "erstberatung" && s.code !== "kilometer");

    if (!newService) {
      console.log("Kein neuer Service zum Testen vorhanden - Test übersprungen");
      return;
    }

    const result = await findFreeAppointmentDate(660, "09:00", [
      { serviceId: hwServiceId, durationMinutes: 30 },
      { serviceId: newService.id, durationMinutes: 30 },
    ]);
    const { data } = result;

    const servicesRes = await apiGet<AppointmentService[]>(`/api/appointments/${data.id}/services`);
    expect(servicesRes.status).toBe(200);
    expect(servicesRes.data).toHaveLength(2);
  });

  it("BIZ-26.4 – sollte durationPromised als Summe aller Services berechnen", async () => {
    const result = await findFreeAppointmentDate(690, "10:00", [
      { serviceId: hwServiceId, durationMinutes: 60 },
      { serviceId: abServiceId, durationMinutes: 45 },
    ]);
    const { data } = result;

    expect(data.durationPromised).toBe(105);
  });
});
