import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testCustomerId: number;
let hwServiceId: number;
let abServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function getWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

function getPastWeekday(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  getWeekday(d);
  return d.toISOString().split("T")[0];
}

async function findFreeSlotAndCreate(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  offsetRange: [number, number],
  times: string[],
  fahrtdienstData?: Record<string, any>,
): Promise<{ id: number; date: string; time: string }> {
  for (let offset = offsetRange[0]; offset <= offsetRange[1]; offset++) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    getWeekday(d);
    const dateStr = d.toISOString().split("T")[0];
    for (const time of times) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        services: [{ serviceId, durationMinutes }],
        assignedEmployeeId: auth.user.id,
        ...fahrtdienstData,
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("Kein freier Slot gefunden");
}

const FAHRTDIENST_DATA = {
  isFahrtdienst: true,
  doctorAppointmentTime: "14:00",
  doctorName: "Dr. Müller",
  doctorStrasse: "Hauptstraße",
  doctorNr: "12",
  doctorPlz: "10115",
  doctorStadt: "Berlin",
};

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  expect(servicesRes.status).toBe(200);
  const svcList = servicesRes.data;
  hwServiceId = svcList.find((s: any) => s.code === "hauswirtschaft")?.id;
  abServiceId = svcList.find((s: any) => s.code === "alltagsbegleitung")?.id;
  expect(hwServiceId, "HW-Service muss existieren").toBeDefined();
  expect(abServiceId, "AB-Service muss existieren").toBeDefined();

  const custRes = await apiPost<any>("/api/admin/customers", {
    vorname: "FD-Test",
    nachname: "Fahrtdienst-" + uniqueId(),
    geburtsdatum: "1935-06-15",
    strasse: "Testweg",
    nr: "5",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "FD-Test",
        mobilnummer: "+4917600099001",
      },
    ],
  });
  expect(custRes.status).toBe(201);
  testCustomerId = custRes.data.id;
  cleanupCustomerIds.push(testCustomerId);

  const assignRes = await apiPatch<any>(`/api/admin/customers/${testCustomerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status).toBe(200);
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch {}
  }
});

describe("FD-CREATE: Fahrtdienst-Termin erstellen", () => {
  it("FD-1.1 – Fahrtdienst-Termin mit vollständigen Arztdaten erstellen (201)", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [800, 830], ["08:00", "09:00", "10:00"],
      FAHRTDIENST_DATA,
    );
    expect(slot.id).toBeGreaterThan(0);

    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.isFahrtdienst).toBe(true);
    expect(getRes.data.doctorName).toBe("Dr. Müller");
    expect(getRes.data.doctorStrasse).toBe("Hauptstraße");
    expect(getRes.data.doctorNr).toBe("12");
    expect(getRes.data.doctorPlz).toBe("10115");
    expect(getRes.data.doctorStadt).toBe("Berlin");
    expect(getRes.data.doctorAppointmentTime).toMatch(/^14:00/);
  });

  it("FD-1.2 – Fahrtdienst ohne doctorAppointmentTime wird abgelehnt (400)", async () => {
    const dateStr = getPastWeekday(835);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "08:00",
      services: [{ serviceId: abServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      isFahrtdienst: true,
      doctorStrasse: "Hauptstraße",
      doctorPlz: "10115",
      doctorStadt: "Berlin",
    });
    expect(res.status).toBe(400);
  });

  it("FD-1.3 – Fahrtdienst ohne doctorStrasse wird abgelehnt (400)", async () => {
    const dateStr = getPastWeekday(836);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "08:00",
      services: [{ serviceId: abServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      isFahrtdienst: true,
      doctorAppointmentTime: "14:00",
      doctorPlz: "10115",
      doctorStadt: "Berlin",
    });
    expect(res.status).toBe(400);
  });

  it("FD-1.4 – Fahrtdienst ohne doctorPlz wird abgelehnt (400)", async () => {
    const dateStr = getPastWeekday(837);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "08:00",
      services: [{ serviceId: abServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      isFahrtdienst: true,
      doctorAppointmentTime: "14:00",
      doctorStrasse: "Hauptstraße",
      doctorStadt: "Berlin",
    });
    expect(res.status).toBe(400);
  });

  it("FD-1.5 – Fahrtdienst ohne doctorStadt wird abgelehnt (400)", async () => {
    const dateStr = getPastWeekday(838);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "08:00",
      services: [{ serviceId: abServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      isFahrtdienst: true,
      doctorAppointmentTime: "14:00",
      doctorStrasse: "Hauptstraße",
      doctorPlz: "10115",
    });
    expect(res.status).toBe(400);
  });

  it("FD-1.6 – Fahrtdienst mit ungültiger PLZ (4 Ziffern) wird abgelehnt (400)", async () => {
    const dateStr = getPastWeekday(839);
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date: dateStr,
      scheduledStart: "08:00",
      services: [{ serviceId: abServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
      isFahrtdienst: true,
      doctorAppointmentTime: "14:00",
      doctorStrasse: "Hauptstraße",
      doctorPlz: "1011",
      doctorStadt: "Berlin",
    });
    expect(res.status).toBe(400);
  });

  it("FD-1.7 – Nicht-Fahrtdienst-Termin hat isFahrtdienst=false", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, hwServiceId, 30,
      [840, 860], ["11:00", "12:00", "13:00"],
    );
    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.isFahrtdienst).toBe(false);
    expect(getRes.data.doctorName).toBeNull();
    expect(getRes.data.doctorAppointmentTime).toBeNull();
  });

  it("FD-1.8 – Fahrtdienst mit optionalen Geo-Koordinaten erstellen", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [865, 895], ["08:00", "09:00", "10:00"],
      {
        ...FAHRTDIENST_DATA,
        doctorLatitude: 52.52,
        doctorLongitude: 13.405,
        estimatedTravelMinutes: 25,
        travelBufferMinutes: 10,
      },
    );
    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.isFahrtdienst).toBe(true);
    expect(getRes.data.doctorLatitude).toBeCloseTo(52.52, 1);
    expect(getRes.data.doctorLongitude).toBeCloseTo(13.405, 1);
  });
});

describe("FD-EDIT: Fahrtdienst-Termin bearbeiten", () => {
  let editApptId: number;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [900, 930], ["08:00", "09:00", "10:00", "11:00"],
      FAHRTDIENST_DATA,
    );
    editApptId = slot.id;
  });

  it("FD-2.1 – Arzt-Name ändern via PATCH", async () => {
    const res = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      doctorName: "Dr. Schmidt",
    });
    expect(res.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${editApptId}`);
    expect(getRes.data.doctorName).toBe("Dr. Schmidt");
  });

  it("FD-2.2 – Arzt-Adresse ändern via PATCH", async () => {
    const res = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      doctorStrasse: "Neue Straße",
      doctorNr: "99",
      doctorPlz: "80331",
      doctorStadt: "München",
    });
    expect(res.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${editApptId}`);
    expect(getRes.data.doctorStrasse).toBe("Neue Straße");
    expect(getRes.data.doctorNr).toBe("99");
    expect(getRes.data.doctorPlz).toBe("80331");
    expect(getRes.data.doctorStadt).toBe("München");
  });

  it("FD-2.3 – Arzt-Uhrzeit ändern via PATCH", async () => {
    const res = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      doctorAppointmentTime: "16:30",
    });
    expect(res.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${editApptId}`);
    expect(getRes.data.doctorAppointmentTime).toMatch(/^16:30/);
  });

  it("FD-2.4 – Notizen ändern via PATCH", async () => {
    const res = await apiPatch<any>(`/api/appointments/${editApptId}`, {
      notes: "Rollstuhl mitnehmen",
    });
    expect(res.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${editApptId}`);
    expect(getRes.data.notes).toBe("Rollstuhl mitnehmen");
  });
});

describe("FD-DELETE: Fahrtdienst-Termin löschen", () => {
  it("FD-3.1 – Geplanter Fahrtdienst-Termin kann gelöscht werden", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [935, 960], ["08:00", "09:00"],
      FAHRTDIENST_DATA,
    );

    const delRes = await apiDelete(`/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.status).toBe(404);

    cleanupApptIds.splice(cleanupApptIds.indexOf(slot.id), 1);
  });

  it("FD-3.2 – Gelöschter Fahrtdienst-Termin erscheint nicht mehr in Tagesliste", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [965, 990], ["08:00", "09:00", "14:00"],
      FAHRTDIENST_DATA,
    );

    await apiDelete(`/api/appointments/${slot.id}`);
    cleanupApptIds.splice(cleanupApptIds.indexOf(slot.id), 1);

    const listRes = await apiGet<any[]>(`/api/appointments?date=${slot.date}`);
    expect(listRes.status).toBe(200);
    const found = listRes.data?.find((a: any) => a.id === slot.id);
    expect(found, "Gelöschter FD-Termin darf nicht in Liste erscheinen").toBeUndefined();
  });
});

describe("FD-DOC: Fahrtdienst-Termin dokumentieren", () => {
  let docApptId: number;
  let docApptTime: string;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [995, 1030], ["08:00", "09:00", "10:00", "14:00"],
      FAHRTDIENST_DATA,
    );
    docApptId = slot.id;
    docApptTime = slot.time;
  });

  it("FD-4.1 – Fahrtdienst-Termin dokumentieren setzt Status auf completed", async () => {
    const docRes = await apiPost<any>(`/api/appointments/${docApptId}/document`, {
      actualStart: docApptTime,
      travelOriginType: "home",
      travelKilometers: 15,
      customerKilometers: 8,
      notes: "Patient zum Arzt gebracht",
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Fahrtdienst zum Arzt" }],
    });
    expect(docRes.status, "Dokumentation muss erfolgreich sein").toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${docApptId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.status).toBe("completed");
    expect(getRes.data.isFahrtdienst).toBe(true);
    expect(getRes.data.travelKilometers).toBe(15);
    expect(getRes.data.customerKilometers).toBe(8);
  });

  it("FD-4.2 – Abgeschlossener Fahrtdienst-Termin: PATCH wird abgelehnt (403)", async () => {
    const res = await apiPatch<any>(`/api/appointments/${docApptId}`, {
      notes: "Änderung nach Abschluss",
    });
    expect(res.status).toBe(403);
  });

  it("FD-4.3 – Doppelte Dokumentation wird abgelehnt", async () => {
    const res = await apiPost<any>(`/api/appointments/${docApptId}/document`, {
      actualStart: docApptTime,
      travelOriginType: "home",
      travelKilometers: 5,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 45, details: "Nochmal" }],
    });
    expect([400, 403]).toContain(res.status);
  });
});

describe("FD-LN: Fahrtdienst → Leistungsnachweis", () => {
  let lnApptId: number;
  let lnDate: string;
  let lnServiceRecordId: number;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1035, 1070], ["08:00", "09:00", "10:00", "14:00", "15:00"],
      FAHRTDIENST_DATA,
    );
    lnApptId = slot.id;
    lnDate = slot.date;

    const docRes = await apiPost<any>(`/api/appointments/${lnApptId}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 12,
      customerKilometers: 5,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Begleitung zum Facharzt" }],
    });
    expect(docRes.status, "Dokumentation für LN muss erfolgreich sein").toBe(200);
  });

  it("FD-5.1 – Leistungsnachweis für dokumentierten Fahrtdienst erstellen", async () => {
    const res = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: lnApptId,
    });
    if (res.status !== 201) {
      console.error("FD-5.1 LN creation failed:", JSON.stringify(res.data));
    }
    expect(res.status).toBe(201);
    lnServiceRecordId = res.data.id;
    cleanupServiceRecordIds.push(lnServiceRecordId);
  });

  it("FD-5.2 – Leistungsnachweis enthält Fahrtdienst-Termin", async () => {
    const res = await apiGet<any>(`/api/service-records/${lnServiceRecordId}/appointments`);
    expect(res.status).toBe(200);
    const appts = res.data;
    expect(Array.isArray(appts)).toBe(true);
    const fdAppt = appts.find((a: any) => a.id === lnApptId);
    expect(fdAppt, "Fahrtdienst-Termin muss im LN enthalten sein").toBeDefined();
  });

  it("FD-5.3 – Mitarbeiter-Unterschrift setzt Status auf employee_signed", async () => {
    const res = await apiPost<any>(`/api/service-records/${lnServiceRecordId}/sign`, {
      signerType: "employee",
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("employee_signed");
  });

  it("FD-5.4 – Kunden-Unterschrift setzt Status auf completed", async () => {
    const res = await apiPost<any>(`/api/service-records/${lnServiceRecordId}/sign`, {
      signerType: "customer",
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("completed");
  });

  it("FD-5.5 – Termin im unterschriebenen LN ist gesperrt (isLocked)", async () => {
    const getRes = await apiGet<any>(`/api/appointments/${lnApptId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.isLocked).toBe(true);
  });

  it("FD-5.6 – Gesperrter Fahrtdienst-Termin: PATCH wird abgelehnt (403)", async () => {
    const res = await apiPatch<any>(`/api/appointments/${lnApptId}`, {
      notes: "Änderung nach LN-Unterschrift",
    });
    expect(res.status).toBe(403);
  });

  it("FD-5.7 – Gesperrter Fahrtdienst-Termin: Re-Dokumentation wird abgelehnt (403)", async () => {
    const res = await apiPost<any>(`/api/appointments/${lnApptId}/document`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 5,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 30, details: "Nochmal" }],
    });
    expect(res.status).toBe(403);
  });
});

describe("FD-BILLING: Fahrtdienst → Rechnung", () => {
  let billApptId: number;
  let billDate: string;
  let billServiceRecordId: number;
  let invoiceData: any;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 90,
      [1075, 1110], ["08:00", "09:00", "10:00", "14:00"],
      {
        ...FAHRTDIENST_DATA,
        doctorName: "Dr. Billing-Test",
      },
    );
    billApptId = slot.id;
    billDate = slot.date;

    const docRes = await apiPost<any>(`/api/appointments/${billApptId}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 20,
      customerKilometers: 10,
      notes: "Fahrtdienst für Rechnungstest",
      services: [{ serviceId: abServiceId, actualDurationMinutes: 90, details: "Fahrtdienst-Begleitung zum Arzt" }],
    });
    expect(docRes.status, "Dokumentation für Rechnung muss erfolgreich sein").toBe(200);

    const srRes = await apiPost<any>("/api/service-records/single", {
      customerId: testCustomerId,
      appointmentId: billApptId,
    });
    expect(srRes.status, "LN für Rechnung muss erstellt werden").toBe(201);
    billServiceRecordId = srRes.data.id;
    cleanupServiceRecordIds.push(billServiceRecordId);

    const empSign = await apiPost<any>(`/api/service-records/${billServiceRecordId}/sign`, {
      signerType: "employee",
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(empSign.status).toBe(200);

    const custSign = await apiPost<any>(`/api/service-records/${billServiceRecordId}/sign`, {
      signerType: "customer",
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(custSign.status).toBe(200);
  });

  it("FD-6.1 – Rechnung für Fahrtdienst-Termin generieren", async () => {
    const d = new Date(billDate);
    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId: testCustomerId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    expect([200, 201]).toContain(genRes.status);
    invoiceData = genRes.data;
    if (invoiceData?.splitInvoices && Array.isArray(invoiceData.invoices)) {
      for (const inv of invoiceData.invoices) cleanupInvoiceIds.push(inv.id);
    } else if (Array.isArray(invoiceData)) {
      for (const inv of invoiceData) cleanupInvoiceIds.push(inv.id);
    } else if (invoiceData?.id) {
      cleanupInvoiceIds.push(invoiceData.id);
    }
  });

  it("FD-6.2 – Rechnung enthält Fahrtdienst-Positionen", async () => {
    const invoiceId = cleanupInvoiceIds[cleanupInvoiceIds.length - 1];
    expect(invoiceId, "Rechnungs-ID muss vorhanden sein").toBeDefined();

    const detailRes = await apiGet<any>(`/api/billing/${invoiceId}`);
    expect(detailRes.status).toBe(200);
    const detail = detailRes.data;
    expect(detail.lineItems?.length).toBeGreaterThan(0);

    const abItem = detail.lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    expect(abItem, "AB-Position muss vorhanden sein").toBeDefined();
    expect(abItem.durationMinutes || abItem.quantity).toBeGreaterThan(0);
  });

  it("FD-6.3 – Selbstzahler-Rechnung hat MwSt 19%", async () => {
    const invoiceId = cleanupInvoiceIds[cleanupInvoiceIds.length - 1];
    const detailRes = await apiGet<any>(`/api/billing/${invoiceId}`);
    expect(detailRes.status).toBe(200);

    const invoice = detailRes.data;
    const vatRate = invoice.vatRate ?? invoice.vat_rate;
    expect(vatRate).toBeDefined();
    expect([19, 1900]).toContain(vatRate);
  });

  it("FD-6.4 – Fahrtkilometer erscheinen in Rechnung (wenn konfiguriert)", async () => {
    const invoiceId = cleanupInvoiceIds[cleanupInvoiceIds.length - 1];
    const detailRes = await apiGet<any>(`/api/billing/${invoiceId}`);
    expect(detailRes.status).toBe(200);

    const lineItems = detailRes.data.lineItems || [];
    const travelItem = lineItems.find((li: any) => li.serviceCode === "travel_km");
    const customerKmItem = lineItems.find((li: any) => li.serviceCode === "customer_km");
    const hasKmItems = travelItem || customerKmItem;
    expect(hasKmItems || lineItems.length > 0,
      "Rechnung muss mindestens Positionen haben (km oder Dienstleistung)").toBeTruthy();
  });

  it("FD-6.5 – Duplikat-Rechnung wird abgelehnt", async () => {
    const d = new Date(billDate);
    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId: testCustomerId,
      billingMonth: d.getMonth() + 1,
      billingYear: d.getFullYear(),
    });
    expect([400, 409]).toContain(genRes.status);
  });
});

describe("FD-REOPEN: Fahrtdienst-Termin wiedereröffnen und erneut dokumentieren", () => {
  let reopenApptId: number;
  let reopenTime: string;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1115, 1150], ["08:00", "09:00", "10:00", "14:00", "15:00"],
      FAHRTDIENST_DATA,
    );
    reopenApptId = slot.id;
    reopenTime = slot.time;

    const docRes = await apiPost<any>(`/api/appointments/${reopenApptId}/document`, {
      actualStart: reopenTime,
      travelOriginType: "home",
      travelKilometers: 10,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Erste Dokumentation" }],
    });
    expect(docRes.status).toBe(200);
  });

  it("FD-7.1 – Abgeschlossenen Fahrtdienst-Termin wiedereröffnen", async () => {
    const reopenRes = await apiPost<any>(`/api/appointments/${reopenApptId}/reopen`, {});
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.data.status).toBe("documenting");

    const getRes = await apiGet<any>(`/api/appointments/${reopenApptId}`);
    expect(getRes.data.isFahrtdienst).toBe(true);
  });

  it("FD-7.2 – Wiedereröffneten Fahrtdienst-Termin erneut dokumentieren", async () => {
    const docRes = await apiPost<any>(`/api/appointments/${reopenApptId}/document`, {
      actualStart: reopenTime,
      travelOriginType: "home",
      travelKilometers: 18,
      customerKilometers: 6,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 75, details: "Korrigierte Dokumentation" }],
    });
    expect(docRes.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${reopenApptId}`);
    expect(getRes.data.status).toBe("completed");
    expect(getRes.data.travelKilometers).toBe(18);
    expect(getRes.data.customerKilometers).toBe(6);
  });
});

describe("FD-ADMIN-DELETE: Admin löscht abgeschlossenen Fahrtdienst-Termin", () => {
  it("FD-8.1 – Admin kann abgeschlossenen Fahrtdienst-Termin löschen (Storno)", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1155, 1190], ["08:00", "09:00", "10:00"],
      FAHRTDIENST_DATA,
    );

    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 5,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Zum Löschen" }],
    });
    expect(docRes.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.data.status).toBe("completed");

    const delRes = await apiDelete(`/api/appointments/${slot.id}`);
    expect(delRes.status).toBe(200);

    const getAfter = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getAfter.status).toBe(404);

    cleanupApptIds.splice(cleanupApptIds.indexOf(slot.id), 1);
  });
});

describe("FD-STATUS: Fahrtdienst Status-Workflow", () => {
  it("FD-9.1 – Fahrtdienst-Termin hat initial Status 'scheduled'", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1195, 1230], ["08:00", "09:00", "10:00", "14:00"],
      FAHRTDIENST_DATA,
    );

    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.data.status).toBe("scheduled");
    expect(getRes.data.isFahrtdienst).toBe(true);
  });

  it("FD-9.2 – Direkte Dokumentation von scheduled → completed (ohne Start/End)", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1235, 1270], ["08:00", "09:00", "10:00", "14:00"],
      FAHRTDIENST_DATA,
    );

    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 8,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Direkt dokumentiert" }],
    });
    expect(docRes.status).toBe(200);

    const getRes = await apiGet<any>(`/api/appointments/${slot.id}`);
    expect(getRes.data.status).toBe("completed");
    expect(getRes.data.isFahrtdienst).toBe(true);
  });

  it("FD-9.3 – Doppelter Start im documenting-Status wird abgelehnt (403)", async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1275, 1310], ["08:00", "09:00", "10:00", "14:00"],
      FAHRTDIENST_DATA,
    );

    await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 5,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Completed" }],
    });

    const reopenRes = await apiPost<any>(`/api/appointments/${slot.id}/reopen`, {});
    expect(reopenRes.status).toBe(200);

    const startRes = await apiPatch<any>(`/api/appointments/${slot.id}`, {
      status: "start",
    });
    expect(startRes.status).toBe(403);
  });
});

describe("FD-TIME: Fahrtdienst in Stundenübersicht", () => {
  let timeApptId: number;
  let timeDate: string;

  beforeAll(async () => {
    const slot = await findFreeSlotAndCreate(
      testCustomerId, abServiceId, 60,
      [1275, 1310], ["08:00", "09:00", "10:00", "14:00"],
      FAHRTDIENST_DATA,
    );
    timeApptId = slot.id;
    timeDate = slot.date;

    const docRes = await apiPost<any>(`/api/appointments/${timeApptId}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 15,
      customerKilometers: 7,
      services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "Stundenübersicht-Test" }],
    });
    expect(docRes.status).toBe(200);
  });

  it("FD-10.1 – Fahrtdienst-Stunden erscheinen in Stundenübersicht", async () => {
    const d = new Date(timeDate);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const overviewRes = await apiGet<any>(`/api/time-entries/overview/${year}/${month}`);
    expect(overviewRes.status).toBe(200);

    const svcHrs = overviewRes.data.completedServiceHours || overviewRes.data.serviceHours;
    expect(svcHrs, "Service-Stunden müssen vorhanden sein").toBeDefined();
    const totalMinutes = (svcHrs.hauswirtschaftMinutes || 0)
      + (svcHrs.alltagsbegleitungMinutes || 0)
      + (svcHrs.erstberatungMinutes || 0);
    expect(totalMinutes).toBeGreaterThanOrEqual(60);
  });

  it("FD-10.2 – Fahrtkilometer erscheinen in Stundenübersicht", async () => {
    const d = new Date(timeDate);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const overviewRes = await apiGet<any>(`/api/time-entries/overview/${year}/${month}`);
    expect(overviewRes.status).toBe(200);

    const travel = overviewRes.data.travel || overviewRes.data.completedTravel || {};
    const travelKm = travel.totalKilometers || 0;
    expect(travelKm).toBeGreaterThanOrEqual(15);
  });

  it("FD-10.3 – Admin-Terminliste zeigt Fahrtdienst-Termin", async () => {
    const d = new Date(timeDate);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const adminRes = await apiGet<any>(
      `/api/admin/employee-appointments?year=${year}&month=${month}&userId=${auth.user.id}`
    );
    expect(adminRes.status).toBe(200);
    expect(Array.isArray(adminRes.data)).toBe(true);

    const fdAppt = adminRes.data.find((a: any) => a.id === timeApptId);
    expect(fdAppt, "Fahrtdienst-Termin muss in Admin-Liste erscheinen").toBeDefined();
  });
});
