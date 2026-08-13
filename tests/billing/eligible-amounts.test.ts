import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1905 — Beträge in der „Noch zu erstellen"-Liste: IST und PLAN.
 *
 * `GET /billing/eligible-customers` liefert je Kunde ZWEI Brutto-Beträge
 * (ERSETZT das frühere einzelne `estimatedAmountCents` aus #1887):
 *  • `actualAmountCents` (IST)  — dokumentierte, noch nicht abgerechnete Termine.
 *    Der abrechenbare Anteil kommt weiterhin aus `buildInvoiceDraft` (preview) —
 *    DIESELBE SSoT wie `/billing/preview` und die echte Erstellung, inkl. der
 *    #1883-Ausschlüsse; der nicht abrechenbare Rest über denselben Zeilen-Bauer.
 *  • `plannedAmountCents` (PLAN) — Prognose der noch offenen Termine.
 *
 * Kern-Assertionen: beim Bereit-Kunden ist IST == `/billing/preview.totalCents`
 * (ein Rechenweg, keine Drift); der dokumentierte-aber-nicht-abrechenbare Anteil
 * erscheint im IST (früher 0 → „—" in der Liste); offene Termine erscheinen NUR
 * im PLAN. Reiner Lesepfad — kein Schreiben/PDF.
 *
 * ISOLATION: nur eigene Kunden per `customerId`; vergangener Vormonat (3-Monats-
 * Grenze). `/eligible-customers` + `/preview` sind Reads → keine globalen Effekte.
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
const LAST_OF_PREV_MONTH = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
const BILLING_YEAR = LAST_OF_PREV_MONTH.getFullYear();
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1;
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();

async function createApptInMonth(customerId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let day = 1; day <= LAST_DAY; day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    if (cand.getDay() === 0 || cand.getDay() === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId, date: dateStr, scheduledStart: time, notes: `AMT-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id, services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
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

async function createSignedRecord(customerId: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", { customerId, employeeId: auth.user.id, year: BILLING_YEAR, month: BILLING_MONTH });
  if (res.status !== 201) throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  for (const signerType of ["employee", "customer"] as const) {
    const s = await apiPost<any>(`/api/service-records/${srId}/sign`, { signerType, signatureData: validSignatureDataUrl() });
    if (s.status !== 200) throw new Error(`sign(${srId},${signerType}) failed: ${s.status} ${JSON.stringify(s.data)}`);
  }
  return srId;
}

async function createSelbstzahler(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "AMT", nachname: `Privat-${tag}-${uniqueId()}`, geburtsdatum: "1942-03-10",
    email: `amt-${tag}-${uniqueId()}@test.local`, strasse: "Teststraße", nr: "1", plz: "10115", stadt: "Berlin",
    pflegegrad: 2, pflegegradSeit: "2024-01-01", billingType: "selbstzahler", acceptsPrivatePayment: true,
    contacts: [{ contactType: "familie", isPrimary: true, vorname: "K", nachname: "A", mobilnummer: "+4917600000010" }],
  });
  if (res.status !== 201) throw new Error(`createSelbstzahler failed: ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, { primaryEmployeeId: auth.user.id, backupEmployeeId: testEmployeeId, backupEmployeeId2: null });
  return id;
}

async function eligibleRowFor(customerId: number): Promise<any> {
  const res = await apiGet<any[]>(`/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`);
  if (res.status !== 200) throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.find((c) => c.id === customerId);
}

async function previewTotalCents(customerId: number): Promise<number> {
  const res = await apiGet<any>(`/api/billing/preview?customerId=${customerId}&month=${BILLING_MONTH}&year=${BILLING_YEAR}`);
  if (res.status !== 200) throw new Error(`preview failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.totalCents as number;
}

let readyId: number;
let partialId: number;
let lnMissingId: number;
let openOnlyId: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  const hw = services.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("hauswirtschaft fehlt");
  hwServiceId = hw.id;
  const emp = await createTestEmployee({ nachnamePrefix: "TestAMT" });
  testEmployeeId = emp.id;

  // Ready: 1 dokumentierter Termin + kundensignierter LN.
  readyId = await createSelbstzahler("ready");
  const rA = await createApptInMonth(readyId, "ready");
  await documentAppointment(rA.id, rA.time);
  await createSignedRecord(readyId);

  // Mischkunde/teil-dokumentiert: appt1 signiert (abrechenbar) + appt2 dokumentiert OHNE LN.
  partialId = await createSelbstzahler("partial");
  const pA = await createApptInMonth(partialId, "p-cov");
  await documentAppointment(pA.id, pA.time);
  await createSignedRecord(partialId); // deckt appt1
  const pB = await createApptInMonth(partialId, "p-uncov");
  await documentAppointment(pB.id, pB.time); // appt2 dokumentiert, KEIN LN

  // Nicht abrechenbar (LN fehlt): dokumentierter Termin, kein LN.
  lnMissingId = await createSelbstzahler("lnmissing");
  const lA = await createApptInMonth(lnMissingId, "lnmiss");
  await documentAppointment(lA.id, lA.time);

  // Task #1905 — nur ein OFFENER (geplanter, nicht dokumentierter) Termin:
  // reiner PLAN-Fall, IST muss 0 bleiben.
  openOnlyId = await createSelbstzahler("openonly");
  await createApptInMonth(openOnlyId, "openonly");
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ } }
  for (const id of cleanupCustomerIds) { try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ } }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Task #1905 — IST/PLAN-Beträge je Kunde in der Rechnungsliste", () => {
  it("Bereit zum Abrechnen: IST == Vorschau-/Erstellungsbetrag (> 0), PLAN == 0", async () => {
    const row = await eligibleRowFor(readyId);
    expect(row).toBeDefined();
    const preview = await previewTotalCents(readyId);
    expect(preview).toBeGreaterThan(0);
    // Ein Rechenweg: die „Bereit"-Summe ist exakt die spätere Rechnungssumme.
    expect(row.actualAmountCents).toBe(preview);
    // Keine offenen Termine ⇒ kein Prognose-Anteil.
    expect(row.plannedAmountCents).toBe(0);
  });

  it("Mischkunde: IST enthält den signierten UND den dokumentiert-unsignierten Termin", async () => {
    const row = await eligibleRowFor(partialId);
    expect(row).toBeDefined();
    // teil-dokumentiert: 2 completed, 1 abgedeckt.
    expect(row.completedAppointments).toBe(2);
    expect(row.coveredAppointments).toBe(1);

    const preview = await previewTotalCents(partialId);
    const readyRow = await eligibleRowFor(readyId);
    // Die Vorschau (= was JETZT abgerechnet würde) bleibt der signierte Teil …
    expect(preview).toBe(readyRow.actualAmountCents);
    // … das IST zeigt die geleistete Arbeit BEIDER Termine. Genau hier lag der
    // frühere Informationsverlust: der zweite, dokumentierte Termin war im
    // Listen-Betrag unsichtbar.
    expect(row.actualAmountCents).toBe(2 * readyRow.actualAmountCents);
    expect(row.plannedAmountCents).toBe(0);
  });

  it("dokumentiert, aber kein LN: IST > 0 (füllt das frühere Gedankenstrich-Feld), PLAN == 0", async () => {
    const row = await eligibleRowFor(lnMissingId);
    expect(row).toBeDefined();
    const readyRow = await eligibleRowFor(readyId);
    // Vor #1905 stand hier 0 → die Liste zeigte „—", obwohl Arbeit geleistet war.
    expect(row.actualAmountCents).toBe(readyRow.actualAmountCents);
    expect(row.plannedAmountCents).toBe(0);
  });

  it("nur offener Termin: PLAN > 0, IST == 0 (Prognose zählt nie als geleistet)", async () => {
    const row = await eligibleRowFor(openOnlyId);
    expect(row).toBeDefined();
    expect(row.openAppointments).toBe(1);
    expect(row.completedAppointments).toBe(0);
    expect(row.actualAmountCents).toBe(0);
    const readyRow = await eligibleRowFor(readyId);
    // Gleiche Leistung/Dauer wie der dokumentierte Termin ⇒ gleicher Betrag,
    // nur eben als PLAN statt IST.
    expect(row.plannedAmountCents).toBe(readyRow.actualAmountCents);
  });

  it("Preview-only: der Ready-Kunde bleibt nach der Betrags-Abfrage gelistet (kein Schreibpfad)", async () => {
    // Zweiter Abruf: hätte die Betrags-Berechnung eine Rechnung geschrieben, wäre der
    // Kunde jetzt „vollständig abgerechnet" und verschwunden.
    const row = await eligibleRowFor(readyId);
    expect(row, "Ready-Kunde muss weiter gelistet sein (Betrag = preview-only)").toBeDefined();
    expect(row.eligibility.status).toBe("eligible");
  });
});
