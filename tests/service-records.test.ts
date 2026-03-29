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

async function createAndDocumentAppointment(timeSlots: string[], offsetRange: [number, number]): Promise<number | null> {
  for (let offset = offsetRange[0]; offset <= offsetRange[1]; offset++) {
    const candidate = new Date();
    candidate.setDate(candidate.getDate() - offset);
    getWeekday(candidate);
    const dateStr = candidate.toISOString().split("T")[0];

    for (const time of timeSlots) {
      const createRes = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: testCustomerId,
        date: dateStr,
        scheduledStart: time,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
        assignedEmployeeId: auth.user.id,
      });
      if (createRes.status === 201) {
        cleanupApptIds.push(createRes.data.id);
        const docRes = await apiPost<any>(`/api/appointments/${createRes.data.id}/document`, {
          actualStart: time,
          travelOriginType: "home",
          travelKilometers: 0,
          customerKilometers: 0,
          services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "LN-Test" }],
        });
        if (docRes.status === 200) {
          return createRes.data.id;
        }
      }
    }
  }
  return null;
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

  it("LN-2.2 – check-period: canCreateRecord hängt von undocumentedCount ab", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${now.getFullYear()}&month=${now.getMonth() + 1}`
    );
    expect(res.status).toBe(200);
    expect(typeof res.data.undocumentedCount).toBe("number");
    expect(typeof res.data.canCreateRecord).toBe("boolean");
  });
});

describe("LN-3: Einzeltermin-Leistungsnachweis erstellen & unterschreiben", () => {
  it("LN-3.1 – Termin erstellen und dokumentieren", async () => {
    completedAppointmentId = await createAndDocumentAppointment(
      ["06:00", "06:30", "18:00", "18:30", "19:00"],
      [2, 60]
    );
    expect(completedAppointmentId, "Termin muss erfolgreich erstellt und dokumentiert werden").toBeTruthy();

    const fetchRes = await apiGet<any>(`/api/appointments/${completedAppointmentId}`);
    expect(fetchRes.data.status).toBe("completed");
  });

  it("LN-3.2 – Einzeltermin-Leistungsnachweis erstellen (201, status=pending)", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss aus LN-3.1 gesetzt sein").toBeTruthy();

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: completedAppointmentId,
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
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

  it("LN-3.4 – Verknüpfte Termine enthält den dokumentierten Termin", async () => {
    expect(serviceRecordId, "serviceRecordId muss aus LN-3.2 gesetzt sein").toBeTruthy();

    const res = await apiGet<any>(`/api/service-records/${serviceRecordId}/appointments`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    const found = (res.data as any[]).find((a: any) => a.id === completedAppointmentId);
    expect(found, "Dokumentierter Termin muss in LN-Terminliste enthalten sein").toBeDefined();
  });

  it("LN-3.5 – Kundenunterschrift VOR Mitarbeiter wird abgelehnt", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "customer",
      signingLocation: "Vor Ort",
    });
    expect(res.status).toBe(400);
  });

  it("LN-3.6 – Mitarbeiterunterschrift setzt Status auf employee_signed", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "employee",
      signingLocation: "Vor Ort",
    });
    expect(res.status).toBe(200);

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
    expect(res.status).toBe(400);
  });

  it("LN-3.8 – Kundenunterschrift nach Mitarbeiter setzt Status auf completed", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>(`/api/service-records/${serviceRecordId}/sign`, {
      signatureData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      signerType: "customer",
      signingLocation: "Vor Ort",
    });
    expect(res.status).toBe(200);

    const fetchRes = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(fetchRes.data.status).toBe("completed");
  });
});

describe("LN-4: Gesperrte Termine nach Unterschrift", () => {
  it("LN-4.1 – Termin in unterschriebenem LN: PATCH wird abgelehnt", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();

    const res = await apiPatch<any>(`/api/appointments/${completedAppointmentId}`, {
      scheduledStart: "08:00",
    });
    expect(res.status).toBe(403);
  });

  it("LN-4.2 – Termin in unterschriebenem LN: Re-Dokumentation wird abgelehnt (403)", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();

    const recRes = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(["completed", "employee_signed"]).toContain(recRes.data.status);

    const docRes = await apiPost<any>(`/api/appointments/${completedAppointmentId}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Locked test" }],
    });
    expect(docRes.status).toBe(403);
  });
});

describe("LN-5: Kunden-Leistungsnachweise", () => {
  it("LN-5.1 – Leistungsnachweise für Kunden enthält erstellten LN", async () => {
    const res = await apiGet<any>(`/api/service-records/customer/${testCustomerId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();
    const found = (res.data as any[]).find((r: any) => r.id === serviceRecordId);
    expect(found, "Erstellter LN muss in Kundenliste erscheinen").toBeDefined();
  });
});

describe("LN-6: Duplikat-Erkennung", () => {
  it("LN-6.1 – Zweiter LN für denselben Termin wird abgelehnt (409)", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: completedAppointmentId,
    });
    expect(res.status).toBe(409);
  });
});

describe("LN-7: Nicht-dokumentierter Termin blockiert LN", () => {
  it("LN-7.1 – LN für scheduled Termin wird abgelehnt (400)", async () => {
    const futureDate = getFutureDate(290);
    const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: futureDate,
      scheduledStart: "09:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(apptRes.status).toBe(201);
    cleanupApptIds.push(apptRes.data.id);

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: apptRes.data.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("LN-8: LN-Status nach Unterschriften", () => {
  it("LN-8.1 – LN-Status completed nach vollständiger Unterschrift", async () => {
    expect(serviceRecordId, "serviceRecordId muss gesetzt sein").toBeTruthy();
    const res = await apiGet<any>(`/api/service-records/${serviceRecordId}`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("completed");
  });
});

describe("LN-9: Monatlicher Leistungsnachweis", () => {
  it("LN-9.1 – check-period für Kunden prüfen", async () => {
    const now = new Date();
    const prevMonth = new Date(now);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const res = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${prevMonth.getFullYear()}&month=${prevMonth.getMonth() + 1}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("canCreateRecord");
    expect(res.data).toHaveProperty("documentedCount");
    expect(res.data).toHaveProperty("undocumentedCount");
    expect(res.data).toHaveProperty("uncoveredDocumentedCount");
  });

  it("LN-9.1B – check-period für zukünftigen Monat ohne Termine", async () => {
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 10);
    const year = futureDate.getFullYear();
    const month = futureDate.getMonth() + 1;

    const checkRes = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${year}&month=${month}`
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.canCreateRecord).toBe(false);
    expect(checkRes.data.documentedCount).toBe(0);
  });

  it("LN-9.1C – Monatlicher LN-Endpoint akzeptiert Aufruf und liefert 200/201", async () => {
    const createRes = await apiPost<any>("/api/service-records/monthly", {
      customerId: testCustomerId,
      year: 2020,
      month: 1,
    });
    expect([200, 201]).toContain(createRes.status);
  });

  it("LN-9.2 – Monatlicher LN blockiert wenn undokumentierte Termine vorhanden", async () => {
    const futureDate = getFutureDate(291);
    const createRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: futureDate,
      scheduledStart: "07:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(createRes.status).toBe(201);
    cleanupApptIds.push(createRes.data.id);

    const d = new Date(futureDate);
    const checkRes = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${d.getFullYear()}&month=${d.getMonth() + 1}`
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.undocumentedCount).toBeGreaterThan(0);
    expect(checkRes.data.canCreateRecord).toBe(false);
  });
});

describe("LN-10: In-progress Termin blockiert LN", () => {
  it("LN-10.1 – LN für documenting-Status Termin wird abgelehnt (400)", async () => {
    const futureDate = getFutureDate(292);
    const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: futureDate,
      scheduledStart: "08:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(apptRes.status).toBe(201);
    cleanupApptIds.push(apptRes.data.id);

    await apiPost<any>(`/api/appointments/${apptRes.data.id}/start`, {});
    await apiPost<any>(`/api/appointments/${apptRes.data.id}/end`, {});

    const verify = await apiGet<any>(`/api/appointments/${apptRes.data.id}`);
    expect(verify.data.status).toBe("documenting");

    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: apptRes.data.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("LN-12: Monatlicher LN – Erstellung und Blocking", () => {
  it("LN-12.1 – Monatlicher LN ohne dokumentierte Termine wird abgelehnt", async () => {
    const now = new Date();
    const futureMonth = now.getMonth() + 4;
    const year = futureMonth > 12 ? now.getFullYear() + 1 : now.getFullYear();
    const month = futureMonth > 12 ? futureMonth - 12 : futureMonth;

    const res = await apiPost<any>("/api/service-records", {
      customerId: testCustomerId,
      year,
      month,
    });
    expect(res.status).toBe(400);
  });
});

describe("LN-11: Signatur-Daten Validierung", () => {
  it("LN-11.1 – Unterschrift ohne signatureData wird abgelehnt", async () => {
    const apptId = await createAndDocumentAppointment(
      ["04:00", "04:30", "21:00", "21:30"],
      [2, 60]
    );
    expect(apptId, "Termin muss für LN-11 erstellt und dokumentiert werden").toBeTruthy();

    const lnRes = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: apptId,
    });
    expect(lnRes.status, "LN muss für Signatur-Test erstellt werden").toBe(201);

    const signRes = await apiPost<any>(`/api/service-records/${lnRes.data.id}/sign`, {
      signerType: "employee",
      signingLocation: "Vor Ort",
    });
    expect(signRes.status).toBe(400);
  });
});
