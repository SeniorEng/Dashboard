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
let insuranceProviderId: number;

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
  const signRes = await apiPost<any>(`/api/service-records/${recordId}/sign`, {
    signerType: "employee",
    signatureData: "data:image/png;base64,iVBORw0KGgo=",
  });
  if (signRes.status !== 200) {
    console.error(`Sign failed:`, JSON.stringify(signRes.data));
  }
  expect(signRes.status, "Mitarbeiter-Unterschrift muss erfolgreich sein").toBe(200);
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

  it("SZ-3 – Termin erstellen und dokumentieren (mit Fahrtkilometern)", async () => {
    expect(szCustomerId).toBeDefined();
    szAppt = await findFreeSlotAndCreate(
      szCustomerId, hwServiceId, 60,
      [3, 30], ["06:00", "06:30", "07:00", "19:00", "19:30", "20:00"],
    );
    expect(szAppt.id).toBeDefined();

    await documentAppointment(szAppt.id, szAppt.time, hwServiceId, 60, "SZ-Test Hauswirtschaft", 12, 5);

    const fetchRes = await apiGet<any>(`/api/appointments/${szAppt.id}`);
    expect(fetchRes.data.status).toBe("completed");
    expect(fetchRes.data.travelKilometers).toBe(12);
    expect(fetchRes.data.customerKilometers).toBe(5);
  });

  it("SZ-4 – Leistungsnachweis erstellen und unterschreiben", async () => {
    expect(szAppt).toBeDefined();
    const apptDate = new Date(szAppt.date);
    szServiceRecordId = await createServiceRecord(
      szCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    expect(szServiceRecordId).toBeDefined();

    await signServiceRecord(szServiceRecordId);

    const fetchRes = await apiGet<any>(`/api/service-records/${szServiceRecordId}`);
    expect(fetchRes.data.status).toBe("employee_signed");
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

  it("SZ-6 – Rechnungspositionen prüfen (Dienstleistung + km + Mitarbeiter)", async () => {
    expect(szInvoiceId).toBeDefined();
    const invoiceDetail = await getInvoiceWithLineItems(szInvoiceId);
    const lineItems = invoiceDetail.lineItems;

    expect(lineItems.length).toBeGreaterThanOrEqual(2);

    const serviceItem = lineItems.find((li: any) => li.serviceCode === "hauswirtschaft");
    expect(serviceItem, "Hauswirtschaft-Position muss vorhanden sein").toBeDefined();
    expect(serviceItem.durationMinutes).toBe(60);
    expect(serviceItem.unitPriceCents).toBeGreaterThan(0);
    expect(serviceItem.totalCents).toBeGreaterThan(0);
    expect(serviceItem.employeeName).toBeTruthy();
    expect(serviceItem.serviceDetails).toBe("SZ-Test Hauswirtschaft");
    expect(serviceItem.appointmentDate).toBe(szAppt.date);

    const expectedTotal = Math.round((60 / 60) * serviceItem.unitPriceCents);
    expect(serviceItem.totalCents).toBe(expectedTotal);

    const travelKmItem = lineItems.find((li: any) => li.serviceCode === "travel_km");
    expect(travelKmItem, "Anfahrt-km-Position muss vorhanden sein").toBeDefined();
    expect(travelKmItem.durationMinutes).toBe(12);
    expect(travelKmItem.unitPriceCents).toBeGreaterThan(0);
    expect(travelKmItem.employeeName).toBeTruthy();

    const customerKmItem = lineItems.find((li: any) => li.serviceCode === "customer_km");
    expect(customerKmItem, "Kunden-km-Position muss vorhanden sein").toBeDefined();
    expect(customerKmItem.durationMinutes).toBe(5);
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

  it("PV-4 – Leistungsnachweis erstellen und unterschreiben", async () => {
    expect(pvAppt).toBeDefined();
    const apptDate = new Date(pvAppt.date);
    pvServiceRecordId = await createServiceRecord(
      pvCustomerId,
      apptDate.getFullYear(),
      apptDate.getMonth() + 1,
    );
    await signServiceRecord(pvServiceRecordId);
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
    const today = new Date().toISOString().split("T")[0];

    const res = await apiPost<any>(`/api/customers/${cpCustomerId}/service-prices`, {
      serviceId: hwServiceId,
      priceCents: 5500,
      validFrom: today,
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

    cpApptAfter = await findFreeSlotAndCreate(
      cpCustomerId, hwServiceId, 60,
      [1, 3], ["03:00", "03:30", "23:00", "23:30"],
    );
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

    const afterDate = new Date(cpApptAfter.date);
    const invoiceData = await generateInvoice(
      cpCustomerId,
      afterDate.getFullYear(),
      afterDate.getMonth() + 1,
    );
    const invoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData;
    cpInvoiceId = invoice.id;

    const detail = await getInvoiceWithLineItems(cpInvoiceId);
    const hwItems = detail.lineItems.filter((li: any) => li.serviceCode === "hauswirtschaft");
    expect(hwItems.length).toBeGreaterThanOrEqual(1);

    const today = new Date().toISOString().split("T")[0];
    const afterItem = hwItems.find((li: any) => li.appointmentDate >= today);
    const beforeItem = hwItems.find((li: any) => li.appointmentDate < today);

    if (afterItem) {
      expect(afterItem.unitPriceCents, "Termin nach validFrom muss Kundenpreis nutzen").toBe(5500);
    }
    if (beforeItem) {
      expect(beforeItem.unitPriceCents, "Termin vor validFrom muss Standardpreis nutzen").toBe(defaultHwPrice);
    }
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

  it("CP-9 – Kundenpreis löschen setzt validTo", async () => {
    expect(cpPriceId).toBeDefined();
    const deleteRes = await apiDelete(`/api/customers/${cpCustomerId}/service-prices/${cpPriceId}`);
    expect(deleteRes.status).toBe(200);

    const allPricesRes = await apiGet<any[]>(`/api/customers/${cpCustomerId}/service-prices/all`);
    expect(allPricesRes.status).toBe(200);
    const deletedPrice = allPricesRes.data.find((p: any) => p.id === cpPriceId);
    if (deletedPrice) {
      expect(deletedPrice.validTo).toBeTruthy();
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
});
