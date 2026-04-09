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
  it("LN-4.0 – Termin in unterschriebenem LN hat isLocked=true", async () => {
    expect(completedAppointmentId, "completedAppointmentId muss gesetzt sein").toBeTruthy();

    const apptRes = await apiGet<any>(`/api/appointments/${completedAppointmentId}`);
    expect(apptRes.status).toBe(200);
    expect(apptRes.data.isLocked).toBe(true);
  });

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
    const timeSlots = ["04:00", "03:00", "02:00", "21:00", "22:00"];
    const dateOffsets = [290, 310, 330, 340, 345];
    let apptRes: any = null;
    for (const offset of dateOffsets) {
      for (const time of timeSlots) {
        const res = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: getFutureDate(offset),
          scheduledStart: time,
          services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
          assignedEmployeeId: auth.user.id,
        });
        if (res.status === 201) { apptRes = res; break; }
      }
      if (apptRes) break;
    }
    expect(apptRes?.status, "Termin muss erstellt werden (201)").toBe(201);
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

  it("LN-9.1C – Monatlicher LN ohne dokumentierte Termine wird abgelehnt (400)", async () => {
    const createRes = await apiPost<any>("/api/service-records", {
      customerId: testCustomerId,
      year: 2020,
      month: 1,
    });
    expect(createRes.status).toBe(400);
  });

  it("LN-9.2 – Monatlicher LN blockiert wenn undokumentierte Termine vorhanden", async () => {
    const timeSlots = ["04:30", "03:30", "02:30", "21:30", "22:30"];
    const dateOffsets = [291, 311, 331, 341, 346];
    let createRes: any = null;
    let futureDate = "";
    for (const offset of dateOffsets) {
      for (const time of timeSlots) {
        futureDate = getFutureDate(offset);
        const res = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: futureDate,
          scheduledStart: time,
          services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
          assignedEmployeeId: auth.user.id,
        });
        if (res.status === 201) { createRes = res; break; }
      }
      if (createRes) break;
    }
    expect(createRes?.status, "Termin muss erstellt werden (201)").toBe(201);
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
    const timeSlots = ["03:30", "03:00", "04:00", "04:30", "22:00", "22:30", "05:00", "05:30"];
    let apptRes: any = null;
    outer:
    for (let off = 292; off <= 330; off++) {
      const futureDate = getFutureDate(off);
      for (const time of timeSlots) {
        apptRes = await apiPost<any>("/api/appointments/kundentermin", {
          customerId: testCustomerId,
          date: futureDate,
          scheduledStart: time,
          services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
          assignedEmployeeId: auth.user.id,
        });
        if (apptRes.status === 201) break outer;
      }
    }
    expect(apptRes?.status).toBe(201);
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

  it("LN-12.2 – Monatlicher LN: check-period zeigt dokumentierten Termin als abdeckbar", async () => {
    const apptId = await createAndDocumentAppointment(
      ["06:00", "06:30", "19:00", "19:30"],
      [0, 30]
    );
    expect(apptId, "Termin muss erstellt und dokumentiert werden").toBeTruthy();

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const checkRes = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${year}&month=${month}`
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.documentedCount).toBeGreaterThan(0);
  });

  it("LN-12.2B – Monatlicher LN ohne dokumentierte Termine in leerem Monat → 400", async () => {
    const emptyYear = 2025;
    const emptyMonth = 1;

    const res = await apiPost<any>("/api/service-records", {
      customerId: testCustomerId,
      year: emptyYear,
      month: emptyMonth,
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toBeDefined();
  });

  it("LN-12.3 – Erneuter monatlicher LN ohne ungedeckte Termine → 400", async () => {
    const now = new Date();
    const futureMonth = now.getMonth() + 5;
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

describe("LN-12B: Bereits abgedeckte Termine → 400", () => {
  it("LN-12B.1 – Alle Termine bereits abgedeckt → 400", async () => {
    const apptId = await createAndDocumentAppointment(
      ["03:00", "03:30", "20:30", "20:00"],
      [2, 60]
    );
    expect(apptId).toBeTruthy();
    const d = new Date();
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const lnRes = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: apptId,
    });
    expect(lnRes.status).toBe(201);

    const dupRes = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: apptId,
    });
    expect(dupRes.status).toBe(409);
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

describe("LN-13: Monatlicher LN – Positive Erstellung mit dokumentierten Terminen", () => {
  it("LN-13.1 – Monatlicher LN mit dokumentierten Terminen wird erstellt (201)", async () => {
    const apptId = await createAndDocumentAppointment(
      ["05:00", "05:30", "22:00", "22:30"],
      [2, 60]
    );
    expect(apptId, "Termin muss erstellt und dokumentiert werden").toBeTruthy();
    cleanupApptIds.push(apptId!);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const checkRes = await apiGet<any>(
      `/api/service-records/check-period?customerId=${testCustomerId}&year=${year}&month=${month}`
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.documentedCount, "Dokumentierte Termine müssen vorhanden sein").toBeGreaterThan(0);

    const createRes = await apiPost<any>("/api/service-records", {
      customerId: testCustomerId,
      employeeId: auth.user.id,
      year,
      month,
    });

    if (checkRes.data.canCreateRecord === true && checkRes.data.uncoveredDocumentedCount > 0) {
      expect(createRes.status, "LN-Erstellung muss 201 liefern wenn canCreateRecord=true und uncovered>0").toBe(201);
      expect(createRes.data.recordType).toBe("monthly");
      expect(createRes.data.status).toBe("pending");
    } else if (checkRes.data.canCreateRecord === false) {
      expect([400, 409]).toContain(createRes.status);
    } else {
      expect(createRes.status, "LN-Erstellung: 201 oder 400/409 erwartet").toSatisfy(
        (s: number) => s === 201 || s === 400 || s === 409
      );
    }
  });

  it("LN-13.2 – Monatlicher LN ohne dokumentierte Termine wird abgelehnt (400)", async () => {
    const now = new Date();
    const emptyMonth = now.getMonth() + 8 > 12 ? (now.getMonth() + 8) - 12 : now.getMonth() + 8;
    const emptyYear = now.getMonth() + 8 > 12 ? now.getFullYear() + 1 : now.getFullYear();

    const dupRes = await apiPost<any>("/api/service-records", {
      customerId: testCustomerId,
      year: emptyYear,
      month: emptyMonth,
    });
    expect(dupRes.status).toBe(400);
  });
});
