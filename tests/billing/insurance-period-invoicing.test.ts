import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1893 — Period-aware Kostenträger: die Rechnung eines Abrechnungsmonats
 * geht an die IM MONAT gültige Kasse, nicht an die heute gültige.
 *
 * Prod-Nachweis des Bugs: eine Mai-Rechnung ging an die Kasse, die im JULI
 * gültig war, weil alle Abrechnungs-Lesestellen `valid_to IS NULL` filterten.
 *
 * Szenario: Kunde wechselt zum 1. des VORMONATS von Kasse A auf Kasse B.
 *   • Rechnung für den Vor-Vormonat  ⇒ Kasse A (Empfänger, IK, Versichertennr.)
 *   • Rechnung für den Vormonat      ⇒ Kasse B
 * Beides unabhängig vom heutigen Erstellungsdatum.
 *
 * Zusätzlich: 01.-Erzwingung und Überlappungs-/Lückenprüfung beim Anlegen und
 * Korrigieren, sowie die Payer-Gruppierung.
 *
 * ISOLATION: eigener Kunde + eigene Kassen je Lauf; Rechnungen werden im
 * afterAll über den Kunden-Delete mit abgeräumt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testEmployeeId: number;
let hwServiceId: number;

let customerId: number;
let providerAId: number;
let providerBId: number;
let providerAName: string;
let providerBName: string;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

const NOW = new Date();
const FIRST_OF_THIS_MONTH = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
// Vormonat („neue Kasse") und Vor-Vormonat („alte Kasse") — beide innerhalb der
// 3-Monats-Grenze der Abrechnung.
const PREV = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
const PREV_YEAR = PREV.getFullYear();
const PREV_MONTH = PREV.getMonth() + 1;
const FIRST_OF_PREV = new Date(PREV_YEAR, PREV_MONTH - 1, 1);
const PREV2 = new Date(FIRST_OF_PREV.getTime() - 24 * 60 * 60 * 1000);
const PREV2_YEAR = PREV2.getFullYear();
const PREV2_MONTH = PREV2.getMonth() + 1;

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Wechsel-Stichtag: 1. des Vormonats. Kasse A endet am letzten Tag davor. */
const SWITCH_ISO = iso(PREV_YEAR, PREV_MONTH, 1);
const PREV2_START_ISO = iso(PREV2_YEAR, PREV2_MONTH, 1);

async function createProvider(tag: string): Promise<{ id: number; name: string }> {
  const name = `TestKasse-${tag}-${uniqueId()}`;
  // IK: 9 Ziffern, aus der uniqueId abgeleitet damit sie kollisionsfrei bleibt.
  const ik = String(Date.now()).slice(-9);
  const res = await apiPost<any>("/api/admin/insurance-providers", {
    name,
    empfaenger: `${name} Zentrale`,
    isPrivate: false,
    ikNummer: ik,
    strasse: "Kassenweg",
    hausnummer: "3",
    plz: "20095",
    stadt: "Hamburg",
  });
  if (res.status !== 201) throw new Error(`createProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { id: res.data.id as number, name };
}

async function createApptInMonth(year: number, month: number, tag: string): Promise<{ id: number; time: string }> {
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = 1; day <= lastDay; day++) {
    const cand = new Date(year, month - 1, day);
    if (cand.getDay() === 0 || cand.getDay() === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId, date: dateStr, scheduledStart: time, notes: `INS-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id, services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) return { id: res.data.id, time };
    }
  }
  throw new Error(`createApptInMonth(${tag}): kein freier Werktag-Slot`);
}

async function documentAppointment(appointmentId: number, startTime: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime, travelOriginType: "home", travelKilometers: 0, customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Leistung" }],
  });
  if (res.status !== 200) throw new Error(`document(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function createSignedRecord(year: number, month: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", { customerId, employeeId: auth.user.id, year, month });
  if (res.status !== 201) throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  for (const signerType of ["employee", "customer"] as const) {
    const s = await apiPost<any>(`/api/service-records/${srId}/sign`, { signerType, signatureData: validSignatureDataUrl() });
    if (s.status !== 200) throw new Error(`sign(${srId},${signerType}) failed: ${s.status} ${JSON.stringify(s.data)}`);
  }
  return srId;
}

async function generateInvoice(year: number, month: number): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate", {
    customerId, billingMonth: month, billingYear: year,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`generate(${month}/${year}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  const hw = services.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("hauswirtschaft fehlt");
  hwServiceId = hw.id;
  const emp = await createTestEmployee({ nachnamePrefix: "TestINS" });
  testEmployeeId = emp.id;

  const a = await createProvider("alt");
  providerAId = a.id;
  providerAName = a.name;
  const b = await createProvider("neu");
  providerBId = b.id;
  providerBName = b.name;

  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "INS", nachname: `Wechsel-${uniqueId()}`, geburtsdatum: "1940-05-05",
    email: `ins-${uniqueId()}@test.local`, strasse: "Kundenweg", nr: "2", plz: "01067", stadt: "Dresden",
    telefon: "+4917600000077", pflegegrad: 3, pflegegradSeit: "2023-01-01",
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false, rechnungAnKunde: false,
  });
  if (res.status !== 201) throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  customerId = res.data.id as number;
  cleanupCustomerIds.push(customerId);
  await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id, backupEmployeeId: testEmployeeId, backupEmployeeId2: null,
  });

  // §45b-Budget ab dem Vor-Vormonat, damit beide Monate abrechenbar sind.
  const init = await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b", currentMonthAmountCents: 13100,
    carryoverAmountCents: 0, budgetStartDate: PREV2_START_ISO,
  });
  if (![200, 201].includes(init.status)) throw new Error(`init §45b failed: ${init.status} ${JSON.stringify(init.data)}`);
  const types = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  if (types.status !== 200) throw new Error(`type-settings failed: ${types.status} ${JSON.stringify(types.data)}`);

  // Kasse A ab dem Vor-Vormonat, Wechsel auf Kasse B zum 1. des Vormonats.
  const insA = await apiPost<any>(`/api/admin/customers/${customerId}/insurance`, {
    insuranceProviderId: providerAId, versichertennummer: "A123456789", validFrom: PREV2_START_ISO,
  });
  if (insA.status !== 201) throw new Error(`insurance A failed: ${insA.status} ${JSON.stringify(insA.data)}`);
  const insB = await apiPost<any>(`/api/admin/customers/${customerId}/insurance`, {
    insuranceProviderId: providerBId, versichertennummer: "B987654321", validFrom: SWITCH_ISO,
  });
  if (insB.status !== 201) throw new Error(`insurance B failed: ${insB.status} ${JSON.stringify(insB.data)}`);

  // Je ein dokumentierter, kundensignierter Monat.
  const a1 = await createApptInMonth(PREV2_YEAR, PREV2_MONTH, "prev2");
  await documentAppointment(a1.id, a1.time);
  await createSignedRecord(PREV2_YEAR, PREV2_MONTH);

  const a2 = await createApptInMonth(PREV_YEAR, PREV_MONTH, "prev");
  await documentAppointment(a2.id, a2.time);
  await createSignedRecord(PREV_YEAR, PREV_MONTH);
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ } }
  for (const id of cleanupCustomerIds) { try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ } }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Task #1893 — Rechnung geht an die im Abrechnungsmonat gültige Kasse", () => {
  it("KRITISCH — Vor-Vormonat ⇒ alte Kasse, Vormonat ⇒ neue Kasse (unabhängig vom Erstellungsdatum)", async () => {
    const older = await generateInvoice(PREV2_YEAR, PREV2_MONTH);
    const olderInvoice = older.invoice ?? older;
    expect(olderInvoice.insuranceProviderName).toBe(providerAName);
    expect(olderInvoice.versichertennummer).toBe("A123456789");
    expect(olderInvoice.recipientName).toContain(providerAName);

    const newer = await generateInvoice(PREV_YEAR, PREV_MONTH);
    const newerInvoice = newer.invoice ?? newer;
    expect(newerInvoice.insuranceProviderName).toBe(providerBName);
    expect(newerInvoice.versichertennummer).toBe("B987654321");
    expect(newerInvoice.recipientName).toContain(providerBName);
  });

  it("Payer-Liste ordnet den Monat der im Monat gültigen Kasse zu", async () => {
    const older = await apiGet<any[]>(`/api/billing/payers?year=${PREV2_YEAR}&month=${PREV2_MONTH}`);
    expect(older.status).toBe(200);
    const olderNames = older.data.map((p: any) => p.name);
    expect(olderNames).toContain(providerAName);
    expect(olderNames).not.toContain(providerBName);

    const newer = await apiGet<any[]>(`/api/billing/payers?year=${PREV_YEAR}&month=${PREV_MONTH}`);
    expect(newer.status).toBe(200);
    const newerNames = newer.data.map((p: any) => p.name);
    expect(newerNames).toContain(providerBName);
    expect(newerNames).not.toContain(providerAName);
  });
});

describe("Task #1893 — Fenster-Regeln beim Anlegen und Korrigieren", () => {
  it("Kassenwechsel zu einem anderen Tag als dem 1. wird abgelehnt", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${customerId}/insurance`, {
      insuranceProviderId: providerAId, versichertennummer: "A123456789",
      validFrom: iso(PREV_YEAR, PREV_MONTH, 15),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("Monatsersten");
  });

  it("beim Wechsel endet die Vorgängerzeile lückenlos am letzten Tag des Vormonats", async () => {
    const res = await apiGet<any[]>(`/api/admin/customers/${customerId}/insurance`);
    expect(res.status).toBe(200);
    const alt = res.data.find((e: any) => e.insuranceProviderId === providerAId);
    const neu = res.data.find((e: any) => e.insuranceProviderId === providerBId);
    expect(alt).toBeDefined();
    expect(neu).toBeDefined();
    // Letzter Tag des Vor-Vormonats = Tag vor dem Wechsel.
    const lastOfPrev2 = ymdLocal(new Date(PREV_YEAR, PREV_MONTH - 1, 0));
    expect(alt.validTo).toBe(lastOfPrev2);
    expect(neu.validFrom).toBe(SWITCH_ISO);
    expect(neu.validTo).toBeNull();
  });

  it("eine Korrektur, die die Fenster überlappen ließe, wird abgelehnt", async () => {
    const list = await apiGet<any[]>(`/api/admin/customers/${customerId}/insurance`);
    const neu = list.data.find((e: any) => e.insuranceProviderId === providerBId);
    // Neue Zeile einen Monat früher beginnen lassen ⇒ überlappt die alte.
    const earlier = iso(PREV2_YEAR, PREV2_MONTH, 1);
    const res = await apiPatch<any>(`/api/admin/customers/${customerId}/insurance/${neu.id}`, {
      validFrom: earlier,
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.data);
    expect(body === "" ? "" : body).toMatch(/überschneiden|selben Tag/);
  });

  it("eine Korrektur, die eine Lücke ließe, wird abgelehnt", async () => {
    const list = await apiGet<any[]>(`/api/admin/customers/${customerId}/insurance`);
    const alt = list.data.find((e: any) => e.insuranceProviderId === providerAId);
    // Alte Zeile einen Monat zu früh beenden ⇒ Lücke bis zum Wechsel.
    const tooEarly = ymdLocal(new Date(PREV2_YEAR, PREV2_MONTH - 1, 0));
    const res = await apiPatch<any>(`/api/admin/customers/${customerId}/insurance/${alt.id}`, {
      validTo: tooEarly,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("Lücke");
  });

  it("eine gültige Korrektur der Versichertennummer wird gespeichert", async () => {
    const list = await apiGet<any[]>(`/api/admin/customers/${customerId}/insurance`);
    const neu = list.data.find((e: any) => e.insuranceProviderId === providerBId);
    const res = await apiPatch<any>(`/api/admin/customers/${customerId}/insurance/${neu.id}`, {
      versichertennummer: "B111111111",
    });
    expect(res.status).toBe(200);
    expect(res.data.versichertennummer).toBe("B111111111");
    // Zurücksetzen, damit die Reihenfolge der Tests egal bleibt.
    await apiPatch<any>(`/api/admin/customers/${customerId}/insurance/${neu.id}`, {
      versichertennummer: "B987654321",
    });
  });
});
