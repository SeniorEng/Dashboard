import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getFutureDate,
  getPastDate,
  getAuthCookie,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let hwServiceId: number;
let completedAppointmentId: number | null = null;
let serviceRecordId: number | null = null;
const cleanupApptIds: number[] = [];

function getWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
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
  if (serviceRecordId) {
    try { await apiDelete(`/api/service-records/${serviceRecordId}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
});

describe("LN-1: Grundlegende Endpunkte", () => {
  it("LN-1.1 – GET /service-records liefert ein Array", async () => {
    const res = await apiGet<any>("/api/service-records");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data) || Array.isArray(res.data?.data)).toBe(true);
  });

  it("LN-1.2 – GET /service-records/overview liefert Monatsübersicht", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/service-records/overview?year=${now.getFullYear()}&month=${now.getMonth() + 1}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  });

  it("LN-1.3 – GET /service-records/pending liefert offene Leistungsnachweise", async () => {
    const res = await apiGet<any>("/api/service-records/pending");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data) || typeof res.data === "object").toBe(true);
  });
});

describe("LN-2: Periodenprüfung", () => {
  it("LN-2.1 – check-period liefert documented/undocumented Zähler", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${now.getFullYear()}&month=${now.getMonth() + 1}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("documentedCount");
    expect(res.data).toHaveProperty("undocumentedCount");
    expect(typeof res.data.documentedCount).toBe("number");
    expect(typeof res.data.undocumentedCount).toBe("number");
  });
});

describe("LN-3: Einzeltermin-Leistungsnachweis erstellen & unterschreiben", () => {
  it("LN-3.1 – Termin erstellen und dokumentieren", async () => {
    const timeSlots = ["06:00", "06:30", "18:00", "18:30", "19:00"];
    let createRes: any = null;
    let success = false;

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
        if (createRes.status === 201) {
          success = true;
          break;
        }
      }
      if (success) break;
    }

    expect(success, "Termin muss erfolgreich erstellt werden").toBe(true);
    completedAppointmentId = createRes.data.id;
    cleanupApptIds.push(completedAppointmentId!);

    const docRes = await apiPost<any>(`/api/appointments/${completedAppointmentId}/document`, {
      actualStart: "06:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "LN-Test" }],
    });
    expect(docRes.status).toBe(200);
  });

  it("LN-3.2 – Einzeltermin-Leistungsnachweis erstellen", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss aus LN-3.1 gesetzt sein").toBeTruthy();

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: completedAppointmentId,
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data).toHaveProperty("status");
    expect(res.data.status).toBe("pending");
    serviceRecordId = res.data.id;
  });

  it("LN-3.3 – Leistungsnachweis abrufen zeigt korrekten Status", async () => {
    expect(serviceRecordId, "serviceRecordId muss aus LN-3.2 gesetzt sein").toBeTruthy();

    const res = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(serviceRecordId);
    expect(res.data.status).toBe("pending");
  });

  it("LN-3.4 – Verknüpfte Termine abrufen enthält den dokumentierten Termin", async () => {
    expect(serviceRecordId, "serviceRecordId muss aus LN-3.2 gesetzt sein").toBeTruthy();

    const res = await apiGet<any>(`/api/service-records/${serviceRecordId}/appointments`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data), "Termine-Endpunkt gibt ein Array zurück").toBe(true);
    const appts = res.data as any[];
    const found = appts.find((a: any) => a.id === completedAppointmentId);
    expect(found, "Der dokumentierte Termin muss in der Liste enthalten sein").toBeDefined();
  });

  it("LN-3.5 – Kundenunterschrift VOR Mitarbeiter wird abgelehnt", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "customer",
      signingLocation: "Vor Ort",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("LN-3.6 – Mitarbeiterunterschrift setzt Status auf employee_signed", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "employee",
      signingLocation: "Vor Ort",
    });
    expect([200, 201]).toContain(res.status);

    const fetchRes = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(fetchRes.data.status).toBe("employee_signed");
  });

  it("LN-3.7 – Doppelte Mitarbeiterunterschrift wird abgelehnt", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "employee",
      signingLocation: "Vor Ort",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("LN-3.8 – Kundenunterschrift nach Mitarbeiter setzt Status auf completed", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "customer",
      signingLocation: "Vor Ort",
    });
    expect([200, 201]).toContain(res.status);

    const fetchRes = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(fetchRes.data.status).toBe("completed");
  });
});

describe("LN-4: Gesperrte Termine nach Unterschrift", () => {
  it("LN-4.1 – Termin in unterschriebenem LN kann nicht bearbeitet werden", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();

    const res = await apiPatch<any>(`/api/appointments/${completedAppointmentId}`, {
      scheduledStart: "08:00",
    });
    expect([400, 403]).toContain(res.status);
  });
});

describe("LN-5: Kunden-Leistungsnachweise", () => {
  it("LN-5.1 – Leistungsnachweise für Kunden abrufen enthält erstellten LN", async () => {
    const res = await apiGet<any>(`/api/service-records/customer/${testCustomerId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data), "Kunden-LN Endpunkt gibt ein Array zurück").toBe(true);
    const records = res.data as any[];
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();
    const found = records.find((r: any) => r.id === serviceRecordId);
    expect(found, "Erstellter LN muss in Kundenliste erscheinen").toBeDefined();
  });
});

describe("LN-6: Duplikat-Erkennung", () => {
  it("LN-6.1 – Zweiter LN für denselben Termin wird abgelehnt", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: completedAppointmentId,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
