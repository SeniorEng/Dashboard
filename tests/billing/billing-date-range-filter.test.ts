import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Abrechnungs-Zeitraum-Filter (von–bis) — Integrationstests (Task #1318)
 *
 * Sichert das in Task #1317 ergänzte Datumsbereich-Filter-Verhalten der
 * Abrechnung über alle drei Schichten ab:
 *
 *   1. GET /api/billing (Rechnungsliste) mit dateFrom/dateTo liefert NUR
 *      Rechnungen, deren Termine im Bereich liegen. Leerer Bereich = ganzer
 *      Monat (Bestandsverhalten).
 *   2. GET /api/billing/eligible-customers + POST /api/billing/generate-all
 *      rechnen nur Termine innerhalb des Bereichs ab; der „berechtigt?"-Scope
 *      (und damit der Massenerstellungs-Counter) verengt sich entsprechend.
 *   3. Klare Fehlermeldung, wenn im gewählten Bereich keine abrechenbaren
 *      Termine liegen.
 *
 * ISOLATION: Es gibt keine kundenbezogene Filterung in generate-all /
 * eligible-customers (nur optional nach Pflegekasse). Wir verwenden daher
 * Selbstzahler-Kunden (kein Budget-Split, exakt eine Rechnung pro Lauf) und
 * prüfen IMMER nur den Ergebnis-Eintrag des EIGENEN Kunden (Filter per
 * `customerId`), nie globale Summen — robust gegen parallele/leftover Kunden
 * im selben Worker. Die Rechnungsliste filtern wir direkt über den
 * `customerId`-Query-Parameter der Route.
 *
 * DATUM: Wir verwenden den vollständig vergangenen Vormonat (innerhalb der
 * 3-Monats-Vergangenheits-Grenze für die Termin-Anlage) und teilen ihn in eine
 * frühe (Tag 1–14) und eine späte (Tag 15–Monatsende) Hälfte. Pro Hälfte wird
 * ein dokumentierter Werktags-Termin angelegt. Selbstzahler haben kein Budget,
 * daher gibt es keinen Jahres-/Statut-Cap-Edge-Case.
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
let insuranceProviderId: number;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];

// ---------- Datum / Slots ----------

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Breite Auswahl an Randzeiten, die in der Praxis selten mit anderen Tests
// kollidieren (Test-Admin hat Vorrang vor regulären Slot-Sperren).
const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

// Vollständig vergangener Vormonat (innerhalb der 3-Monats-Grenze).
const NOW = new Date();
const FIRST_OF_THIS_MONTH = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
const LAST_OF_PREV_MONTH = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
const BILLING_YEAR = LAST_OF_PREV_MONTH.getFullYear();
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1; // 1-12
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();
const MM = String(BILLING_MONTH).padStart(2, "0");

// Frühe Hälfte: Tag 1–14, späte Hälfte: Tag 15–Monatsende.
const EARLY_FROM = `${BILLING_YEAR}-${MM}-01`;
const EARLY_TO = `${BILLING_YEAR}-${MM}-14`;
const LATE_FROM = `${BILLING_YEAR}-${MM}-15`;
const LATE_TO = `${BILLING_YEAR}-${MM}-${String(LAST_DAY).padStart(2, "0")}`;

/**
 * Legt einen Kundentermin auf einem freien Werktag innerhalb eines Tagesbereichs
 * des Abrechnungsmonats an. Wirft deterministisch, wenn nichts frei ist.
 */
async function createApptInDayRange(
  customerId: number,
  durationMinutes: number,
  dayMin: number,
  dayMax: number,
  tag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let day = dayMin; day <= Math.min(dayMax, LAST_DAY); day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue; // Wochenende überspringen
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `DRF-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(
    `createApptInDayRange(${tag}): kein freier Werktag-Slot in Tagen ${dayMin}-${dayMax} von ${BILLING_YEAR}-${MM}`,
  );
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  actualMinutes: number,
  details: string,
): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: actualMinutes, details }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function createAndSignServiceRecord(customerId: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year: BILLING_YEAR,
    month: BILLING_MONTH,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  for (const signerType of ["employee", "customer"] as const) {
    const signRes = await apiPost<any>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (signRes.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${signRes.status} ${JSON.stringify(signRes.data)}`);
    }
  }
  return srId;
}

/** Legt einen Selbstzahler-Kunden an und weist den Test-Admin zu. */
async function createSelbstzahlerCustomer(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "DRF",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `drf-${tag}-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "1",
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
        nachname: "DRF",
        mobilnummer: "+4917600000010",
      },
    ],
  });
  if (res.status !== 201) {
    throw new Error(`createSelbstzahlerCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
  return id;
}

/**
 * Legt einen Pflegekasse-Kunden (pflegekasse_privat) MIT aktiver Pflegekasse
 * (`insuranceProviderId`) an und weist den Test-Admin zu. Dadurch greift der
 * Kassen-Filter (`insuranceProviderId`) in eligible-customers / generate-all.
 */
async function createPflegekasseCustomer(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "DRF",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1938-05-12",
    email: `drf-${tag}-${uniqueId()}@test.local`,
    strasse: "Teststraße",
    nr: "5",
    plz: "10117",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "DRF",
        mobilnummer: "+4917600000011",
      },
    ],
    budgets: {
      // Werte in CENTS. Voller §45b-Topf als Default — wird unten via
      // configureLowBudgetPV auf ein niedriges Monatslimit überschrieben.
      entlastungsbetrag45b: 13100,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
  });
  if (res.status !== 201) {
    throw new Error(`createPflegekasseCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
  return id;
}

/**
 * Setzt ein sehr niedriges §45b-Monatslimit (1 €/Monat). Der §45b-Topf
 * akkumuliert ab Januar (Stichtag = heute), bleibt damit klar unter den Kosten
 * eines 60-min-HW-Termins (~35 €) und erzwingt deterministisch den Pot-Split
 * (kleiner §45b-Anteil + privater Überlauf) — identisch zur Split-Konfiguration
 * in billing-flow.test.ts.
 */
async function configureLowBudgetPV(customerId: number): Promise<void> {
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 100 },
      { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
    ],
  });
}

async function listInvoices(
  customerId: number,
  range?: { from: string; to: string },
): Promise<any[]> {
  let url = `/api/billing?customerId=${customerId}&year=${BILLING_YEAR}&month=${BILLING_MONTH}`;
  if (range) url += `&dateFrom=${range.from}&dateTo=${range.to}`;
  const res = await apiGet<any[]>(url);
  if (res.status !== 200) {
    throw new Error(`listInvoices(${customerId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function eligibleContains(
  customerId: number,
  range?: { from: string; to: string },
  providerId?: number,
): Promise<boolean> {
  let url = `/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`;
  if (range) url += `&dateFrom=${range.from}&dateTo=${range.to}`;
  if (providerId) url += `&insuranceProviderId=${providerId}`;
  const res = await apiGet<any[]>(url);
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.some((c: any) => c.id === customerId);
}

async function generateAll(
  range?: { from: string; to: string },
  providerId?: number,
): Promise<any> {
  const body: Record<string, any> = { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR };
  if (range) {
    body.dateFrom = range.from;
    body.dateTo = range.to;
  }
  if (providerId) body.insuranceProviderId = providerId;
  const res = await apiPost<any>("/api/billing/generate-all", body);
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

/**
 * Task #1320: Einzel-Pfad — `POST /api/billing/generate` mit optionalem
 * von–bis-Datumsbereich. Gibt das rohe Response-Objekt zurück (kein Throw bei
 * 400), damit Tests sowohl Erfolg als auch fachliche Fehler prüfen können.
 */
async function generateSingle(
  customerId: number,
  range?: { from: string; to: string },
): Promise<{ status: number; data: any }> {
  const body: Record<string, any> = {
    customerId,
    billingMonth: BILLING_MONTH,
    billingYear: BILLING_YEAR,
  };
  if (range) {
    body.dateFrom = range.from;
    body.dateTo = range.to;
  }
  const res = await apiPost<any>("/api/billing/generate", body);
  return { status: res.status, data: res.data };
}

function resultFor(gaData: any, customerId: number): any {
  return (gaData.results ?? []).find((r: any) => r.customerId === customerId);
}

async function lineItemAppointmentIds(invoiceId: number): Promise<number[]> {
  const res = await apiGet<any>(`/api/billing/${invoiceId}`);
  if (res.status !== 200) {
    throw new Error(`loadInvoice(${invoiceId}) failed: ${res.status}`);
  }
  const items = res.data?.lineItems ?? res.data?.items ?? [];
  return items
    .map((li: any) => li.appointmentId)
    .filter((x: any): x is number => typeof x === "number");
}

// ---------- Lifecycle ----------

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  if (provRes.status !== 200 || provRes.data.length === 0) {
    throw new Error("Keine Versicherer in der Test-DB vorhanden");
  }
  insuranceProviderId = provRes.data[0].id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestDRF" });
  testEmployeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ }
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ }
  }
  await deactivateTestEmployee(testEmployeeId);
});

// ---------------------------------------------------------------------------

describe("DRF-1: GET /api/billing — Datumsbereich verengt die Rechnungsliste", () => {
  let customerId: number;
  let earlyApptId: number;
  let lateApptId: number;
  let earlyInvoiceId: number;
  let lateInvoiceId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("list");
    const early = await createApptInDayRange(customerId, 30, 1, 14, "list-early");
    const late = await createApptInDayRange(customerId, 30, 15, LAST_DAY, "list-late");
    earlyApptId = early.id;
    lateApptId = late.id;
    await documentAppointment(early.id, early.time, 30, "list-early");
    await documentAppointment(late.id, late.time, 30, "list-late");
    await createAndSignServiceRecord(customerId);

    // Pro Hälfte eine eigene Rechnung erzeugen (Teil-Abrechnung). Der grobe
    // „hat schon eine Rechnung im Monat"-Skip wird bei gesetztem Bereich
    // bewusst übersprungen, daher entstehen zwei getrennte Rechnungen.
    const gaEarly = await generateAll({ from: EARLY_FROM, to: EARLY_TO });
    expect(resultFor(gaEarly, customerId)?.status).toBe("created");
    const gaLate = await generateAll({ from: LATE_FROM, to: LATE_TO });
    expect(resultFor(gaLate, customerId)?.status).toBe("created");

    const both = await listInvoices(customerId);
    expect(both.length).toBe(2);
    const earlyInv = both.find((inv) => inv.id !== undefined && inv.billingMonth === BILLING_MONTH);
    expect(earlyInv).toBeDefined();
  });

  it("DRF-1.1 — ohne Datumsbereich werden alle Rechnungen des Monats geliefert (leerer Bereich = ganzer Monat)", async () => {
    const all = await listInvoices(customerId);
    expect(all.length).toBe(2);
  });

  it("DRF-1.2 — frühe Hälfte liefert nur die Rechnung mit dem frühen Termin", async () => {
    const earlyList = await listInvoices(customerId, { from: EARLY_FROM, to: EARLY_TO });
    expect(earlyList.length).toBe(1);
    earlyInvoiceId = earlyList[0].id;
    const apptIds = await lineItemAppointmentIds(earlyInvoiceId);
    expect(apptIds).toContain(earlyApptId);
    expect(apptIds).not.toContain(lateApptId);
  });

  it("DRF-1.3 — späte Hälfte liefert nur die Rechnung mit dem späten Termin", async () => {
    const lateList = await listInvoices(customerId, { from: LATE_FROM, to: LATE_TO });
    expect(lateList.length).toBe(1);
    lateInvoiceId = lateList[0].id;
    const apptIds = await lineItemAppointmentIds(lateInvoiceId);
    expect(apptIds).toContain(lateApptId);
    expect(apptIds).not.toContain(earlyApptId);
  });

  it("DRF-1.4 — frühe und späte Rechnung sind verschiedene Belege", async () => {
    const earlyList = await listInvoices(customerId, { from: EARLY_FROM, to: EARLY_TO });
    const lateList = await listInvoices(customerId, { from: LATE_FROM, to: LATE_TO });
    expect(earlyList[0].id).not.toBe(lateList[0].id);
  });
});

describe("DRF-2: eligible-customers + generate-all rechnen nur im Bereich ab", () => {
  let customerId: number;
  let earlyApptId: number;
  let lateApptId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("scope");
    const early = await createApptInDayRange(customerId, 30, 1, 14, "scope-early");
    const late = await createApptInDayRange(customerId, 30, 15, LAST_DAY, "scope-late");
    earlyApptId = early.id;
    lateApptId = late.id;
    await documentAppointment(early.id, early.time, 30, "scope-early");
    await documentAppointment(late.id, late.time, 30, "scope-late");
    await createAndSignServiceRecord(customerId);
  });

  it("DRF-2.1 — vor Abrechnung ist der Kunde in beiden Bereichen berechtigt", async () => {
    expect(await eligibleContains(customerId, { from: EARLY_FROM, to: EARLY_TO })).toBe(true);
    expect(await eligibleContains(customerId, { from: LATE_FROM, to: LATE_TO })).toBe(true);
  });

  it("DRF-2.2 — generate-all für die frühe Hälfte erzeugt genau eine Rechnung, die nur den frühen Termin enthält", async () => {
    const ga = await generateAll({ from: EARLY_FROM, to: EARLY_TO });
    const r = resultFor(ga, customerId);
    expect(r?.status).toBe("created");
    expect(r?.invoiceCount).toBe(1);

    const earlyList = await listInvoices(customerId, { from: EARLY_FROM, to: EARLY_TO });
    expect(earlyList.length).toBe(1);
    const apptIds = await lineItemAppointmentIds(earlyList[0].id);
    expect(apptIds).toContain(earlyApptId);
    expect(apptIds).not.toContain(lateApptId);
  });

  it("DRF-2.3 — nach Abrechnung der frühen Hälfte verengt sich der Berechtigt-Scope (früh nicht mehr, spät weiterhin)", async () => {
    expect(await eligibleContains(customerId, { from: EARLY_FROM, to: EARLY_TO })).toBe(false);
    expect(await eligibleContains(customerId, { from: LATE_FROM, to: LATE_TO })).toBe(true);
  });

  it("DRF-2.4 — generate-all für die späte Hälfte rechnet den verbleibenden späten Termin ab", async () => {
    const ga = await generateAll({ from: LATE_FROM, to: LATE_TO });
    const r = resultFor(ga, customerId);
    expect(r?.status).toBe("created");
    expect(r?.invoiceCount).toBe(1);

    const lateList = await listInvoices(customerId, { from: LATE_FROM, to: LATE_TO });
    expect(lateList.length).toBe(1);
    const apptIds = await lineItemAppointmentIds(lateList[0].id);
    expect(apptIds).toContain(lateApptId);
    expect(apptIds).not.toContain(earlyApptId);

    // Nach beiden Teil-Läufen sind genau zwei Rechnungen entstanden.
    const all = await listInvoices(customerId);
    expect(all.length).toBe(2);
  });
});

describe("DRF-3: Klare Fehlermeldung bei leerem Bereich (keine abrechenbaren Termine)", () => {
  let customerId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("empty");
    // Nur ein Termin in der FRÜHEN Hälfte — der LN ist signiert, der Kunde ist
    // also grundsätzlich abrechenbar, aber in der SPÄTEN Hälfte liegt nichts.
    const early = await createApptInDayRange(customerId, 30, 1, 14, "empty-early");
    await documentAppointment(early.id, early.time, 30, "empty-early");
    await createAndSignServiceRecord(customerId);
  });

  it("DRF-3.1 — generate-all mit Bereich ohne Termine liefert für den Kunden status=error mit klarer Meldung", async () => {
    const ga = await generateAll({ from: LATE_FROM, to: LATE_TO });
    const r = resultFor(ga, customerId);
    expect(r).toBeDefined();
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/Im gewählten Datumsbereich gibt es keine abrechenbaren Termine/);

    // Es darf keine Rechnung für diesen Kunden entstanden sein.
    const all = await listInvoices(customerId);
    expect(all.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DRF-4: Pflegekasse-Kunde — Kassen-Filter (insuranceProviderId) UND
// Datumsbereich (dateFrom/dateTo) komponieren, auch wenn ein Lauf eine
// Pot-Split-Rechnung (mehrere Belege über billing_run_id) erzeugt (Task #1319).
//
// Aufbau:
//   - PV-Kunde (pflegekasse_privat, aktive Pflegekasse, niedriges §45b-Limit)
//     mit je einem dokumentierten Werktags-Termin in früher (Tag 1–14) und
//     später (Tag 15–Monatsende) Hälfte. Niedriges §45b erzwingt den Split
//     (kleiner Kassen-Anteil + privater Überlauf) für den ZUERST dokumentierten
//     (frühen) Termin.
//   - Selbstzahler-Kunde (KEINE Pflegekasse) mit einem frühen Termin als
//     Negativ-Kontrolle für den Kassen-Filter.
// ---------------------------------------------------------------------------

describe("DRF-4: Pflegekasse — Kassen-Filter + Datumsbereich + Pot-Split komponieren", () => {
  let fundCustomerId: number; // Pflegekasse-Kunde mit gewählter Kasse
  let szCustomerId: number;   // Selbstzahler ohne Kasse (Negativ-Kontrolle)
  let earlyApptId: number;
  let lateApptId: number;

  beforeAll(async () => {
    // Pflegekasse-Kunde: niedriges §45b → Split. Frühen Termin ZUERST
    // dokumentieren, damit er den kleinen §45b-Topf greift und splittet.
    fundCustomerId = await createPflegekasseCustomer("fund");
    await configureLowBudgetPV(fundCustomerId);
    const early = await createApptInDayRange(fundCustomerId, 60, 1, 14, "fund-early");
    const late = await createApptInDayRange(fundCustomerId, 60, 15, LAST_DAY, "fund-late");
    earlyApptId = early.id;
    lateApptId = late.id;
    await documentAppointment(early.id, early.time, 60, "fund-early");
    await documentAppointment(late.id, late.time, 60, "fund-late");
    await createAndSignServiceRecord(fundCustomerId);

    // Selbstzahler: hat einen frühen, im Bereich liegenden, abrechenbaren
    // Termin — darf aber NIE im Kassen-gefilterten Lauf auftauchen.
    szCustomerId = await createSelbstzahlerCustomer("fund-sz");
    const szEarly = await createApptInDayRange(szCustomerId, 30, 1, 14, "fund-sz-early");
    await documentAppointment(szEarly.id, szEarly.time, 30, "fund-sz-early");
    await createAndSignServiceRecord(szCustomerId);
  });

  it("DRF-4.1 — eligible-customers mit Kasse+Bereich: Kassen-Kunde berechtigt, Selbstzahler ausgeschlossen", async () => {
    // Frühe Hälfte + Kassen-Filter: Pflegekasse-Kunde drin, Selbstzahler raus.
    expect(await eligibleContains(fundCustomerId, { from: EARLY_FROM, to: EARLY_TO }, insuranceProviderId)).toBe(true);
    expect(await eligibleContains(szCustomerId, { from: EARLY_FROM, to: EARLY_TO }, insuranceProviderId)).toBe(false);

    // Gegenprobe: OHNE Kassen-Filter ist der Selbstzahler im Bereich berechtigt
    // (der Ausschluss kommt also wirklich vom Kassen-Filter, nicht vom Bereich).
    expect(await eligibleContains(szCustomerId, { from: EARLY_FROM, to: EARLY_TO })).toBe(true);
  });

  it("DRF-4.2 — generate-all (Kasse + frühe Hälfte) erzeugt einen Pot-Split, der NUR den frühen Termin enthält", async () => {
    const ga = await generateAll({ from: EARLY_FROM, to: EARLY_TO }, insuranceProviderId);

    // Selbstzahler darf durch den Kassen-Filter nicht abgerechnet worden sein.
    expect(resultFor(ga, szCustomerId)).toBeUndefined();
    const szInvoices = await listInvoices(szCustomerId);
    expect(szInvoices.length).toBe(0);

    // Pflegekasse-Kunde: Split → invoiceCount = 2 (Kasse + Privat).
    const r = resultFor(ga, fundCustomerId);
    expect(r?.status).toBe("created");
    expect(r?.invoiceCount).toBe(2);

    // Genau zwei Rechnungen in der frühen Hälfte, beide über dieselbe
    // billing_run_id verbunden, aus Kasse + Privat bestehend.
    const earlyList = await listInvoices(fundCustomerId, { from: EARLY_FROM, to: EARLY_TO });
    expect(earlyList.length).toBe(2);

    const runIds = new Set(earlyList.map((inv) => inv.billingRunId));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBeTruthy();

    const billingTypes = earlyList.map((inv) => inv.billingType).sort();
    expect(billingTypes).toEqual(["pflegekasse_privat", "selbstzahler"]);

    // Beide Split-Belege referenzieren NUR den frühen Termin — der späte
    // Termin liegt außerhalb des Bereichs und darf nirgendwo auftauchen.
    for (const inv of earlyList) {
      const apptIds = await lineItemAppointmentIds(inv.id);
      expect(apptIds).toContain(earlyApptId);
      expect(apptIds).not.toContain(lateApptId);
    }
  });

  it("DRF-4.3 — nach Abrechnung der frühen Hälfte verengt sich der Berechtigt-Scope (früh nicht mehr, spät weiterhin)", async () => {
    expect(await eligibleContains(fundCustomerId, { from: EARLY_FROM, to: EARLY_TO }, insuranceProviderId)).toBe(false);
    expect(await eligibleContains(fundCustomerId, { from: LATE_FROM, to: LATE_TO }, insuranceProviderId)).toBe(true);
  });

  it("DRF-4.4 — generate-all (Kasse + späte Hälfte) rechnet den verbleibenden späten Termin separat ab", async () => {
    const ga = await generateAll({ from: LATE_FROM, to: LATE_TO }, insuranceProviderId);
    const r = resultFor(ga, fundCustomerId);
    expect(r?.status).toBe("created");

    const lateList = await listInvoices(fundCustomerId, { from: LATE_FROM, to: LATE_TO });
    expect(lateList.length).toBeGreaterThanOrEqual(1);

    // Alle Belege der späten Hälfte referenzieren NUR den späten Termin.
    for (const inv of lateList) {
      const apptIds = await lineItemAppointmentIds(inv.id);
      expect(apptIds).toContain(lateApptId);
      expect(apptIds).not.toContain(earlyApptId);
    }

    // Die späten Belege tragen eine ANDERE billing_run_id als die frühen
    // (zwei getrennte Teil-Abrechnungs-Läufe).
    const earlyList = await listInvoices(fundCustomerId, { from: EARLY_FROM, to: EARLY_TO });
    const earlyRunIds = new Set(earlyList.map((inv) => inv.billingRunId));
    for (const inv of lateList) {
      expect(earlyRunIds.has(inv.billingRunId)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// DRF-5: POST /api/billing/generate (Einzel-Pfad) respektiert den
// Datumsbereich (dateFrom/dateTo) genauso wie der generate-all-Pfad (Task #1320).
// ---------------------------------------------------------------------------

describe("DRF-5: POST /api/billing/generate (Einzel-Pfad) respektiert den Datumsbereich (Task #1320)", () => {
  let customerId: number;
  let earlyApptId: number;
  let lateApptId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("single");
    const early = await createApptInDayRange(customerId, 30, 1, 14, "single-early");
    const late = await createApptInDayRange(customerId, 30, 15, LAST_DAY, "single-late");
    earlyApptId = early.id;
    lateApptId = late.id;
    await documentAppointment(early.id, early.time, 30, "single-early");
    await documentAppointment(late.id, late.time, 30, "single-late");
    await createAndSignServiceRecord(customerId);
  });

  it("DRF-5.1 — Einzel-Generierung der frühen Hälfte rechnet NUR den frühen Termin ab", async () => {
    const res = await generateSingle(customerId, { from: EARLY_FROM, to: EARLY_TO });
    expect(res.status).toBe(200);

    const earlyList = await listInvoices(customerId, { from: EARLY_FROM, to: EARLY_TO });
    expect(earlyList.length).toBe(1);
    const apptIds = await lineItemAppointmentIds(earlyList[0].id);
    expect(apptIds).toContain(earlyApptId);
    expect(apptIds).not.toContain(lateApptId);
  });

  it("DRF-5.2 — nach der frühen Teil-Rechnung kann der späte Termin einzeln nachberechnet werden", async () => {
    const res = await generateSingle(customerId, { from: LATE_FROM, to: LATE_TO });
    expect(res.status).toBe(200);

    const lateList = await listInvoices(customerId, { from: LATE_FROM, to: LATE_TO });
    expect(lateList.length).toBe(1);
    const apptIds = await lineItemAppointmentIds(lateList[0].id);
    expect(apptIds).toContain(lateApptId);
    expect(apptIds).not.toContain(earlyApptId);

    // Insgesamt zwei getrennte Belege (frühe + späte Teil-Abrechnung).
    const all = await listInvoices(customerId);
    expect(all.length).toBe(2);
  });
});

describe("DRF-6: Einzel-Pfad ohne Bereich rechnet weiterhin den ganzen Monat ab", () => {
  let customerId: number;
  let earlyApptId: number;
  let lateApptId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("single-full");
    const early = await createApptInDayRange(customerId, 30, 1, 14, "single-full-early");
    const late = await createApptInDayRange(customerId, 30, 15, LAST_DAY, "single-full-late");
    earlyApptId = early.id;
    lateApptId = late.id;
    await documentAppointment(early.id, early.time, 30, "single-full-early");
    await documentAppointment(late.id, late.time, 30, "single-full-late");
    await createAndSignServiceRecord(customerId);
  });

  it("DRF-6.1 — ohne Datumsbereich enthält die eine Rechnung beide Termine des Monats", async () => {
    const res = await generateSingle(customerId);
    expect(res.status).toBe(200);

    const all = await listInvoices(customerId);
    expect(all.length).toBe(1);
    const apptIds = await lineItemAppointmentIds(all[0].id);
    expect(apptIds).toContain(earlyApptId);
    expect(apptIds).toContain(lateApptId);
  });
});
