import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  getPastDate,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let abServiceId: number;
let travelKmServiceId: number;
let customerKmServiceId: number;
let insuranceProviderId: number;
let allBillableServices: { id: number; code: string; name: string; unitType: string; defaultPriceCents: number }[];

const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];
const cleanupInvoiceIds: number[] = [];
const cleanupCustomerPriceIds: { customerId: number; priceId: number }[] = [];

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
  employeeId?: number,
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
        assignedEmployeeId: employeeId || auth.user.id,
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("Kein freier Slot gefunden");
}

async function documentAppointment(
  apptId: number,
  time: string,
  serviceId: number,
  actualMinutes: number,
  details: string,
  travelKm = 0,
  customerKm = 0,
): Promise<void> {
  const docRes = await apiPost<any>(`/api/appointments/${apptId}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: travelKm,
    customerKilometers: customerKm,
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details }],
  });
  if (docRes.status !== 200) {
    console.error(`Document ${apptId} failed:`, JSON.stringify(docRes.data));
  }
  expect(docRes.status, `Dokumentation für Termin ${apptId} muss erfolgreich sein`).toBe(200);
}

async function createServiceRecord(customerId: number, year: number, month: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    console.error(`Service record creation failed:`, JSON.stringify(res.data));
  }
  expect(res.status, "Leistungsnachweis muss erstellt werden").toBe(201);
  cleanupServiceRecordIds.push(res.data.id);
  return res.data.id;
}

async function signServiceRecord(recordId: number): Promise<void> {
  const empSignRes = await apiPost<any>(`/api/service-records/${recordId}/sign`, {
    signerType: "employee",
    signatureData: "data:image/png;base64,iVBORw0KGgo=",
  });
  if (empSignRes.status !== 200) {
    console.error(`Employee sign failed:`, JSON.stringify(empSignRes.data));
  }
  expect(empSignRes.status, "Mitarbeiter-Unterschrift muss erfolgreich sein").toBe(200);
  expect(empSignRes.data.status).toBe("employee_signed");

  const custSignRes = await apiPost<any>(`/api/service-records/${recordId}/sign`, {
    signerType: "customer",
    signatureData: "data:image/png;base64,iVBORw0KGgo=",
  });
  if (custSignRes.status !== 200) {
    console.error(`Customer sign failed:`, JSON.stringify(custSignRes.data));
  }
  expect(custSignRes.status, "Kunden-Unterschrift muss erfolgreich sein").toBe(200);
  expect(custSignRes.data.status).toBe("completed");
}

async function generateInvoice(customerId: number, year: number, month: number): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  if (res.status !== 200 && res.status !== 201) {
    console.error(`Invoice generation failed:`, JSON.stringify(res.data));
  }
  expect([200, 201]).toContain(res.status);
  const data = res.data;
  if (data?.splitInvoices && Array.isArray(data.invoices)) {
    for (const inv of data.invoices) cleanupInvoiceIds.push(inv.id);
    return data.invoices;
  } else if (Array.isArray(data)) {
    for (const inv of data) cleanupInvoiceIds.push(inv.id);
  } else if (data?.id) {
    cleanupInvoiceIds.push(data.id);
  }
  return data;
}

async function getInvoiceWithLineItems(invoiceId: number): Promise<any> {
  const res = await apiGet<any>(`/api/billing/${invoiceId}`);
  expect(res.status).toBe(200);
  return res.data;
}

function szCustomerPayload(overrides: Record<string, any> = {}) {
  return {
    vorname: "SZ-Test",
    nachname: "Privat-" + uniqueId(),
    geburtsdatum: "1940-03-15",
    strasse: "Privatstraße",
    nr: "42",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "SZ-Test",
        mobilnummer: "+4917600000001",
      },
    ],
    ...overrides,
  };
}

function pvCustomerPayload(overrides: Record<string, any> = {}) {
  return {
    vorname: "PV-Test",
    nachname: "Privat-" + uniqueId(),
    geburtsdatum: "1938-07-20",
    strasse: "Privatstraße",
    nr: "7",
    plz: "10117",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
    insurance: {
      providerId: 0,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "PV-Test",
        mobilnummer: "+4917600000002",
      },
    ],
    budgets: {
      entlastungsbetrag45b: 125,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
    ...overrides,
  };
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;
  abServiceId = servicesRes.data.find((s: any) => s.code === "alltagsbegleitung")!.id;
  const travelKm = servicesRes.data.find((s: any) => s.code === "travel_km");
  const customerKm = servicesRes.data.find((s: any) => s.code === "customer_km");
  travelKmServiceId = travelKm?.id;
  customerKmServiceId = customerKm?.id;

  allBillableServices = servicesRes.data
    .filter((s: any) => s.isBillable && s.isActive)
    .map((s: any) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      unitType: s.unitType,
      defaultPriceCents: s.defaultPriceCents,
    }));

  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  expect(provRes.data.length).toBeGreaterThan(0);
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  for (const inv of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${inv}`); } catch {}
  }
  for (const sr of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${sr}`); } catch {}
  }
  for (const cp of cleanupCustomerPriceIds) {
    try { await apiDelete(`/api/customers/${cp.customerId}/service-prices/${cp.priceId}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch {}
  }
});


describe("SZ: Selbstzahler – Vollständiger Abrechnungs-Flow", () => {
  let szCustomerId: number;
  let szAppt: { id: number; date: string; time: string };
  let szAppt2: { id: number; date: string; time: string };
  let szServiceRecordId: number;
  let szInvoiceId: number;

  it("SZ-1 – Selbstzahler-Kunde erstellen (ohne Versicherung)", async () => {
    const res = await apiPost<any>("/api/admin/customers", szCustomerPayload());
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    szCustomerId = res.data.id;
    cleanupCustomerIds.push(szCustomerId);
  });

  it("SZ-2 – Mitarbeiter dem Kunden zuweisen", async () => {
    expect(szCustomerId).toBeDefined();
    const res = await apiPatch<any>(`/api/admin/customers/${szCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
  });

  it("SZ-3 – Termine erstellen und dokumentieren (HW + AB, verschiedene Tage, mit Fahrtkilometern)", async () => {
    expect(szCustomerId).toBeDefined();
    szAppt = await findFreeSlotAndCreate(
      szCustomerId, hwServiceId, 60,
      [3, 20], ["06:00", "06:30", "07:00", "19:00", "19:30", "20:00"],
    );
    expect(szAppt.id).toBeDefined();
    await documentAppointment(szAppt.id, szAppt.time, hwServiceId, 60, "SZ-Test Hauswirtschaft", 12, 5);

    const fetchRes = await apiGet<any>(`/api/appointments/${szAppt.id}`);
    expect(fetchRes.data.status).toBe("completed");
    expect(fetchRes.data.travelKilometers).toBe(12);
    expect(fetchRes.data.customerKilometers).toBe(5);

    szAppt2 = await findFreeSlotAndCreate(
      szCustomerId, abServiceId, 45,
      [3, 30], ["05:00", "05:30", "20:30", "21:00"],
    );
    expect(szAppt2.id).toBeDefined();
    await documentAppointment(szAppt2.id, szAppt2.time, abServiceId, 45, "SZ-Test Alltagsbegleitung", 0, 0);
  });

  it("SZ-4 – Leistungsnachweis erstellen und unterschreiben (pending → employee_signed → completed)", async () => {
    expect(szAppt).toBeDefined();
    expect(szAppt2).toBeDefined();

    const dates = [new Date(szAppt.date), new Date(szAppt2.date)];
    const months = [...new Set(dates.map(d => `${d.getFullYear()}-${d.getMonth() + 1}`))];

    for (const m of months) {
      const [year, month] = m.split("-").map(Number);
      const srId = await createServiceRecord(szCustomerId, year, month);
      if (!szServiceRecordId) szServiceRecordId = srId;

      const pendingRes = await apiGet<any>(`/api/service-records/${srId}`);
      expect(pendingRes.data.status).toBe("pending");

      await signServiceRecord(srId);

      const completedRes = await apiGet<any>(`/api/service-records/${srId}`);
      expect(completedRes.data.status).toBe("completed");
    }
  });

  it("SZ-5 – Rechnung generieren und MwSt 19% prüfen", async () => {
    expect(szServiceRecordId).toBeDefined();
    const apptDate = new Date(szAppt.date);

    const invoiceData = await generateInvoice(
      szCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );

    const invoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData;
    szInvoiceId = invoice.id;

    const detail = await getInvoiceWithLineItems(szInvoiceId);
    expect(detail.billingType).toBe("selbstzahler");
    expect(detail.status).toBe("entwurf");

    expect(detail.vatRate).toBe(1900);
    expect(detail.netAmountCents).toBeGreaterThan(0);
    expect(detail.vatAmountCents).toBeGreaterThan(0);
    expect(detail.grossAmountCents).toBe(detail.netAmountCents + detail.vatAmountCents);
  });

  it("SZ-6 – Rechnungspositionen prüfen (HW + AB + km + Mitarbeiter)", async () => {
    expect(szInvoiceId).toBeDefined();
    const invoiceDetail = await getInvoiceWithLineItems(szInvoiceId);
    const lineItems = invoiceDetail.lineItems;

    expect(lineItems.length).toBeGreaterThanOrEqual(3);

    const hwItem = lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItem, "Hauswirtschaft-Position muss vorhanden sein").toBeDefined();
    expect(hwItem.durationMinutes).toBe(60);
    expect(hwItem.unitPriceCents).toBeGreaterThan(0);
    expect(hwItem.totalCents).toBeGreaterThan(0);
    expect(hwItem.employeeName).toBeTruthy();
    expect(hwItem.serviceDetails).toBe("SZ-Test Hauswirtschaft");
    expect(hwItem.appointmentDate).toBe(szAppt.date);
    const expectedHwTotal = Math.round((60 / 60) * hwItem.unitPriceCents);
    expect(hwItem.totalCents).toBe(expectedHwTotal);

    const abItem = lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    if (new Date(szAppt.date).getMonth() === new Date(szAppt2.date).getMonth()) {
      expect(abItem, "Alltagsbegleitung-Position muss vorhanden sein").toBeDefined();
      expect(abItem.durationMinutes).toBe(45);
      expect(abItem.serviceDetails).toBe("SZ-Test Alltagsbegleitung");
      const expectedAbTotal = Math.round((45 / 60) * abItem.unitPriceCents);
      expect(abItem.totalCents).toBe(expectedAbTotal);
    }

    const travelKmItem = lineItems.find((li: any) => li.serviceCode === "travel_km");
    expect(travelKmItem, "Anfahrt-km-Position muss vorhanden sein").toBeDefined();
    expect(travelKmItem.durationMinutes).toBe(12);
    expect(travelKmItem.unitPriceCents).toBeGreaterThan(0);
    expect(travelKmItem.employeeName).toBeTruthy();

    const customerKmItem = lineItems.find((li: any) => li.serviceCode === "customer_km");
    expect(customerKmItem, "Kunden-km-Position muss vorhanden sein").toBeDefined();
    expect(customerKmItem.durationMinutes).toBe(5);

    const nonKmLineItems = lineItems.filter((li: any) => !["travel_km", "customer_km"].includes(li.serviceCode));
    const serviceCodes = [...new Set(nonKmLineItems.map((li: any) => li.serviceCode))];
    if (new Date(szAppt.date).getMonth() === new Date(szAppt2.date).getMonth()) {
      expect(serviceCodes.length, "Mindestens 2 verschiedene Service-Typen").toBeGreaterThanOrEqual(2);
    }
  });

  it("SZ-7 – Keine Budget-Transaktionen für Selbstzahler", async () => {
    expect(szCustomerId).toBeDefined();
    const budgetRes = await apiGet<any>(`/api/admin/customers/${szCustomerId}/budget-transactions`);
    if (budgetRes.status === 200) {
      const transactions = Array.isArray(budgetRes.data) ? budgetRes.data : (budgetRes.data?.data || []);
      expect(transactions.length, "Selbstzahler darf keine Budget-Transaktionen haben").toBe(0);
    }
  });
});


describe("PV: Privatversicherte – Vollständiger Abrechnungs-Flow", () => {
  let pvCustomerId: number;
  let pvAppt: { id: number; date: string; time: string };
  let pvServiceRecordId: number;
  let pvInvoiceId: number;

  it("PV-1 – Privatversicherten-Kunde erstellen (mit Versicherung)", async () => {
    const payload = pvCustomerPayload({
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(201);
    pvCustomerId = res.data.id;
    cleanupCustomerIds.push(pvCustomerId);
  });

  it("PV-2 – Mitarbeiter zuweisen", async () => {
    expect(pvCustomerId).toBeDefined();
    const res = await apiPatch<any>(`/api/admin/customers/${pvCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);
  });

  it("PV-3 – Termin erstellen und dokumentieren", async () => {
    expect(pvCustomerId).toBeDefined();
    pvAppt = await findFreeSlotAndCreate(
      pvCustomerId, abServiceId, 90,
      [3, 30], ["05:00", "05:30", "20:00", "20:30", "21:00"],
    );

    await documentAppointment(pvAppt.id, pvAppt.time, abServiceId, 90, "PV-Test Alltagsbegleitung", 8, 0);
  });

  it("PV-4 – Leistungsnachweis erstellen und unterschreiben (pending → employee_signed → completed)", async () => {
    expect(pvAppt).toBeDefined();
    const apptDate = new Date(pvAppt.date);
    pvServiceRecordId = await createServiceRecord(
      pvCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );

    const pendingRes = await apiGet<any>(`/api/service-records/${pvServiceRecordId}`);
    expect(pendingRes.data.status).toBe("pending");

    await signServiceRecord(pvServiceRecordId);

    const completedRes = await apiGet<any>(`/api/service-records/${pvServiceRecordId}`);
    expect(completedRes.data.status).toBe("completed");
  });

  it("PV-5 – Rechnung generieren und MwSt 0% prüfen (pflegekasse_privat)", async () => {
    expect(pvServiceRecordId).toBeDefined();
    const apptDate = new Date(pvAppt.date);

    const invoiceData = await generateInvoice(
      pvCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );

    const invoices = Array.isArray(invoiceData) ? invoiceData : [invoiceData];
    const kasseInvoice = invoices.find((inv: any) => inv.billingType === "pflegekasse_privat");
    expect(kasseInvoice, "Kassenanteil-Rechnung muss vorhanden sein").toBeDefined();
    pvInvoiceId = kasseInvoice.id;

    const detail = await getInvoiceWithLineItems(pvInvoiceId);
    expect(detail.billingType).toBe("pflegekasse_privat");
    expect(detail.vatAmountCents, "Privatversicherte Kasse: VAT muss 0 sein").toBe(0);
    expect(detail.grossAmountCents).toBe(detail.netAmountCents);
    expect(detail.netAmountCents).toBeGreaterThan(0);

    if (invoices.length > 1) {
      const privatInvoice = invoices.find((inv: any) => inv.billingType === "selbstzahler");
      expect(privatInvoice, "Privatanteil-Rechnung bei Budget-Überschreitung").toBeDefined();
      expect(privatInvoice.vatRate).toBe(1900);
      expect(privatInvoice.vatAmountCents).toBeGreaterThan(0);
    }
  });

  it("PV-6 – Rechnungspositionen prüfen (Alltagsbegleitung + Anfahrt)", async () => {
    expect(pvInvoiceId).toBeDefined();
    const invoiceDetail = await getInvoiceWithLineItems(pvInvoiceId);
    const lineItems = invoiceDetail.lineItems;

    expect(lineItems.length).toBeGreaterThanOrEqual(1);

    const abItem = lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    expect(abItem, "Alltagsbegleitung-Position muss vorhanden sein").toBeDefined();
    expect(abItem.durationMinutes).toBe(90);
    expect(abItem.unitPriceCents).toBeGreaterThan(0);
    expect(abItem.employeeName).toBeTruthy();

    expect(abItem.totalCents).toBeGreaterThan(0);

    const totalNet = lineItems.reduce((sum: number, li: any) => sum + li.totalCents, 0);
    expect(totalNet).toBe(invoiceDetail.netAmountCents);
  });

  it("PV-7 – Versicherungsdaten in der Rechnung vorhanden", async () => {
    expect(pvInvoiceId).toBeDefined();
    const invoiceDetail = await getInvoiceWithLineItems(pvInvoiceId);
    expect(invoiceDetail.customerName).toBeTruthy();
    expect(invoiceDetail.recipientName).toBeTruthy();
    expect(invoiceDetail.insuranceProviderName, "Versicherungsname muss vorhanden sein").toBeTruthy();
    expect(invoiceDetail.versichertennummer, "Versichertennummer muss vorhanden sein").toBeTruthy();
    expect(invoiceDetail.insuranceIkNummer, "IK-Nummer muss vorhanden sein").toBeTruthy();
    expect(invoiceDetail.pflegegrad, "Pflegegrad muss vorhanden sein").toBeGreaterThanOrEqual(1);
  });
});


describe("ME: Multi-Employee – Verschiedene Mitarbeiter in Rechnungspositionen", () => {
  let meCustomerId: number;
  let meAppt1: { id: number; date: string; time: string };
  let meAppt2: { id: number; date: string; time: string };
  let meInvoiceId: number;

  it("ME-1 – Selbstzahler-Kunde erstellen", async () => {
    const res = await apiPost<any>("/api/admin/customers", szCustomerPayload({
      nachname: "ME-Multi-" + uniqueId(),
    }));
    expect(res.status).toBe(201);
    meCustomerId = res.data.id;
    cleanupCustomerIds.push(meCustomerId);

    await apiPatch<any>(`/api/admin/customers/${meCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
  });

  it("ME-2 – Zwei Termine an verschiedenen Tagen erstellen und dokumentieren", async () => {
    expect(meCustomerId).toBeDefined();

    meAppt1 = await findFreeSlotAndCreate(
      meCustomerId, hwServiceId, 45,
      [4, 20], ["05:00", "05:30", "06:00", "21:00", "21:30"],
    );
    await documentAppointment(meAppt1.id, meAppt1.time, hwServiceId, 45, "ME-Termin-1", 3, 0);

    meAppt2 = await findFreeSlotAndCreate(
      meCustomerId, abServiceId, 60,
      [4, 30], ["04:00", "04:30", "22:00", "22:30"],
    );
    await documentAppointment(meAppt2.id, meAppt2.time, abServiceId, 60, "ME-Termin-2", 0, 0);
  });

  it("ME-3 – Leistungsnachweis erstellen und Rechnung generieren", async () => {
    expect(meAppt1).toBeDefined();
    expect(meAppt2).toBeDefined();

    const dates = [new Date(meAppt1.date), new Date(meAppt2.date)];
    const months = [...new Set(dates.map(d => `${d.getFullYear()}-${d.getMonth() + 1}`))];

    for (const m of months) {
      const [year, month] = m.split("-").map(Number);
      const srId = await createServiceRecord(meCustomerId, year, month);
      await signServiceRecord(srId);
    }

    const apptDate = new Date(meAppt1.date);
    const invoiceData = await generateInvoice(
      meCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    const invoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData;
    meInvoiceId = invoice.id;
  });

  it("ME-4 – Rechnungspositionen enthalten Mitarbeiternamen und verschiedene Services", async () => {
    expect(meInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(meInvoiceId);
    const lineItems = detail.lineItems;

    expect(lineItems.length).toBeGreaterThanOrEqual(2);

    for (const li of lineItems) {
      expect(li.employeeName, `Position ${li.serviceCode} muss Mitarbeiternamen haben`).toBeTruthy();
      expect(li.appointmentDate, `Position ${li.serviceCode} muss Termindatum haben`).toBeTruthy();
      expect(li.totalCents, `Position ${li.serviceCode} muss Betrag haben`).toBeGreaterThan(0);
    }

    const serviceCodes = [...new Set(lineItems.map((li: any) => li.serviceCode).filter((c: string) => c !== "travel_km"))];
    expect(serviceCodes.length, "Mindestens 2 verschiedene Service-Typen").toBeGreaterThanOrEqual(2);

    const hwItems = lineItems.filter((li: any) => li.serviceCode === "hauswirtschaft");
    const abItems = lineItems.filter((li: any) => li.serviceCode === "alltagsbegleitung");

    if (new Date(meAppt1.date).getMonth() === new Date(meAppt2.date).getMonth()) {
      expect(hwItems.length).toBeGreaterThanOrEqual(1);
      expect(abItems.length).toBeGreaterThanOrEqual(1);
    }
  });
});


describe("CP: Kundenspezifische Preise (Custom Pricing)", () => {
  let cpCustomerId: number;
  let cpApptBefore: { id: number; date: string; time: string };
  let cpApptAfter: { id: number; date: string; time: string };
  let cpPriceId: number;
  let cpInvoiceId: number;
  let defaultHwPrice: number;
  let cpValidFrom: string;

  it("CP-1 – Selbstzahler-Kunde erstellen", async () => {
    const res = await apiPost<any>("/api/admin/customers", szCustomerPayload({
      nachname: "CP-Custom-" + uniqueId(),
    }));
    expect(res.status).toBe(201);
    cpCustomerId = res.data.id;
    cleanupCustomerIds.push(cpCustomerId);

    await apiPatch<any>(`/api/admin/customers/${cpCustomerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const servicesRes = await apiGet<any[]>("/api/services/all");
    const hwService = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
    defaultHwPrice = hwService.defaultPriceCents;
  });

  it("CP-2 – Kundenspezifischen Preis ab heute setzen", async () => {
    expect(cpCustomerId).toBeDefined();
    cpValidFrom = new Date().toISOString().split("T")[0];

    const res = await apiPost<any>(`/api/customers/${cpCustomerId}/service-prices`, {
      serviceId: hwServiceId,
      priceCents: 5500,
      validFrom: cpValidFrom,
    });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("id");
    cpPriceId = res.data.id;
    cleanupCustomerPriceIds.push({ customerId: cpCustomerId, priceId: cpPriceId });
  });

  it("CP-3 – Kundenspezifische Preise abrufen und verifizieren", async () => {
    expect(cpCustomerId).toBeDefined();
    const res = await apiGet<any[]>(`/api/customers/${cpCustomerId}/service-prices`);
    expect(res.status).toBe(200);
    const prices = res.data;
    const hwPrice = (prices as any[]).find((p: any) => p.serviceId === hwServiceId);
    expect(hwPrice, "Hauswirtschaft-Kundenpreis muss existieren").toBeDefined();
    expect(hwPrice.priceCents).toBe(5500);
  });

  it("CP-4 – Termin VOR Gültigkeitsdatum nutzt Standardpreis", async () => {
    expect(cpCustomerId).toBeDefined();

    cpApptBefore = await findFreeSlotAndCreate(
      cpCustomerId, hwServiceId, 60,
      [5, 30], ["04:00", "04:30", "05:00", "22:00", "22:30"],
    );
    await documentAppointment(cpApptBefore.id, cpApptBefore.time, hwServiceId, 60, "CP-VorPreis", 0, 0);
  });

  it("CP-5 – Termin NACH Gültigkeitsdatum nutzt Kundenpreis", async () => {
    expect(cpCustomerId).toBeDefined();
    expect(cpValidFrom).toBeDefined();

    cpApptAfter = await findFreeSlotAndCreate(
      cpCustomerId, hwServiceId, 60,
      [0, 0], ["03:00", "03:30", "04:00", "23:00", "23:30"],
    );
    expect(
      cpApptAfter.date >= cpValidFrom,
      `Termin (${cpApptAfter.date}) muss >= validFrom (${cpValidFrom}) sein`,
    ).toBe(true);
    await documentAppointment(cpApptAfter.id, cpApptAfter.time, hwServiceId, 60, "CP-NachPreis", 0, 0);
  });

  it("CP-6 – Rechnung generieren und Preise verifizieren", async () => {
    expect(cpApptBefore).toBeDefined();
    expect(cpApptAfter).toBeDefined();

    const dates = [new Date(cpApptBefore.date), new Date(cpApptAfter.date)];
    const months = [...new Set(dates.map(d => `${d.getFullYear()}-${d.getMonth() + 1}`))];

    for (const m of months) {
      const [year, month] = m.split("-").map(Number);
      const srId = await createServiceRecord(cpCustomerId, year, month);
      await signServiceRecord(srId);
    }

    const allInvoiceIds: number[] = [];
    for (const m of months) {
      const [year, month] = m.split("-").map(Number);
      const invoiceData = await generateInvoice(cpCustomerId, year, month);
      const invs = Array.isArray(invoiceData) ? invoiceData : [invoiceData];
      for (const inv of invs) allInvoiceIds.push(inv.id);
    }

    const allLineItems: any[] = [];
    for (const invId of allInvoiceIds) {
      const detail = await getInvoiceWithLineItems(invId);
      allLineItems.push(...detail.lineItems);
    }

    const hwItems = allLineItems.filter((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItems.length).toBeGreaterThanOrEqual(2);

    const afterItem = hwItems.find((li: any) => li.appointmentDate >= cpValidFrom);
    const beforeItem = hwItems.find((li: any) => li.appointmentDate < cpValidFrom);

    expect(afterItem, "Termin ab heute (nach validFrom) muss vorhanden sein").toBeDefined();
    expect(afterItem!.unitPriceCents, "Termin nach validFrom muss Kundenpreis 5500 nutzen").toBe(5500);

    expect(beforeItem, "Termin vor validFrom muss vorhanden sein").toBeDefined();
    expect(beforeItem!.unitPriceCents, "Termin vor validFrom muss Standardpreis nutzen").toBe(defaultHwPrice);
  });

  it("CP-7 – validFrom in der Vergangenheit wird abgelehnt", async () => {
    expect(cpCustomerId).toBeDefined();
    const res = await apiPost<any>(`/api/customers/${cpCustomerId}/service-prices`, {
      serviceId: abServiceId,
      priceCents: 9999,
      validFrom: "2024-01-01",
    });
    expect(res.status).toBe(400);
  });

  it("CP-8 – Preis mit 0 Cent wird abgelehnt (Zod min(1))", async () => {
    expect(cpCustomerId).toBeDefined();
    const today = new Date().toISOString().split("T")[0];
    const res = await apiPost<any>(`/api/customers/${cpCustomerId}/service-prices`, {
      serviceId: abServiceId,
      priceCents: 0,
      validFrom: today,
    });
    expect(res.status).toBe(400);
  });

  it("CP-9 – Kundenpreis löschen setzt validTo und Rechnung nutzt Standardpreis", async () => {
    expect(cpPriceId).toBeDefined();
    const deleteRes = await apiDelete(`/api/customers/${cpCustomerId}/service-prices/${cpPriceId}`);
    expect(deleteRes.status).toBe(200);

    const allPricesRes = await apiGet<any[]>(`/api/customers/${cpCustomerId}/service-prices/all`);
    expect(allPricesRes.status).toBe(200);
    const deletedPrice = allPricesRes.data.find((p: any) => p.id === cpPriceId);
    if (deletedPrice) {
      expect(deletedPrice.validTo).toBeTruthy();
    }

    const activePrices = await apiGet<any[]>(`/api/customers/${cpCustomerId}/service-prices`);
    const activeHwPrice = (activePrices.data as any[]).find(
      (p: any) => p.serviceId === hwServiceId && !p.validTo,
    );
    expect(activeHwPrice, "Nach Löschung darf kein aktiver (ohne validTo) Kundenpreis existieren").toBeUndefined();

    const closedHwPrice = (activePrices.data as any[]).find(
      (p: any) => p.serviceId === hwServiceId && p.validTo,
    );
    if (closedHwPrice) {
      expect(closedHwPrice.validTo, "Gelöschter Preis muss validTo haben").toBeTruthy();
    }
  });
});


describe("XV: Cross-Validation – Abrechnungstyp-übergreifende Prüfungen", () => {
  it("XV-1 – Selbstzahler-Rechnung hat MwSt, Privatversicherte hat keine", async () => {
    const szPayload = szCustomerPayload({ nachname: "XV-SZ-" + uniqueId() });
    const szRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(szRes.status).toBe(201);
    const xvSzId = szRes.data.id;
    cleanupCustomerIds.push(xvSzId);

    await apiPatch<any>(`/api/admin/customers/${xvSzId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const szAppt = await findFreeSlotAndCreate(
      xvSzId, hwServiceId, 30,
      [2, 20], ["03:00", "03:30", "23:00", "23:30"],
    );
    await documentAppointment(szAppt.id, szAppt.time, hwServiceId, 30, "XV-SZ-Test", 0, 0);

    const szDate = new Date(szAppt.date);
    const szSrId = await createServiceRecord(xvSzId, szDate.getFullYear(), szDate.getMonth() + 1);
    await signServiceRecord(szSrId);
    const szInvData = await generateInvoice(xvSzId, szDate.getFullYear(), szDate.getMonth() + 1);
    const szInv = Array.isArray(szInvData) ? szInvData[0] : szInvData;
    const szDetail = await getInvoiceWithLineItems(szInv.id);

    expect(szDetail.vatRate).toBe(1900);
    expect(szDetail.vatAmountCents).toBeGreaterThan(0);
    expect(szDetail.grossAmountCents).toBe(szDetail.netAmountCents + szDetail.vatAmountCents);

    const pvPayload = pvCustomerPayload({ nachname: "XV-PV-" + uniqueId() });
    const pvRes = await apiPost<any>("/api/admin/customers", pvPayload);
    expect(pvRes.status).toBe(201);
    const xvPvId = pvRes.data.id;
    cleanupCustomerIds.push(xvPvId);

    await apiPatch<any>(`/api/admin/customers/${xvPvId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const pvAppt = await findFreeSlotAndCreate(
      xvPvId, abServiceId, 30,
      [2, 20], ["02:00", "02:30", "22:00", "22:30"],
    );
    await documentAppointment(pvAppt.id, pvAppt.time, abServiceId, 30, "XV-PV-Test", 0, 0);

    const pvDate = new Date(pvAppt.date);
    const pvSrId = await createServiceRecord(xvPvId, pvDate.getFullYear(), pvDate.getMonth() + 1);
    await signServiceRecord(pvSrId);
    const pvInvData = await generateInvoice(xvPvId, pvDate.getFullYear(), pvDate.getMonth() + 1);
    const pvInvs = Array.isArray(pvInvData) ? pvInvData : [pvInvData];
    const kasseInv = pvInvs.find((inv: any) => inv.billingType === "pflegekasse_privat");
    expect(kasseInv, "Kassenanteil muss vorhanden sein").toBeDefined();
    const pvDetail = await getInvoiceWithLineItems(kasseInv.id);

    expect(pvDetail.vatRate, "PV-Kassenrechnung: MwSt-Satz muss 0 sein").toBe(0);
    expect(pvDetail.vatAmountCents, "PV-Kassenrechnung: MwSt-Betrag muss 0 sein").toBe(0);
    expect(pvDetail.grossAmountCents).toBe(pvDetail.netAmountCents);
  });

  it("XV-2 – Termin-Dokumentationskommentar erscheint in Rechnungsposition", async () => {
    const testComment = "XV-Kommentar-" + uniqueId();

    const szPayload = szCustomerPayload({ nachname: "XV-Comment-" + uniqueId() });
    const custRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(custRes.status).toBe(201);
    const custId = custRes.data.id;
    cleanupCustomerIds.push(custId);

    await apiPatch<any>(`/api/admin/customers/${custId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const appt = await findFreeSlotAndCreate(
      custId, hwServiceId, 30,
      [2, 20], ["02:00", "02:30", "23:30"],
    );
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, testComment, 0, 0);

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    const invData = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    const inv = Array.isArray(invData) ? invData[0] : invData;

    const detail = await getInvoiceWithLineItems(inv.id);
    const commentItem = detail.lineItems.find((li: any) => li.serviceDetails === testComment);
    expect(commentItem, `Kommentar "${testComment}" muss in Rechnungsposition erscheinen`).toBeDefined();
  });

  it("XV-3 – Preisberechnung: totalCents = (durationMinutes / 60) * unitPriceCents", async () => {
    const szPayload = szCustomerPayload({ nachname: "XV-Preis-" + uniqueId() });
    const custRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(custRes.status).toBe(201);
    const custId = custRes.data.id;
    cleanupCustomerIds.push(custId);

    await apiPatch<any>(`/api/admin/customers/${custId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const appt = await findFreeSlotAndCreate(
      custId, hwServiceId, 45,
      [2, 20], ["01:00", "01:30"],
    );
    await documentAppointment(appt.id, appt.time, hwServiceId, 45, "XV-Preistest", 0, 0);

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    const invData = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    const inv = Array.isArray(invData) ? invData[0] : invData;

    const detail = await getInvoiceWithLineItems(inv.id);
    const hwItem = detail.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItem).toBeDefined();

    const expectedTotal = Math.round((hwItem.durationMinutes / 60) * hwItem.unitPriceCents);
    expect(hwItem.totalCents).toBe(expectedTotal);
  });

  it("XV-4 – Rechnung ohne Leistungsnachweis wird abgelehnt", async () => {
    const szPayload = szCustomerPayload({ nachname: "XV-NoLN-" + uniqueId() });
    const custRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(custRes.status).toBe(201);
    const custId = custRes.data.id;
    cleanupCustomerIds.push(custId);

    const now = new Date();
    const res = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: now.getMonth() + 1,
      billingYear: now.getFullYear(),
    });
    expect(res.status).toBe(400);
  });

  it("XV-5 – Duplikat-Rechnung: Alle Termine bereits abgerechnet wird abgelehnt", async () => {
    const szPayload = szCustomerPayload({ nachname: "XV-Dup-" + uniqueId() });
    const custRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(custRes.status).toBe(201);
    const custId = custRes.data.id;
    cleanupCustomerIds.push(custId);

    await apiPatch<any>(`/api/admin/customers/${custId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const appt = await findFreeSlotAndCreate(
      custId, hwServiceId, 30,
      [2, 20], ["00:30", "01:00"],
    );
    await documentAppointment(appt.id, appt.time, hwServiceId, 30, "XV-Duplikat", 0, 0);

    const apptDate = new Date(appt.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);

    const dupRes = await apiPost<any>("/api/billing/generate", {
      customerId: custId,
      billingMonth: apptDate.getMonth() + 1,
      billingYear: apptDate.getFullYear(),
    });
    expect(dupRes.status).toBe(400);
  });

  it("XV-6 – Keine doppelte Abrechnung: appointmentId ist pro Rechnung eindeutig", async () => {
    const szPayload = szCustomerPayload({ nachname: "XV-NoDup-" + uniqueId() });
    const custRes = await apiPost<any>("/api/admin/customers", szPayload);
    expect(custRes.status).toBe(201);
    const custId = custRes.data.id;
    cleanupCustomerIds.push(custId);

    await apiPatch<any>(`/api/admin/customers/${custId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    const appt1 = await findFreeSlotAndCreate(custId, hwServiceId, 30, [3, 20], ["00:00", "00:30"]);
    await documentAppointment(appt1.id, appt1.time, hwServiceId, 30, "XV-NoDup-1", 0, 0);

    const appt2 = await findFreeSlotAndCreate(custId, abServiceId, 30, [3, 20], ["01:00", "01:30"]);
    await documentAppointment(appt2.id, appt2.time, abServiceId, 30, "XV-NoDup-2", 0, 0);

    const apptDate = new Date(appt1.date);
    const srId = await createServiceRecord(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    const invData = await generateInvoice(custId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    const inv = Array.isArray(invData) ? invData[0] : invData;

    const detail = await getInvoiceWithLineItems(inv.id);
    const nonKmItems = detail.lineItems.filter((li: any) => !["travel_km", "customer_km"].includes(li.serviceCode));

    const appointmentIds = nonKmItems.map((li: any) => li.appointmentId).filter(Boolean);
    const uniqueApptIds = [...new Set(appointmentIds)];
    expect(uniqueApptIds.length).toBe(appointmentIds.length);

    expect(nonKmItems.length).toBeGreaterThanOrEqual(2);
  });
});


describe("IP: Individuelle Preise – Zwei Kunden mit verschiedenen Preisen für alle Services", () => {
  const kundeAPreise: Record<string, number> = {
    hauswirtschaft: 3200,
    alltagsbegleitung: 4500,
    travel_km: 45,
    customer_km: 50,
  };
  const kundeBPreise: Record<string, number> = {
    hauswirtschaft: 3800,
    alltagsbegleitung: 5200,
    travel_km: 30,
    customer_km: 40,
  };

  let kundeAId: number;
  let kundeBId: number;
  let kundeAInvoiceId: number;
  let kundeBInvoiceId: number;

  async function setCustomPricesForCustomer(
    customerId: number,
    preise: Record<string, number>,
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    for (const [code, priceCents] of Object.entries(preise)) {
      const svc = allBillableServices.find(s => s.code === code);
      if (!svc) continue;
      const res = await apiPost<any>(`/api/customers/${customerId}/service-prices`, {
        serviceId: svc.id,
        priceCents,
        validFrom: today,
      });
      if (res.status === 200 && res.data?.id) {
        cleanupCustomerPriceIds.push({ customerId, priceId: res.data.id });
      }
      expect(res.status, `Kundenpreis für ${code} (${priceCents}ct) muss gesetzt werden`).toBe(200);
    }
  }

  async function createCustomerWithPricesAndInvoice(
    nachname: string,
    preise: Record<string, number>,
    hwSlots: string[],
    abSlots: string[],
  ): Promise<{ customerId: number; invoiceId: number }> {
    const custRes = await apiPost<any>("/api/admin/customers", szCustomerPayload({ nachname }));
    expect(custRes.status).toBe(201);
    const customerId = custRes.data.id;
    cleanupCustomerIds.push(customerId);

    await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    await setCustomPricesForCustomer(customerId, preise);

    const hwAppt = await findFreeSlotAndCreate(
      customerId, hwServiceId, 60,
      [0, 0], hwSlots,
    );
    await documentAppointment(hwAppt.id, hwAppt.time, hwServiceId, 60, `IP-HW-${nachname}`, 10, 5);

    const abAppt = await findFreeSlotAndCreate(
      customerId, abServiceId, 90,
      [0, 0], abSlots,
    );
    await documentAppointment(abAppt.id, abAppt.time, abServiceId, 90, `IP-AB-${nachname}`, 0, 0);

    const apptDate = new Date(hwAppt.date);
    const srId = await createServiceRecord(customerId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    await signServiceRecord(srId);
    const invData = await generateInvoice(customerId, apptDate.getFullYear(), apptDate.getMonth() + 1);
    const inv = Array.isArray(invData) ? invData[0] : invData;
    return { customerId, invoiceId: inv.id };
  }

  it("IP-1 – Kunde A: Individualpreise für alle Services setzen, Termine erstellen, Rechnung generieren", async () => {
    const result = await createCustomerWithPricesAndInvoice(
      "IP-KundeA-" + uniqueId(), kundeAPreise,
      ["03:00", "03:30", "04:00", "04:30"],
      ["05:00", "05:30", "06:00", "06:30"],
    );
    kundeAId = result.customerId;
    kundeAInvoiceId = result.invoiceId;
    expect(kundeAInvoiceId).toBeDefined();
  });

  it("IP-2 – Kunde B: Andere Individualpreise für alle Services setzen, Termine erstellen, Rechnung generieren", async () => {
    const result = await createCustomerWithPricesAndInvoice(
      "IP-KundeB-" + uniqueId(), kundeBPreise,
      ["07:00", "07:30", "08:00", "08:30"],
      ["09:00", "09:30", "10:00", "10:30"],
    );
    kundeBId = result.customerId;
    kundeBInvoiceId = result.invoiceId;
    expect(kundeBInvoiceId).toBeDefined();
  });

  it("IP-3 – Kunde A: Hauswirtschaft nutzt 3200ct/h (nicht System-Standard)", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeAInvoiceId);
    const hwItem = detail.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItem, "HW-Position für Kunde A muss vorhanden sein").toBeDefined();
    expect(hwItem.unitPriceCents, "Kunde A: HW-Preis muss 3200 sein").toBe(3200);
    const expectedTotal = Math.round((60 / 60) * 3200);
    expect(hwItem.totalCents).toBe(expectedTotal);
  });

  it("IP-4 – Kunde A: Alltagsbegleitung nutzt 4500ct/h (nicht System-Standard)", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeAInvoiceId);
    const abItem = detail.lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    expect(abItem, "AB-Position für Kunde A muss vorhanden sein").toBeDefined();
    expect(abItem.unitPriceCents, "Kunde A: AB-Preis muss 4500 sein").toBe(4500);
    const expectedTotal = Math.round((90 / 60) * 4500);
    expect(abItem.totalCents).toBe(expectedTotal);
  });

  it("IP-5 – Kunde A: Anfahrt-km nutzt 45ct/km (nicht System-Standard)", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeAInvoiceId);
    const travelItem = detail.lineItems.find((li: any) => li.serviceCode === "travel_km");
    expect(travelItem, "Anfahrt-km-Position für Kunde A muss vorhanden sein").toBeDefined();
    expect(travelItem.unitPriceCents, "Kunde A: Anfahrt-km Preis muss 45 sein").toBe(45);
    const expectedKmTotal = Math.round(10 * 45);
    expect(travelItem.totalCents).toBe(expectedKmTotal);
  });

  it("IP-6 – Kunde A: Kunden-km nutzt 50ct/km (nicht System-Standard)", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeAInvoiceId);
    const custKmItem = detail.lineItems.find((li: any) => li.serviceCode === "customer_km");
    expect(custKmItem, "Kunden-km-Position für Kunde A muss vorhanden sein").toBeDefined();
    expect(custKmItem.unitPriceCents, "Kunde A: Kunden-km Preis muss 50 sein").toBe(50);
    const expectedKmTotal = Math.round(5 * 50);
    expect(custKmItem.totalCents).toBe(expectedKmTotal);
  });

  it("IP-7 – Kunde B: Hauswirtschaft nutzt 3800ct/h (≠ Kunde A, ≠ System-Standard)", async () => {
    expect(kundeBInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeBInvoiceId);
    const hwItem = detail.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItem, "HW-Position für Kunde B muss vorhanden sein").toBeDefined();
    expect(hwItem.unitPriceCents, "Kunde B: HW-Preis muss 3800 sein").toBe(3800);
    expect(hwItem.unitPriceCents).not.toBe(kundeAPreise.hauswirtschaft);
    const expectedTotal = Math.round((60 / 60) * 3800);
    expect(hwItem.totalCents).toBe(expectedTotal);
  });

  it("IP-8 – Kunde B: Alltagsbegleitung nutzt 5200ct/h (≠ Kunde A, ≠ System-Standard)", async () => {
    expect(kundeBInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeBInvoiceId);
    const abItem = detail.lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    expect(abItem, "AB-Position für Kunde B muss vorhanden sein").toBeDefined();
    expect(abItem.unitPriceCents, "Kunde B: AB-Preis muss 5200 sein").toBe(5200);
    expect(abItem.unitPriceCents).not.toBe(kundeAPreise.alltagsbegleitung);
    const expectedTotal = Math.round((90 / 60) * 5200);
    expect(abItem.totalCents).toBe(expectedTotal);
  });

  it("IP-9 – Kunde B: Anfahrt-km nutzt 30ct/km (≠ Kunde A, ≠ System-Standard)", async () => {
    expect(kundeBInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeBInvoiceId);
    const travelItem = detail.lineItems.find((li: any) => li.serviceCode === "travel_km");
    expect(travelItem, "Anfahrt-km-Position für Kunde B muss vorhanden sein").toBeDefined();
    expect(travelItem.unitPriceCents, "Kunde B: Anfahrt-km Preis muss 30 sein").toBe(30);
    expect(travelItem.unitPriceCents).not.toBe(kundeAPreise.travel_km);
    const expectedKmTotal = Math.round(10 * 30);
    expect(travelItem.totalCents).toBe(expectedKmTotal);
  });

  it("IP-10 – Kunde B: Kunden-km nutzt 40ct/km (≠ Kunde A, ≠ System-Standard)", async () => {
    expect(kundeBInvoiceId).toBeDefined();
    const detail = await getInvoiceWithLineItems(kundeBInvoiceId);
    const custKmItem = detail.lineItems.find((li: any) => li.serviceCode === "customer_km");
    expect(custKmItem, "Kunden-km-Position für Kunde B muss vorhanden sein").toBeDefined();
    expect(custKmItem.unitPriceCents, "Kunde B: Kunden-km Preis muss 40 sein").toBe(40);
    expect(custKmItem.unitPriceCents).not.toBe(kundeAPreise.customer_km);
    const expectedKmTotal = Math.round(5 * 40);
    expect(custKmItem.totalCents).toBe(expectedKmTotal);
  });

  it("IP-11 – Gesamtbeträge: Kunde A ≠ Kunde B bei gleicher Leistung", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    expect(kundeBInvoiceId).toBeDefined();

    const detailA = await getInvoiceWithLineItems(kundeAInvoiceId);
    const detailB = await getInvoiceWithLineItems(kundeBInvoiceId);

    expect(detailA.netAmountCents).not.toBe(detailB.netAmountCents);

    const hwA = detailA.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    const hwB = detailB.lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwA.unitPriceCents).toBe(kundeAPreise.hauswirtschaft);
    expect(hwB.unitPriceCents).toBe(kundeBPreise.hauswirtschaft);
    expect(hwA.unitPriceCents).not.toBe(hwB.unitPriceCents);

    const abA = detailA.lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    const abB = detailB.lineItems.find((li: any) => li.serviceCode === "alltagsbegleitung");
    expect(abA.unitPriceCents).toBe(kundeAPreise.alltagsbegleitung);
    expect(abB.unitPriceCents).toBe(kundeBPreise.alltagsbegleitung);

    const travelA = detailA.lineItems.find((li: any) => li.serviceCode === "travel_km");
    const travelB = detailB.lineItems.find((li: any) => li.serviceCode === "travel_km");
    expect(travelA.unitPriceCents).toBe(kundeAPreise.travel_km);
    expect(travelB.unitPriceCents).toBe(kundeBPreise.travel_km);

    const kmA = detailA.lineItems.find((li: any) => li.serviceCode === "customer_km");
    const kmB = detailB.lineItems.find((li: any) => li.serviceCode === "customer_km");
    expect(kmA.unitPriceCents).toBe(kundeAPreise.customer_km);
    expect(kmB.unitPriceCents).toBe(kundeBPreise.customer_km);
  });

  it("IP-12 – Keine der Positionen nutzt den System-Standardpreis", async () => {
    expect(kundeAInvoiceId).toBeDefined();
    expect(kundeBInvoiceId).toBeDefined();

    const detailA = await getInvoiceWithLineItems(kundeAInvoiceId);
    const detailB = await getInvoiceWithLineItems(kundeBInvoiceId);

    for (const [label, detail, preise] of [
      ["Kunde A", detailA, kundeAPreise],
      ["Kunde B", detailB, kundeBPreise],
    ] as const) {
      for (const li of detail.lineItems) {
        const svc = allBillableServices.find(s => s.code === li.serviceCode);
        if (!svc) continue;
        const expectedCustomPrice = preise[li.serviceCode as keyof typeof preise];
        if (expectedCustomPrice !== undefined) {
          expect(
            li.unitPriceCents,
            `${label}: ${li.serviceCode} muss Individualpreis ${expectedCustomPrice} nutzen, nicht Systempreis ${svc.defaultPriceCents}`,
          ).toBe(expectedCustomPrice);
          if (expectedCustomPrice !== svc.defaultPriceCents) {
            expect(
              li.unitPriceCents,
              `${label}: ${li.serviceCode} darf NICHT den Systempreis ${svc.defaultPriceCents} nutzen`,
            ).not.toBe(svc.defaultPriceCents);
          }
        }
      }
    }
  });
});
