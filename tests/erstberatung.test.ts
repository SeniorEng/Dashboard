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
let prospectId: number;
let erstberatungId: number;
const cleanupIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
});

describe("EB-1: Prospect (Interessent) erstellen (inline)", () => {
  const nachname = "EB-Test-" + uniqueId();

  it("EB-1.1 – Interessent inline erstellen", async () => {
    const res = await apiPost<any>("/api/prospects/inline", {
      vorname: "Erika",
      nachname,
      telefon: "+4917612345678",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.vorname).toBe("Erika");
    expect(res.data.status).toBe("erstberatung_vereinbart");
    prospectId = res.data.id;
  });

  it("EB-1.2 – Prospect Termindaten abrufen", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/prospects/${prospectId}/appointment-data`);
    expect(res.status).toBe(200);
  });

  it("EB-1.3 – Prospect Kontaktdaten aktualisieren", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/prospects/${prospectId}`, {
      telefon: "+4917699887766",
    });
    expect(res.status).toBe(200);
  });
});

describe("EB-2: Erstberatung-Termin erstellen", () => {
  const ebDate = getFutureDate(18);

  it("EB-2.1 – Erstberatung (prospect-erstberatung) erstellen", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();

    const timeSlots = ["07:00", "16:00", "17:00", "06:30", "18:00"];
    const dates = [getFutureDate(18), getFutureDate(19), getFutureDate(21)];
    let res: any = null;

    outer:
    for (const date of dates) {
      for (const time of timeSlots) {
        res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
          prospectId,
          date,
          scheduledStart: time,
          erstberatungDauer: 90,
          assignedEmployeeId: auth.user.id,
          notes: "Erstberatung für Prospect " + prospectId,
        });
        if (res.status === 201) break outer;
      }
    }

    expect(res?.status).toBe(201);
    const appt = res.data.appointment || res.data;
    expect(appt).toHaveProperty("id");
    expect(appt.appointmentType.toLowerCase()).toBe("erstberatung");
    erstberatungId = appt.id;
    cleanupIds.push(erstberatungId);
  });

  it("EB-2.2 – Erstberatung am Wochenende wird abgelehnt", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat);
    const satStr = sat.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      prospectId,
      date: satStr,
      scheduledStart: "10:00",
      erstberatungDauer: 60,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("EB-2.3 – Erstberatung abrufen zeigt richtigen Typ", async () => {
    expect(erstberatungId, "erstberatungId muss aus EB-2.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointments/${erstberatungId}`);
    expect(res.status).toBe(200);
    expect(res.data.appointmentType.toLowerCase()).toBe("erstberatung");
  });

  it("EB-2.4 – Erstberatung mit ungültiger Dauer (10 Min) wird abgelehnt", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      prospectId,
      date: getFutureDate(19),
      scheduledStart: "14:00",
      erstberatungDauer: 10,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("EB-2.5 – Erstberatung mit nicht-15er Vielfaches wird abgelehnt", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      prospectId,
      date: getFutureDate(19),
      scheduledStart: "14:00",
      erstberatungDauer: 40,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});
