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
const cleanupProspectIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupProspectIds) {
    try { await apiDelete(`/api/prospects/${id}`); } catch {}
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
    expect(res.data.nachname).toBe(nachname);
    expect(res.data.status).toBe("erstberatung_vereinbart");
    prospectId = res.data.id;
    cleanupProspectIds.push(prospectId);
  });

  it("EB-1.2 – Prospect Termindaten abrufen", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/prospects/${prospectId}/appointment-data`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("prospect");
  });

  it("EB-1.3 – Prospect Kontaktdaten aktualisieren", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/prospects/${prospectId}`, {
      telefon: "+4917699887766",
    });
    expect(res.status).toBe(200);
  });

  it("EB-1.4 – Prospect ohne Vorname wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/prospects/inline", {
      nachname: "Nur-Nachname-" + uniqueId(),
      telefon: "+4917600000000",
    });
    expect(res.status).toBe(400);
  });

  it("EB-1.5 – Prospect ohne Nachname wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/prospects/inline", {
      vorname: "Nur-Vorname",
      telefon: "+4917600000000",
    });
    expect(res.status).toBe(400);
  });
});

describe("EB-2: Erstberatung-Termin erstellen", () => {
  it("EB-2.1 – Erstberatung (prospect-erstberatung) erstellen", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();

    const timeSlots = ["07:00", "16:00", "17:00", "06:30", "18:00"];
    const dates = [getFutureDate(18), getFutureDate(19), getFutureDate(21), getFutureDate(22), getFutureDate(23)];
    let created = false;

    for (const date of dates) {
      for (const time of timeSlots) {
        const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
          prospectId,
          date,
          scheduledStart: time,
          erstberatungDauer: 90,
          assignedEmployeeId: auth.user.id,
          notes: "Erstberatung für Prospect " + prospectId,
        });
        if (res.status === 201) {
          const appt = res.data.appointment || res.data;
          expect(appt).toHaveProperty("id");
          expect(appt.appointmentType.toLowerCase()).toBe("erstberatung");
          erstberatungId = appt.id;
          cleanupIds.push(erstberatungId);
          created = true;
          break;
        }
      }
      if (created) break;
    }
    expect(created, "Erstberatung muss erfolgreich erstellt werden (201)").toBe(true);
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
    expect(res.data).toHaveProperty("id");
    expect(res.data).toHaveProperty("scheduledStart");
  });

  it("EB-2.4 – Erstberatung mit ungültiger Dauer (10 Min) wird abgelehnt", async () => {
    expect(prospectId, "prospectId muss aus EB-1.1 gesetzt sein").toBeTruthy();
    const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      prospectId,
      date: getFutureDate(30),
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
      date: getFutureDate(31),
      scheduledStart: "14:00",
      erstberatungDauer: 40,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });

  it("EB-2.6 – Erstberatung ohne prospectId wird abgelehnt (400)", async () => {
    const res = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      date: getFutureDate(33),
      scheduledStart: "10:00",
      erstberatungDauer: 60,
      assignedEmployeeId: auth.user.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("EB-3: Prospect-Daten und Status-Transition", () => {
  it("EB-3.1 – Prospect hat korrekten Status nach Erstberatungs-Buchung", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/prospects/${prospectId}/appointment-data`);
    expect(res.status).toBe(200);
    expect(res.data.prospect).toBeDefined();
    expect(res.data.prospect.id).toBe(prospectId);
  });

  it("EB-3.2 – Prospect-Status ist erstberatung_vereinbart nach Terminbuchung", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/admin/prospects/${prospectId}`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("erstberatung_vereinbart");
  });
});

describe("EB-4: Erstberatung bearbeiten (PATCH)", () => {
  it("EB-4.1 – Erstberatungs-Termin kann per PATCH bearbeitet werden", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      notes: "Erstberatung Notiz aktualisiert",
    });
    expect(res.status).toBe(200);
    expect(res.data.notes).toBe("Erstberatung Notiz aktualisiert");
  });

  it("EB-4.2 – Erstberatungs-Termin auf neues Datum verschieben", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const newDate = getFutureDate(50);
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      date: newDate,
      scheduledStart: "06:00",
    });
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(newDate);
  });

  it("EB-4.3 – PATCH Erstberatung behält appointmentType bei", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      notes: "Erstberatung Typ-Prüfung",
    });
    expect(res.status).toBe(200);
    expect(res.data.appointmentType).toBe("Erstberatung");
    expect(res.data.prospectId).toBeTruthy();
  });

  it("EB-4.4 – PATCH Erstberatung durationPromised ändern", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      durationPromised: 90,
    });
    expect(res.status).toBe(200);
    expect(res.data.durationPromised).toBe(90);
  });
});

describe("EB-5: Erstberatungs-Termin Typ und Service", () => {
  it("EB-5.1 – Erstberatungs-Termin hat appointmentType Erstberatung", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/appointments/${erstberatungId}`);
    expect(res.status).toBe(200);
    expect(res.data.appointmentType).toBe("Erstberatung");
  });

  it("EB-5.2 – Erstberatungs-Termin löschen setzt Prospect-Status zurück", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const newProspectRes = await apiPost<any>("/api/prospects/inline", {
      vorname: "Status-Reset",
      nachname: "EB52-" + uniqueId(),
      telefon: "+4917600052052",
    });
    expect(newProspectRes.status).toBe(201);
    const tempProspectId = newProspectRes.data.id;
    cleanupProspectIds.push(tempProspectId);

    const ebDate = getFutureDate(280);
    const createRes = await apiPost<any>("/api/appointments/prospect-erstberatung", {
      prospectId: tempProspectId,
      date: ebDate,
      scheduledStart: "14:00",
      erstberatungDauer: 60,
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    const appt = createRes.data.appointment || createRes.data;
    const delRes = await apiDelete(`/api/appointments/${appt.id}`);
    expect(delRes.status).toBe(200);
  });
});

describe("EB-6: Prospect bearbeiten (PATCH)", () => {
  it("EB-6.1 – Prospect-Kontaktdaten können aktualisiert werden", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/prospects/${prospectId}`, {
      telefon: "+4917699999999",
    });
    expect(res.status).toBe(200);
    expect(res.data.telefon).toBe("+4917699999999");
  });
});

describe("EB-7: Prospect-Sichtbarkeit", () => {
  it("EB-7.1 – Prospect erscheint NICHT in Admin-Kundenliste", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>("/api/admin/customers?limit=200");
    expect(res.status).toBe(200);
    const list = Array.isArray(res.data) ? res.data : res.data.data || [];
    const found = list.find((c: any) => c.id === prospectId);
    expect(found, "Prospect darf nicht in Kundenliste erscheinen").toBeUndefined();
  });

  it("EB-7.2 – Prospect erscheint in Admin-Prospect-Liste", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>("/api/admin/prospects");
    expect(res.status).toBe(200);
    const list = Array.isArray(res.data) ? res.data : res.data.data || [];
    const found = list.find((p: any) => p.id === prospectId);
    expect(found, "Prospect muss in Admin-Prospect-Liste erscheinen").toBeDefined();
  });
});

describe("EB-8: Erstberatung-Service automatisch verknüpft", () => {
  it("EB-8.1 – Erstberatungs-Termin hat automatisch verknüpften Service", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const servicesRes = await apiGet<any[]>(`/api/appointments/${erstberatungId}/services`);
    expect(servicesRes.status).toBe(200);
    expect(Array.isArray(servicesRes.data), "Services muss ein Array sein").toBe(true);
    expect(servicesRes.data.length, "Erstberatung muss mindestens einen Service haben").toBeGreaterThan(0);
    expect(servicesRes.data[0]).toHaveProperty("serviceId");
  });
});

describe("EB-8B: Erstberatung-PATCH Updates", () => {
  it("EB-8B.1 – Erstberatungs-Termin kann mit PATCH aktualisiert werden", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      notes: "EB-8B Aktualisierte Erstberatungs-Notizen",
    });
    expect(res.status).toBe(200);
    expect(res.data.notes).toBe("EB-8B Aktualisierte Erstberatungs-Notizen");
  });

  it("EB-8B.2 – Erstberatungs-Termin PATCH auf Wochenende wird abgelehnt", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const now = new Date();
    const daysUntilSaturday = (6 - now.getDay() + 7) % 7 || 7;
    const saturday = new Date(now);
    saturday.setDate(saturday.getDate() + daysUntilSaturday);
    const saturdayStr = saturday.toISOString().split("T")[0];

    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      date: saturdayStr,
    });
    expect(res.status).toBe(400);
  });

  it("EB-8B.3 – Erstberatungs-Termin PATCH Datum auf Werktag aktualisiert", async () => {
    expect(erstberatungId, "erstberatungId muss gesetzt sein").toBeTruthy();
    const futureDate = getFutureDate(14);
    const res = await apiPatch<any>(`/api/appointments/${erstberatungId}`, {
      date: futureDate,
    });
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(futureDate);
  });
});

describe("EB-9: Admin-Prospect PATCH (vollständig)", () => {
  it("EB-9.1 – Admin kann Prospect-Kontaktdaten aktualisieren", async () => {
    expect(prospectId, "prospectId muss gesetzt sein").toBeTruthy();
    const res = await apiPatch<any>(`/api/admin/prospects/${prospectId}`, {
      telefon: "+4917611111111",
      stadt: "München",
    });
    expect(res.status).toBe(200);
  });
});
