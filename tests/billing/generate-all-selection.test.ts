import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1888 — Multi-Select „Erstellen (N)": Auswahl-Allowlist für generate-all.
 *
 * `POST /billing/generate-all` nimmt optional `customerIds` (die Multi-Select-Auswahl
 * der Erstellungs-Liste). Der Server VERENGT die aus signierten LNs abgeleitete Menge
 * auf diese Auswahl — reine Schnittmenge, NIE Erweiterung. Der #1883-Unterabrechnungs-
 * Guard und die Skip-/Fehler-/Idempotenz-Logik laufen unverändert.
 *
 * Kritischer Guard (Sichtbarkeit ≠ Abrechenbarkeit, #1885/#1883):
 *   • nur erstellbare (LN-signierte) Kunden werden angefasst — ein nicht-abrechenbarer
 *     (LN-loser) Kunde in der Auswahl wird nie berührt;
 *   • ein NICHT ausgewählter erstellbarer Kunde wird nicht angefasst (Allowlist wirkt);
 *   • Mischkunde in der Auswahl (ohne confirmPartial) → skip-MIT-Ausweis (#1883), nie
 *     stilles Teil-Abrechnen.
 *
 * ISOLATION: `customerIds` scopet den Lauf auf die eigenen Test-Kunden (kein globaler
 * Effekt). Vergangener Vormonat (3-Monats-Grenze).
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
const MONTH_START_ISO = `${BILLING_YEAR}-${String(BILLING_MONTH).padStart(2, "0")}-01`;

async function createApptInMonth(customerId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let day = 1; day <= LAST_DAY; day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    if (cand.getDay() === 0 || cand.getDay() === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId, date: dateStr, scheduledStart: time, notes: `SEL-${tag}-${uniqueId()}`,
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

async function createSignedRecord(customerId: number, signers: Array<"employee" | "customer">): Promise<number> {
  const res = await apiPost<any>("/api/service-records", { customerId, employeeId: auth.user.id, year: BILLING_YEAR, month: BILLING_MONTH });
  if (res.status !== 201) throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  const srId = res.data.id as number;
  cleanupServiceRecordIds.push(srId);
  for (const signerType of signers) {
    const s = await apiPost<any>(`/api/service-records/${srId}/sign`, { signerType, signatureData: validSignatureDataUrl() });
    if (s.status !== 200) throw new Error(`sign(${srId},${signerType}) failed: ${s.status} ${JSON.stringify(s.data)}`);
  }
  return srId;
}

async function createSelbstzahler(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "SEL", nachname: `Privat-${tag}-${uniqueId()}`, geburtsdatum: "1942-03-10",
    email: `sel-${tag}-${uniqueId()}@test.local`, strasse: "Teststraße", nr: "1", plz: "10115", stadt: "Berlin",
    pflegegrad: 2, pflegegradSeit: "2024-01-01", billingType: "selbstzahler", acceptsPrivatePayment: true,
    contacts: [{ contactType: "familie", isPrimary: true, vorname: "K", nachname: "S", mobilnummer: "+4917600000010" }],
  });
  if (res.status !== 201) throw new Error(`createSelbstzahler failed: ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, { primaryEmployeeId: auth.user.id, backupEmployeeId: testEmployeeId, backupEmployeeId2: null });
  return id;
}

async function createPflegekasse(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "SEL", nachname: `Kasse-${tag}-${uniqueId()}`, geburtsdatum: "1941-03-22",
    email: `sel-kasse-${tag}-${uniqueId()}@test.local`, strasse: "Musterweg", nr: "7", plz: "01067", stadt: "Dresden",
    telefon: "+4917600000099", pflegegrad: 3, pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false,
  });
  if (res.status !== 201) throw new Error(`createPflegekasse failed: ${res.status} ${JSON.stringify(res.data)}`);
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, { primaryEmployeeId: auth.user.id, backupEmployeeId: testEmployeeId, backupEmployeeId2: null });
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

async function generateAll(body: Record<string, unknown>): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate-all", { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR, ...body });
  if (res.status !== 200) throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}
function resultFor(data: any, customerId: number): any {
  return (data.results ?? []).find((r: any) => r.customerId === customerId);
}

let readySelectedId: number;   // ready + IN Auswahl → created
let readyNotSelectedId: number; // ready, NICHT in Auswahl → nie angefasst
let lnMissingId: number;        // dokumentiert ohne LN → nicht abrechenbar
let mischkundeId: number;       // Pflegekasse: 1 completed-LN + weitere employee_signed

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  const hw = services.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("hauswirtschaft fehlt");
  hwServiceId = hw.id;
  const emp = await createTestEmployee({ nachnamePrefix: "TestSEL" });
  testEmployeeId = emp.id;

  readySelectedId = await createSelbstzahler("ready-sel");
  const rA = await createApptInMonth(readySelectedId, "ready-sel");
  await documentAppointment(rA.id, rA.time);
  await createSignedRecord(readySelectedId, ["employee", "customer"]);

  readyNotSelectedId = await createSelbstzahler("ready-nosel");
  const rB = await createApptInMonth(readyNotSelectedId, "ready-nosel");
  await documentAppointment(rB.id, rB.time);
  await createSignedRecord(readyNotSelectedId, ["employee", "customer"]);

  lnMissingId = await createSelbstzahler("lnmiss");
  const lA = await createApptInMonth(lnMissingId, "lnmiss");
  await documentAppointment(lA.id, lA.time); // dokumentiert, KEIN LN

  // Mischkunde: 1 kundensignierter (completed) Termin + 2 nur employee_signed.
  mischkundeId = await createPflegekasse("misch");
  const mA = await createApptInMonth(mischkundeId, "misch-billable");
  await documentAppointment(mA.id, mA.time);
  await createSignedRecord(mischkundeId, ["employee", "customer"]);
  const mB = await createApptInMonth(mischkundeId, "misch-emp1");
  await documentAppointment(mB.id, mB.time);
  const mC = await createApptInMonth(mischkundeId, "misch-emp2");
  await documentAppointment(mC.id, mC.time);
  await createSignedRecord(mischkundeId, ["employee"]); // nur employee_signed
});

afterAll(async () => {
  for (const id of cleanupServiceRecordIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best effort */ } }
  for (const id of cleanupCustomerIds) { try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* best effort */ } }
  await deactivateTestEmployee(testEmployeeId);
});

describe("Task #1888 — generate-all Auswahl-Allowlist (Multi-Select)", () => {
  it("KRITISCH — Allowlist fasst nur erstellbare, ausgewählte Kunden an; LN-loser + nicht-ausgewählter bleiben unberührt", async () => {
    const data = await generateAll({ customerIds: [readySelectedId, lnMissingId] });
    // Ausgewählter erstellbarer Kunde → erstellt.
    expect(resultFor(data, readySelectedId)?.status).toBe("created");
    // LN-loser Kunde ist gar nicht in der signierten Menge → nie angefasst.
    expect(resultFor(data, lnMissingId)).toBeUndefined();
    // NICHT ausgewählter erstellbarer Kunde → durch die Allowlist ausgeschlossen.
    expect(resultFor(data, readyNotSelectedId)).toBeUndefined();
  });

  it("Mischkunde in der Auswahl ohne confirmPartial → skip MIT Ausweis (#1883), nie still", async () => {
    const data = await generateAll({ customerIds: [mischkundeId] });
    const r = resultFor(data, mischkundeId);
    expect(r).toBeDefined();
    expect(r.status).toBe("skipped");
    expect((r.excludedAppointments ?? []).length).toBeGreaterThan(0);
  });

  it("leere Auswahl fasst niemanden an", async () => {
    const data = await generateAll({ customerIds: [] });
    expect(data.summary.created).toBe(0);
    expect(data.results.length).toBe(0);
  });
});
