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
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testEmployeeId: number;
let hwServiceId: number;

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
): Promise<boolean> {
  let url = `/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`;
  if (range) url += `&dateFrom=${range.from}&dateTo=${range.to}`;
  const res = await apiGet<any[]>(url);
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.some((c: any) => c.id === customerId);
}

async function generateAll(range?: { from: string; to: string }): Promise<any> {
  const body: Record<string, any> = { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR };
  if (range) {
    body.dateFrom = range.from;
    body.dateTo = range.to;
  }
  const res = await apiPost<any>("/api/billing/generate-all", body);
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
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
