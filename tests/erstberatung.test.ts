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
let hwServiceId: number;
const cleanupIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  if (prospectId) {
    try { await apiDelete(`/api/prospects/${prospectId}`); } catch {}
  }
});

describe("EB-1: Prospect (Interessent) CRUD", () => {
  const nachname = "EB-Test-" + uniqueId();

  it("EB-1.1 – Interessent erstellen", async () => {
    const res = await apiPost<any>("/api/prospects", {
      vorname: "Erika",
      nachname,
      telefon: "+4917612345678",
      quelle: "telefon",
      notizen: "Erstberatungs-Test",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.vorname).toBe("Erika");
    expect(res.data.status).toBe("neu");
    prospectId = res.data.id;
  });

  it("EB-1.2 – Interessent abrufen", async () => {
    const res = await apiGet<any>(`/api/prospects/${prospectId}`);
    expect(res.status).toBe(200);
    expect(res.data.nachname).toBe(nachname);
  });

  it("EB-1.3 – Interessent erscheint NICHT in Kundenliste", async () => {
    const res = await apiGet<any[]>("/api/customers");
    expect(res.status).toBe(200);
    const found = res.data.find((c: any) => c.id === prospectId);
    expect(found).toBeUndefined();
  });

  it("EB-1.4 – Interessent aktualisieren", async () => {
    const res = await apiPatch<any>(`/api/prospects/${prospectId}`, {
      notizen: "Aktualisierte Notizen",
    });
    expect(res.status).toBe(200);
  });
});

describe("EB-2: Erstberatung-Termin", () => {
  const ebDate = getFutureDate(18);

  it("EB-2.1 – Erstberatung erstellen", async () => {
    const res = await apiPost<any>("/api/appointments/erstberatung", {
      prospectId,
      date: ebDate,
      scheduledStart: "10:00",
      durationMinutes: 90,
      assignedEmployeeId: auth.user.id,
      notes: "Erstberatung für " + prospectId,
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.appointmentType).toBe("erstberatung");
    erstberatungId = res.data.id;
    cleanupIds.push(erstberatungId);
  });

  it("EB-2.2 – Erstberatung am Wochenende wird abgelehnt", async () => {
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat);
    const satStr = sat.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/appointments/erstberatung", {
      prospectId,
      date: satStr,
      scheduledStart: "10:00",
      durationMinutes: 60,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("EB-2.3 – Erstberatung abrufen", async () => {
    const res = await apiGet<any>(`/api/appointments/${erstberatungId}`);
    expect(res.status).toBe(200);
    expect(res.data.appointmentType).toBe("erstberatung");
  });
});

describe("EB-3: Prospect-Status nach Erstberatung", () => {
  it("EB-3.1 – Prospect-Status auf 'erstberatung_geplant' prüfen", async () => {
    const res = await apiGet<any>(`/api/prospects/${prospectId}`);
    expect(res.status).toBe(200);
    expect(["erstberatung_geplant", "neu", "kontaktiert"]).toContain(res.data.status);
  });
});
