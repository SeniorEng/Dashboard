import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1873 — Teil-signierte Kunden bleiben in „Noch zu erstellen" sichtbar.
 *
 * Fall „Bernd Funke": Ein Kunde hat im Monat
 *   • einen dokumentierten Termin unter einem (kunden-)signierten LN, der bereits
 *     abgerechnet ist, UND
 *   • einen weiteren dokumentierten (`completed`) Termin, der noch NICHT durch
 *     einen signierten Leistungsnachweis abgedeckt ist.
 *
 * Der frühere Ausschluss `signedAppointmentCount > 0 && unbilledAppointmentCount === 0`
 * betrachtete nur Termine unter strikt signierten LNs und warf den Kunden still
 * aus `GET /api/billing/eligible-customers`, obwohl er noch offene, zu
 * unterschreibende/abzurechnende dokumentierte Arbeit hatte.
 *
 * Erwartung:
 *   1. Der Funke-Kunde bleibt in der Liste (in einer Aufmerksamkeits-Gruppe,
 *      nicht „Bereit"), weil er unabgedeckte dokumentierte Termine hat.
 *   2. Ein wirklich vollständig abgerechneter Kunde (alles dokumentierte durch
 *      einen signierten LN abgedeckt und abgerechnet) fällt weiterhin heraus.
 *
 * ISOLATION: Selbstzahler-Kunden (kein Budget-Split), immer nur per `customerId`
 * geprüft — nie globale Summen. Vollständig vergangener Vormonat.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { classifyBillingMaturity } from "@shared/domain/billing-eligibility";
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

async function createAppt(
  customerId: number,
  durationMinutes: number,
  dayMin: number,
  dayMax: number,
  tag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let day = dayMin; day <= Math.min(dayMax, LAST_DAY); day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `PSV-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
    }
  }
  throw new Error(`createAppt(${tag}): kein freier Werktag-Slot in Tagen ${dayMin}-${dayMax}`);
}

async function documentAppointment(appointmentId: number, startTime: string, actualMinutes: number, details: string): Promise<void> {
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

/** Erstellt + signiert (Mitarbeiter + Kunde) einen Sammel-LN — deckt automatisch die noch nicht abgedeckten dokumentierten Termine ab. */
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

async function createSelbstzahlerCustomer(tag: string): Promise<number> {
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "PSV",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `psv-${tag}-${uniqueId()}@test.local`,
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
        nachname: "PSV",
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

async function fetchEligible(customerId: number): Promise<any | undefined> {
  const res = await apiGet<any[]>(`/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`);
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.find((c: any) => c.id === customerId);
}

async function generateAll(): Promise<any> {
  const res = await apiPost<any>("/api/billing/generate-all", { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR });
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function resultFor(gaData: any, customerId: number): any {
  return (gaData.results ?? []).find((r: any) => r.customerId === customerId);
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestPSV" });
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

describe("PSV: Teil-signierte Kunden bleiben in der Abrechnungsliste sichtbar (Task #1873)", () => {
  it("PSV-1 — Funke-Fall: signierter+abgerechneter Termin PLUS dokumentierter-aber-unsignierter Termin ⇒ bleibt sichtbar in einer Aufmerksamkeits-Gruppe", async () => {
    const customerId = await createSelbstzahlerCustomer("funke");

    // Termin 1: dokumentieren, LN erstellen+signieren, abrechnen.
    const first = await createAppt(customerId, 30, 1, 10, "funke-first");
    await documentAppointment(first.id, first.time, 30, "funke-first");
    await createAndSignServiceRecord(customerId);
    const ga1 = await generateAll();
    expect(resultFor(ga1, customerId)?.status).toBe("created");

    // Termin 2: NUR dokumentieren, KEINEN LN erstellen ⇒ dokumentiert-aber-unsigniert.
    const second = await createAppt(customerId, 30, 11, LAST_DAY, "funke-second");
    await documentAppointment(second.id, second.time, 30, "funke-second");

    // Der Kunde muss trotz „alle signierten Termine abgerechnet" sichtbar bleiben.
    const item = await fetchEligible(customerId);
    expect(item).toBeDefined();

    // Er hat unabgedeckte dokumentierte Termine (2 dokumentiert, 1 abgedeckt).
    expect(item.completedAppointments).toBeGreaterThan(item.coveredAppointments);

    // ... und landet NICHT unter „Bereit zum Abrechnen".
    const group = classifyBillingMaturity(item);
    expect(group).not.toBe("ready");
    expect(["partially_documented", "signature_blocked"]).toContain(group);
  });

  it("PSV-2 — vollständig abgerechneter Kunde (alles dokumentierte abgedeckt + abgerechnet) fällt weiterhin heraus", async () => {
    const customerId = await createSelbstzahlerCustomer("done");

    const only = await createAppt(customerId, 30, 1, 10, "done-only");
    await documentAppointment(only.id, only.time, 30, "done-only");
    await createAndSignServiceRecord(customerId);
    const ga = await generateAll();
    expect(resultFor(ga, customerId)?.status).toBe("created");

    // Kein unabgedeckter dokumentierter Termin ⇒ nicht mehr in der Liste.
    const item = await fetchEligible(customerId);
    expect(item).toBeUndefined();
  });
});
