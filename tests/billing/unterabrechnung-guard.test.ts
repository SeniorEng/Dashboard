import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1883 — Guard gegen stille Unterabrechnung (Variante B, Confirm-to-proceed).
 *
 * Beim Rechnung-Erstellen darf KEIN dokumentierter Termin still aus der Rechnung
 * fallen. Zwei validierte Leaks:
 *   1. Teil-dokumentiert (Kraft/Hentschel): completed-Termin ganz ohne LN.
 *   2. Lücke-1-Root (Funke): nur mitarbeitersignierte (`employee_signed`) Termine
 *      bei Pflegekasse — gelten in der Coverage als „covered", werden aber nicht
 *      gebucht (nur `completed`).
 * Der Guard stützt sich auf die ECHTE Ausschlussmenge von `invoice-calc`
 * (`excludedAppointments`, dieselbe SSoT wie die Vorschau) — NICHT auf
 * `isPartiallyDocumented`. Ohne `confirmPartial` bricht `/generate` mit 409 ab und
 * nennt die Termine; mit `confirmPartial` wird der signierte Teil abgerechnet.
 *
 * ISOLATION: immer nur der eigene Kunde per `customerId`. DATUM: vergangener
 * Vormonat (innerhalb der 3-Monats-Grenze), wie die übrigen Billing-E2E-Tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
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

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
const MONTH_START_ISO = `${BILLING_YEAR}-${String(BILLING_MONTH).padStart(2, "0")}-01`;

async function createApptInMonth(customerId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let day = 1; day <= LAST_DAY; day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `GUARD-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
    }
  }
  throw new Error(`createApptInMonth(${tag}): kein freier Werktag-Slot`);
}

async function documentAppointment(appointmentId: number, startTime: string): Promise<void> {
  const res = await apiPost<any>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "Leistung" }],
  });
  if (res.status !== 200) throw new Error(`document(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function createServiceRecord(customerId: number): Promise<number> {
  const res = await apiPost<any>("/api/service-records", { customerId, employeeId: auth.user.id, year: BILLING_YEAR, month: BILLING_MONTH });
  if (res.status !== 201) throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  return srId;
}

async function signServiceRecord(srId: number, signerType: "employee" | "customer"): Promise<void> {
  const res = await apiPost<any>(`/api/service-records/${srId}/sign`, { signerType, signatureData: validSignatureDataUrl() });
  if (res.status !== 200) throw new Error(`sign(${srId},${signerType}) failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function assignPrimary(customerId: number): Promise<void> {
  await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id, backupEmployeeId: testEmployeeId, backupEmployeeId2: null,
  });
}

async function createSelbstzahler(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "GUARD", nachname: `Privat-${uniqueId()}`, geburtsdatum: "1942-03-10",
    email: `guard-privat-${uniqueId()}@test.local`, strasse: "Teststraße", nr: "1", plz: "10115", stadt: "Berlin",
    pflegegrad: 2, pflegegradSeit: "2024-01-01", billingType: "selbstzahler", acceptsPrivatePayment: true,
    contacts: [{ contactType: "familie", isPrimary: true, vorname: "K", nachname: "G", mobilnummer: "+4917600000010" }],
  });
  if (res.status !== 201) throw new Error(`createSelbstzahler failed: ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await assignPrimary(id);
  return id;
}

async function createPflegekasse(): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "GUARD", nachname: `Kasse-${uniqueId()}`, geburtsdatum: "1941-03-22",
    email: `guard-kasse-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "7", plz: "01067", stadt: "Dresden",
    telefon: "+4917600000099", pflegegrad: 3, pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  if (res.status !== 201) throw new Error(`createPflegekasse failed: ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await assignPrimary(id);
  const init = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b", currentMonthAmountCents: 13100, carryoverAmountCents: 0, budgetStartDate: MONTH_START_ISO,
  });
  if (![200, 201].includes(init.status)) throw new Error(`init §45b failed: ${init.status} ${JSON.stringify(init.data)}`);
  const types = await apiPut<any>(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  if (types.status !== 200) throw new Error(`type-settings failed: ${types.status} ${JSON.stringify(types.data)}`);
  return id;
}

async function generateSingle(customerId: number, body: Record<string, unknown> = {}): Promise<{ status: number; data: any }> {
  return apiPost<any>("/api/billing/generate", { customerId, billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR, ...body });
}

/** completed-Termin ohne LN: dokumentieren, aber NICHT in einen LN aufnehmen. */
async function billableWithOneUncoveredAppt(customerId: number): Promise<string> {
  const a1 = await createApptInMonth(customerId, "cov");
  await documentAppointment(a1.id, a1.time);
  const sr = await createServiceRecord(customerId); // deckt a1
  await signServiceRecord(sr, "employee");
  await signServiceRecord(sr, "customer"); // ⇒ completed LN (a1 abrechenbar)
  const a2 = await createApptInMonth(customerId, "uncov");
  await documentAppointment(a2.id, a2.time); // a2 dokumentiert, KEIN LN
  return a2.date;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("hauswirtschaft fehlt in Test-DB");
  hwServiceId = hw.id;
  const emp = await createTestEmployee({ nachnamePrefix: "TestGUARD" });
  testEmployeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ } }
  for (const id of cleanupCustomerIds) { try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ } }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Task #1883 — Unterabrechnungs-Guard beim Rechnung-Erstellen", () => {
  it("teil-dokumentiert (completed ohne LN) → 409, nennt den Termin, ohne Bestätigung wird nicht abgerechnet", async () => {
    const id = await createSelbstzahler();
    const uncoveredDate = await billableWithOneUncoveredAppt(id);

    const blocked = await generateSingle(id);
    expect(blocked.status).toBe(409);
    expect(blocked.data.code).toBe("PARTIAL_BILLING_CONFIRMATION_REQUIRED");
    const dates = (blocked.data.excludedAppointments ?? []).map((e: any) => e.date);
    expect(dates).toContain(uncoveredDate);
  });

  it("Mischkunde Pflegekasse (completed + employee_signed) → 409 nennt die employee_signed-Termine", async () => {
    const id = await createPflegekasse();
    const a1 = await createApptInMonth(id, "pk-billable");
    await documentAppointment(a1.id, a1.time);
    const srSigned = await createServiceRecord(id);
    await signServiceRecord(srSigned, "employee");
    await signServiceRecord(srSigned, "customer"); // completed LN, a1 abrechenbar
    const emp1 = await createApptInMonth(id, "pk-emp1");
    await documentAppointment(emp1.id, emp1.time);
    const emp2 = await createApptInMonth(id, "pk-emp2");
    await documentAppointment(emp2.id, emp2.time);
    const srEmp = await createServiceRecord(id);
    await signServiceRecord(srEmp, "employee"); // nur employee_signed

    const blocked = await generateSingle(id);
    expect(blocked.status).toBe(409);
    const dates = (blocked.data.excludedAppointments ?? []).map((e: any) => e.date).sort();
    expect(dates).toContain(emp1.date);
    expect(dates).toContain(emp2.date);
    // Reason = fehlende Kundenunterschrift (Pflegekasse).
    const reasons = new Set((blocked.data.excludedAppointments ?? []).map((e: any) => e.reason));
    expect(reasons.has("customer_signature_required")).toBe(true);
  });

  it("Opt-in (confirmPartial) rechnet den signierten Teil ab", async () => {
    const id = await createSelbstzahler();
    await billableWithOneUncoveredAppt(id);
    const ok = await generateSingle(id, { confirmPartial: true, partialReason: "Teil-Abrechnung Test" });
    expect(ok.status).toBe(200);
  });

  it("KRITISCH — voll abrechenbarer Kunde läuft ohne Fehl-Block durch (kein Guard)", async () => {
    const id = await createSelbstzahler();
    const a1 = await createApptInMonth(id, "full");
    await documentAppointment(a1.id, a1.time);
    const sr = await createServiceRecord(id);
    await signServiceRecord(sr, "employee");
    await signServiceRecord(sr, "customer");
    const ok = await generateSingle(id); // OHNE confirmPartial
    expect(ok.status).toBe(200);
  });

  it("Erstberatung löst den Guard NICHT aus (#1886)", async () => {
    const id = await createSelbstzahler();
    const a1 = await createApptInMonth(id, "eb-full");
    await documentAppointment(a1.id, a1.time);
    const sr = await createServiceRecord(id);
    await signServiceRecord(sr, "employee");
    await signServiceRecord(sr, "customer");
    // Direkt-Insert eines completed Erstberatungstermins MIT customer_id (bypass des
    // regulären kundenlosen Flows) — der #1886-Typ-Filter muss ihn vom Guard ausnehmen.
    await db.execute(sql`
      INSERT INTO appointments (customer_id, appointment_type, date, scheduled_start, duration_promised, status, performed_by_employee_id, assigned_employee_id)
      VALUES (${id}, 'Erstberatung', ${`${BILLING_YEAR}-${String(BILLING_MONTH).padStart(2, "0")}-15`}::date, '08:00', 45, 'completed', ${auth.user.id}, ${auth.user.id})
    `);
    const ok = await generateSingle(id); // OHNE confirmPartial → muss trotzdem durchlaufen
    expect(ok.status).toBe(200);
  });

  it("Sammel-Erstellung meldet Mischkunden als übersprungen MIT Ausweis (nie still)", async () => {
    const id = await createPflegekasse();
    const a1 = await createApptInMonth(id, "bulk-billable");
    await documentAppointment(a1.id, a1.time);
    const srSigned = await createServiceRecord(id);
    await signServiceRecord(srSigned, "employee");
    await signServiceRecord(srSigned, "customer");
    const emp1 = await createApptInMonth(id, "bulk-emp1");
    await documentAppointment(emp1.id, emp1.time);
    const srEmp = await createServiceRecord(id);
    await signServiceRecord(srEmp, "employee"); // employee_signed

    const res = await apiPost<any>("/api/billing/generate-all", { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR });
    expect(res.status).toBe(200);
    const mine = (res.data.results ?? []).find((r: any) => r.customerId === id);
    expect(mine).toBeDefined();
    expect(mine.status).toBe("skipped");
    expect((mine.excludedAppointments ?? []).length).toBeGreaterThan(0);
  });
});
