import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1868 — Soft-gelöschte Termine dürfen die Abrechnungs-Reife nicht
 * aufblähen.
 *
 * Bug: Die Readiness-/Eligibility-Faktenleser
 * (`getUnbilledSignedAppointmentFactsByCustomer`) zählten Termine unter einem
 * signierten Leistungsnachweis, OHNE soft-gelöschte Termine auszuschließen — im
 * Gegensatz zum echten Generate-Pfad (`buildInvoiceDraft`), der gelöschte
 * Termine gar nicht abrechnet. Ergebnis: Ein Kunde, dessen einziger noch offener
 * signierter Termin gelöscht ist, erschien als „Bereit zum Abrechnen", während
 * die Erstellung 0,00 € erzeugte (Review↔Generate-Drift).
 *
 * Regressions-Sicherung: Ein Kunde mit EINEM bereits abgerechneten und EINEM
 * soft-gelöschten (nie abgerechneten) signierten Termin
 *   1. meldet in `getUnbilledSignedAppointmentFactsByCustomer` 0 offene Termine
 *      (= Generate würde 0,00 € erzeugen), und
 *   2. taucht NICHT mehr in `GET /api/billing/eligible-customers` auf.
 *
 * ISOLATION: Selbstzahler-Kunde (kein Budget-Split, genau eine Rechnung pro
 * Lauf); es wird IMMER nur der eigene Kunde per `customerId` geprüft. Der Termin
 * wird direkt in der DB soft-gelöscht (deletedAt), weil der HTTP-Delete einen auf
 * einem versiegelten LN liegenden Termin sperrt — die Junction-Zeile bleibt
 * (Soft-Delete löst KEINE FK-Cascade aus), exakt wie im Produktionsfall.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import { getUnbilledSignedAppointmentFactsByCustomer } from "../../server/services/invoice-data";
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
        notes: `SDA-${tag}-${uniqueId()}`,
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

/** Erstellt + signiert (Mitarbeiter + Kunde) einen Sammel-LN. Auto-Auswahl der noch nicht abgedeckten dokumentierten Termine. */
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
    vorname: "SDA",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `sda-${tag}-${uniqueId()}@test.local`,
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
        nachname: "SDA",
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

async function eligibleContains(customerId: number): Promise<boolean> {
  const res = await apiGet<any[]>(`/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`);
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.some((c: any) => c.id === customerId);
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

  const emp = await createTestEmployee({ nachnamePrefix: "TestSDA" });
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

describe("SDA: Soft-gelöschte signierte Termine blähen die Abrechnungs-Reife nicht auf", () => {
  let customerId: number;
  let billedApptId: number;
  let deletedApptId: number;

  beforeAll(async () => {
    customerId = await createSelbstzahlerCustomer("softdel");

    // Termin 1: dokumentieren, LN #1 signieren, abrechnen → bereits abgerechnet.
    const billed = await createAppt(customerId, 30, 1, 10, "billed");
    billedApptId = billed.id;
    await documentAppointment(billed.id, billed.time, 30, "sda-billed");
    await createAndSignServiceRecord(customerId);
    const ga = await generateAll();
    expect(resultFor(ga, customerId)?.status).toBe("created");

    // Termin 2: dokumentieren, LN #2 signieren (deckt genau Termin 2), NICHT abrechnen.
    const later = await createAppt(customerId, 30, 11, LAST_DAY, "deleted");
    deletedApptId = later.id;
    await documentAppointment(later.id, later.time, 30, "sda-deleted");
    await createAndSignServiceRecord(customerId);

    // Termin 2 direkt in der DB soft-löschen. Der HTTP-Delete würde einen auf
    // einem versiegelten LN liegenden Termin sperren; im Produktionsfall wurde
    // der Termin vor dem Versiegeln gelöscht, die Junction-Zeile blieb (Soft-
    // Delete löst keine FK-Cascade aus). Genau diesen Endzustand stellen wir her.
    await db.update(appointments)
      .set({ deletedAt: new Date() })
      .where(eq(appointments.id, deletedApptId));
  });

  it("SDA-1 — Readiness-Fakten melden 0 offene Termine (= Generate erzeugt 0,00 €)", async () => {
    const facts = await getUnbilledSignedAppointmentFactsByCustomer([customerId], BILLING_YEAR, BILLING_MONTH);
    const f = facts.get(customerId);
    // Der soft-gelöschte Termin darf weder als signiert noch als offen zählen.
    expect(f?.signedAppointmentCount).toBe(1);
    expect(f?.unbilledAppointmentCount).toBe(0);
  });

  it("SDA-2 — der Kunde erscheint NICHT als abrechenbar (kein Review↔Generate-Drift)", async () => {
    expect(await eligibleContains(customerId)).toBe(false);
  });
});
