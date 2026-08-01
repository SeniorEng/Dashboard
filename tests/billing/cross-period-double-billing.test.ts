/**
 * Task #1892 (PR-2) — Die Idempotenz-Sperre der Abrechnungs-Engine ist
 * ZEITRAUM-BLIND.
 *
 * Vorher filterte `getAlreadyInvoicedAppointmentIds` zusätzlich auf
 * `invoices.billing_year`/`billing_month`. Ein Termin, der auf einer AKTIVEN
 * Rechnung eines ANDEREN Abrechnungszeitraums lag, las sich damit als „noch
 * nicht abgerechnet" — und wurde ein zweites Mal berechnet. Dass das in Prod
 * nicht auftrat, hing an einer Invarianten-Kette (LN-Periode == Termin-Monat,
 * ein Termin in höchstens einem aktiven LN, Storno-Pflicht vor Freigabe), die
 * an KEINER Stelle hart erzwungen wird — insbesondere validiert
 * `addAppointmentsToServiceRecord` den Monat nicht.
 *
 * Dieser Test stellt genau diesen Zustand her: eine aktive Rechnung im Monat M
 * trägt Termin A, und A hängt zusätzlich an einem signierten
 * Leistungsnachweis des Monats M−1. Da die API-Pfade das (per Invariante)
 * nicht erzeugen können, wird die Junction-Zeile bewusst direkt in der DB
 * gesetzt — der Test prüft das VERHALTEN der Sperre, nicht den Weg dorthin.
 *
 * Festgenagelt wird:
 *   1. `POST /api/billing/generate` für M−1 rechnet A NICHT erneut ab
 *      (`already_billed`), und A bleibt auf GENAU EINER aktiven Rechnung.
 *   2. Der Spiegel `/api/billing/eligible-customers` für M−1 führt den Kunden
 *      nicht als abrechenbar — Liste und Engine bleiben deckungsgleich
 *      (die #1790-Invariante; ein zeitraum-gescopter Spiegel würde hier
 *      auseinanderlaufen).
 *
 * ISOLATION: Selbstzahler-Kunde (kein Budget-Split, genau eine Rechnung pro
 * Lauf), Prüfung immer nur gegen die eigene `customerId` — nie globale Summen.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  invoiceLineItems,
  invoices as invoicesTable,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import { BILLING_BLOCK_MESSAGES } from "@shared/domain/billing-eligibility";
import { getUnbilledSignedAppointmentFactsByCustomer } from "../../server/services/invoice-data";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import {
  apiGet,
  apiPost,
  apiPatch,
  cleanupCustomer,
  getAuthCookie,
  uniqueId,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];

const SEED_TIMES = [
  "00:00", "00:30", "01:00", "01:30", "02:00", "02:30", "03:00", "03:30",
  "04:00", "04:30", "05:00", "05:30", "21:00", "21:30", "22:00", "22:30",
];

const NOW = new Date();
const FIRST_OF_THIS_MONTH = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
const LAST_OF_PREV_MONTH = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
/** Der Monat, in dem der Termin liegt und tatsächlich abgerechnet wird. */
const BILLING_YEAR = LAST_OF_PREV_MONTH.getFullYear();
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1;
/** Der FREMDE Zeitraum, unter dem der Termin ein zweites Mal auftauchen soll. */
const OTHER_MONTH = BILLING_MONTH === 1 ? 12 : BILLING_MONTH - 1;
const OTHER_YEAR = BILLING_MONTH === 1 ? BILLING_YEAR - 1 : BILLING_YEAR;
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Legt einen Kundentermin auf einem freien Werktag des Abrechnungsmonats an. */
async function createAppt(customerId: number): Promise<{ id: number; time: string }> {
  for (let day = 2; day <= LAST_DAY; day++) {
    const cand = new Date(BILLING_YEAR, BILLING_MONTH - 1, day);
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: ymdLocal(cand),
        scheduledStart: time,
        notes: `XPD-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      });
      if (res.status === 201) return { id: res.data.id, time };
    }
  }
  throw new Error("createAppt: kein freier Werktags-Slot im Abrechnungsmonat");
}

async function createSelbstzahlerCustomer(): Promise<number> {
  const tag = uniqueId();
  const res = await apiPost<any>("/api/admin/customers", {
    vorname: "XPD",
    nachname: `Privat-${tag}`,
    geburtsdatum: "1941-06-02",
    email: `xpd-${tag}@test.local`,
    strasse: "Teststraße",
    nr: "7",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [{
      contactType: "familie",
      isPrimary: true,
      vorname: "Kontakt",
      nachname: "XPD",
      mobilnummer: "+4917600000042",
    }],
  });
  if (res.status !== 201) {
    throw new Error(`createSelbstzahlerCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch<any>(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  return id;
}

/** Aktive (nicht-stornierte, nicht-Storno-) Rechnungen, die diesen Termin tragen. */
async function activeInvoicesFor(appointmentId: number): Promise<number[]> {
  const rows = await db
    .select({ invoiceId: invoicesTable.id })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(and(
      eq(invoiceLineItems.appointmentId, appointmentId),
      // Bewusst literal statt über die SSoT: der Test darf nicht dieselbe
      // Funktion verwenden, deren Wirkung er beweisen soll.
      ne(invoicesTable.status, "storniert"),
      ne(invoicesTable.invoiceType, "stornorechnung"),
    ));
  return Array.from(new Set(rows.map(r => r.invoiceId)));
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;
});

afterAll(async () => {
  if (cleanupServiceRecordIds.length > 0) {
    await db.delete(serviceRecordAppointments)
      .where(inArray(serviceRecordAppointments.serviceRecordId, cleanupServiceRecordIds));
    await db.delete(monthlyServiceRecords)
      .where(inArray(monthlyServiceRecords.id, cleanupServiceRecordIds));
  }
  for (const id of cleanupCustomerIds) await cleanupCustomer(id);
});

describe("Task #1892 PR-2 — Idempotenz-Sperre ist zeitraum-blind", () => {
  it("ein Termin auf einer aktiven Rechnung anderen Zeitraums wird NICHT erneut abgerechnet", async () => {
    const customerId = await createSelbstzahlerCustomer();

    // (1) Termin im Abrechnungsmonat anlegen + dokumentieren.
    const appt = await createAppt(customerId);
    const docRes = await apiPost<any>(`/api/appointments/${appt.id}/document`, {
      actualStart: appt.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "XPD-Doku" }],
    });
    expect(docRes.status, JSON.stringify(docRes.data)).toBe(200);

    // (2) Leistungsnachweis des RICHTIGEN Monats erstellen + beidseitig signieren.
    const srRes = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year: BILLING_YEAR,
      month: BILLING_MONTH,
    });
    expect(srRes.status, JSON.stringify(srRes.data)).toBe(201);
    const srId = srRes.data.id as number;
    cleanupServiceRecordIds.push(srId);
    for (const signerType of ["employee", "customer"] as const) {
      const signRes = await apiPost<any>(`/api/service-records/${srId}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(signRes.status, JSON.stringify(signRes.data)).toBe(200);
    }

    // (3) Regulär abrechnen — der Termin liegt jetzt auf einer aktiven Rechnung.
    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: BILLING_MONTH,
      billingYear: BILLING_YEAR,
    });
    expect(genRes.status, JSON.stringify(genRes.data)).toBe(200);
    const invoicesAfterFirst = await activeInvoicesFor(appt.id);
    expect(invoicesAfterFirst).toHaveLength(1);

    // (4) Den Zustand herstellen, den die Invarianten-Kette verhindern SOLL:
    //     derselbe Termin hängt zusätzlich an einem signierten LN eines
    //     ANDEREN Abrechnungszeitraums. Bewusst direkt in der DB — kein
    //     API-Pfad erzeugt das, und genau deshalb ist es ungeschützt.
    const now = new Date();
    const [foreignSr] = await db.insert(monthlyServiceRecords).values({
      customerId,
      employeeId: auth.user.id,
      year: OTHER_YEAR,
      month: OTHER_MONTH,
      recordType: "monthly",
      status: "completed",
      employeeSignedAt: now,
      customerSignedAt: now,
    }).returning({ id: monthlyServiceRecords.id });
    cleanupServiceRecordIds.push(foreignSr.id);
    await db.insert(serviceRecordAppointments).values({
      serviceRecordId: foreignSr.id,
      appointmentId: appt.id,
    });

    // (5) DIE Invariante: die Abrechnung des fremden Zeitraums rechnet den
    //     Termin nicht erneut ab. Vor PR-2 entstand hier eine zweite aktive
    //     Rechnung über denselben Termin.
    const secondRes = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: OTHER_MONTH,
      billingYear: OTHER_YEAR,
    });
    expect(secondRes.status, JSON.stringify(secondRes.data)).toBe(400);
    expect(JSON.stringify(secondRes.data)).toContain(BILLING_BLOCK_MESSAGES.already_billed);

    const invoicesAfterSecond = await activeInvoicesFor(appt.id);
    expect(invoicesAfterSecond).toEqual(invoicesAfterFirst);

    // (6) Der Spiegel muss dieselbe Antwort geben. `/billing/eligible-customers`
    //     und `generate-all` lesen ihre „noch offen"-Fakten aus
    //     `getUnbilledSignedAppointmentFactsByCustomer` (#1790). Für den fremden
    //     Zeitraum sieht der Spiegel EINEN strikt signierten Termin — und der
    //     ist bereits abgerechnet. Wäre er weiter zeitraum-gescopt, meldete er
    //     ihn als offen und die Liste liefe gegen (5) auseinander.
    const facts = await getUnbilledSignedAppointmentFactsByCustomer(
      [customerId],
      OTHER_YEAR,
      OTHER_MONTH,
    );
    expect(facts.get(customerId)).toEqual({
      signedAppointmentCount: 1,
      unbilledAppointmentCount: 0,
    });
  });
});
