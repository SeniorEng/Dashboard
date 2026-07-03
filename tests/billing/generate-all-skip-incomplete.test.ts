import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Massenerstellung — „unvollständig dokumentierte Kunden überspringen"
 * (Task #1627, sichert Task #1625 ab)
 *
 * Task #1625 hat der Massenerstellung (`POST /api/billing/generate-all`) die
 * optionale Server-Option `skipIncomplete` gegeben: Kunden, deren im Zeitraum
 * dokumentierte (`completed`) Termine nicht vollständig durch aktive
 * Leistungsnachweise abgedeckt sind, werden NICHT abgerechnet, sondern als
 * „übersprungen" mit der Meldung „Nicht vollständig dokumentiert" gemeldet.
 *
 * Bisher gab es KEINEN automatischen Test, der garantiert, dass
 *   (a) vollständig dokumentierte Kunden trotzdem abgerechnet werden,
 *   (b) NUR die partiell dokumentierten (dokumentiert > abgedeckt) übersprungen
 *       werden — und zwar mit exakt dieser Meldung,
 *   (c) Kunden ohne dokumentierte Termine im Zeitraum davon unberührt bleiben,
 * und dass die Skip-Menge aus DERSELBEN Abdeckungs-Berechnung stammt wie der
 * „Nur X/Y dokumentierte Termine"-Hinweis in `/billing/eligible-customers`
 * (`getDocumentationCoverageByCustomer` + `isPartiallyDocumented`). Eine
 * Regression hier würde entweder legitime Rechnungen still fallenlassen oder
 * gültige Kunden fälschlich überspringen.
 *
 * ISOLATION: `generate-all` läuft global über alle Kunden mit signiertem LN im
 * Monat (nur optional nach Pflegekasse gefiltert). Wir verwenden daher
 * Selbstzahler-Kunden (kein Budget-Split, genau eine Rechnung pro Lauf) und
 * prüfen IMMER nur die Ergebnis-Einträge der EIGENEN Kunden (Filter per
 * `customerId`) — nie globale Summen, robust gegen parallele/leftover Kunden im
 * selben Worker.
 *
 * DATUM: Vollständig vergangener Vormonat (innerhalb der 3-Monats-Grenze für die
 * Termin-Anlage), in eine frühe (Tag 1–14) und späte (Tag 15–Monatsende) Hälfte
 * geteilt, damit zwei Termine pro Kunde garantiert auf verschiedenen Werktagen
 * liegen (keine Slot-Kollision).
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

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

const NOW = new Date();
const FIRST_OF_THIS_MONTH = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
const LAST_OF_PREV_MONTH = new Date(FIRST_OF_THIS_MONTH.getTime() - 24 * 60 * 60 * 1000);
const BILLING_YEAR = LAST_OF_PREV_MONTH.getFullYear();
const BILLING_MONTH = LAST_OF_PREV_MONTH.getMonth() + 1; // 1-12
const LAST_DAY = new Date(BILLING_YEAR, BILLING_MONTH, 0).getDate();

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
        notes: `SKI-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(
    `createApptInDayRange(${tag}): kein freier Werktag-Slot in Tagen ${dayMin}-${dayMax} von ${BILLING_YEAR}-${BILLING_MONTH}`,
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

/**
 * Erstellt einen Sammel-Leistungsnachweis und unterschreibt ihn (Mitarbeiter +
 * Kunde). Ohne `appointmentIds` deckt er ALLE offenen dokumentierten Termine des
 * Monats ab; mit expliziter Auswahl nur die gewählten (→ partielle Abdeckung).
 */
async function createAndSignServiceRecord(
  customerId: number,
  appointmentIds?: number[],
): Promise<number> {
  const body: Record<string, any> = {
    customerId,
    employeeId: auth.user.id,
    year: BILLING_YEAR,
    month: BILLING_MONTH,
  };
  if (appointmentIds && appointmentIds.length > 0) body.appointmentIds = appointmentIds;
  const res = await apiPost<any>("/api/service-records", body);
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
    vorname: "SKI",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    email: `ski-${tag}-${uniqueId()}@test.local`,
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
        nachname: "SKI",
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

// ---------- Abfragen ----------

type EligibleRow = {
  id: number;
  completedAppointments: number;
  coveredAppointments: number;
};

async function eligibleRowFor(customerId: number): Promise<EligibleRow | undefined> {
  const res = await apiGet<EligibleRow[]>(
    `/api/billing/eligible-customers?month=${BILLING_MONTH}&year=${BILLING_YEAR}`,
  );
  if (res.status !== 200) {
    throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.find((c) => c.id === customerId);
}

type GenResult = { customerId: number; status: string; message?: string; invoiceCount?: number };

async function generateAll(skipIncomplete?: boolean): Promise<GenResult[]> {
  const body: Record<string, any> = { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR };
  if (skipIncomplete !== undefined) body.skipIncomplete = skipIncomplete;
  const res = await apiPost<any>("/api/billing/generate-all", body);
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return (res.data.results ?? []) as GenResult[];
}

function resultFor(results: GenResult[], customerId: number): GenResult | undefined {
  return results.find((r) => r.customerId === customerId);
}

const INCOMPLETE_MSG = "Nicht vollständig dokumentiert";

// ---------- Lifecycle ----------

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestSKI" });
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

describe("SKI: generate-all skipIncomplete überspringt nur partiell dokumentierte Kunden", () => {
  let fullCustomerId: number;    // (a) vollständig dokumentiert (LN deckt alle Termine)
  let partialCustomerId: number; // (b) partiell dokumentiert (LN deckt nur 1 von 2)
  let noneCustomerId: number;    // (c) kein dokumentierter Termin im Zeitraum

  beforeAll(async () => {
    // (a) Vollständig dokumentiert: zwei dokumentierte Termine, ein LN deckt BEIDE.
    fullCustomerId = await createSelbstzahlerCustomer("full");
    const fullEarly = await createApptInDayRange(fullCustomerId, 30, 1, 14, "full-early");
    const fullLate = await createApptInDayRange(fullCustomerId, 30, 15, LAST_DAY, "full-late");
    await documentAppointment(fullEarly.id, fullEarly.time, 30, "full-early");
    await documentAppointment(fullLate.id, fullLate.time, 30, "full-late");
    await createAndSignServiceRecord(fullCustomerId); // ohne Auswahl → deckt beide

    // (b) Partiell dokumentiert: zwei dokumentierte Termine, LN deckt NUR den frühen.
    partialCustomerId = await createSelbstzahlerCustomer("partial");
    const partEarly = await createApptInDayRange(partialCustomerId, 30, 1, 14, "part-early");
    const partLate = await createApptInDayRange(partialCustomerId, 30, 15, LAST_DAY, "part-late");
    await documentAppointment(partEarly.id, partEarly.time, 30, "part-early");
    await documentAppointment(partLate.id, partLate.time, 30, "part-late");
    await createAndSignServiceRecord(partialCustomerId, [partEarly.id]); // nur 1 von 2

    // (c) Kein dokumentierter Termin: nur ein geplanter (undokumentierter)
    // Termin, kein Leistungsnachweis → kein Abrechnungs-Kandidat.
    noneCustomerId = await createSelbstzahlerCustomer("none");
    await createApptInDayRange(noneCustomerId, 30, 1, 14, "none-scheduled");
  });

  it("SKI-1 — /eligible-customers spiegelt die Abdeckung: (a) vollständig, (b) partiell, (c) kein Kandidat", async () => {
    const full = await eligibleRowFor(fullCustomerId);
    expect(full).toBeDefined();
    expect(full!.completedAppointments).toBe(2);
    expect(full!.coveredAppointments).toBe(2);
    // Vollständig ⇒ NICHT partiell (completed === covered).
    expect(full!.coveredAppointments).toBe(full!.completedAppointments);

    const partial = await eligibleRowFor(partialCustomerId);
    expect(partial).toBeDefined();
    expect(partial!.completedAppointments).toBe(2);
    expect(partial!.coveredAppointments).toBe(1);
    // Partiell ⇒ dokumentiert > abgedeckt (genau das Signal von isPartiallyDocumented).
    expect(partial!.completedAppointments).toBeGreaterThan(partial!.coveredAppointments);

    // (c) hat keinen signierten LN und keinen dokumentierten Termin → kein Kandidat.
    const none = await eligibleRowFor(noneCustomerId);
    expect(none).toBeUndefined();
  });

  it("SKI-2 — skipIncomplete=true: (b) uebersprungen mit Meldung, (a) erstellt, (c) unberuehrt", async () => {
    const results = await generateAll(true);

    // (a) vollständig dokumentiert → wird abgerechnet.
    const full = resultFor(results, fullCustomerId);
    expect(full).toBeDefined();
    expect(full!.status).toBe("created");

    // (b) partiell dokumentiert → übersprungen mit exakt dieser Meldung.
    const partial = resultFor(results, partialCustomerId);
    expect(partial).toBeDefined();
    expect(partial!.status).toBe("skipped");
    expect(partial!.message).toBe(INCOMPLETE_MSG);

    // (c) kein Kandidat → taucht überhaupt nicht auf (weder erstellt noch übersprungen).
    expect(resultFor(results, noneCustomerId)).toBeUndefined();

    // Kein anderer eigener Kunde wurde mit dieser Meldung übersprungen.
    const wronglySkipped = results.filter(
      (r) => r.message === INCOMPLETE_MSG && r.customerId === fullCustomerId,
    );
    expect(wronglySkipped).toHaveLength(0);
  });
});

describe("SKI-3: skipIncomplete weggelassen/false rechnet auch partiell dokumentierte Kunden ab", () => {
  let partialCustomerId: number;

  beforeAll(async () => {
    // Frischer partiell dokumentierter Kunde (unabhängig vom Skip-Lauf oben):
    // zwei dokumentierte Termine, LN deckt nur den frühen.
    partialCustomerId = await createSelbstzahlerCustomer("partial-nofskip");
    const early = await createApptInDayRange(partialCustomerId, 30, 1, 14, "nofskip-early");
    const late = await createApptInDayRange(partialCustomerId, 30, 15, LAST_DAY, "nofskip-late");
    await documentAppointment(early.id, early.time, 30, "nofskip-early");
    await documentAppointment(late.id, late.time, 30, "nofskip-late");
    await createAndSignServiceRecord(partialCustomerId, [early.id]); // nur 1 von 2
  });

  it("SKI-3.1 — /eligible-customers meldet den Kunden als partiell dokumentiert (completed > covered)", async () => {
    const row = await eligibleRowFor(partialCustomerId);
    expect(row).toBeDefined();
    expect(row!.completedAppointments).toBeGreaterThan(row!.coveredAppointments);
  });

  it("SKI-3.2 — ohne skipIncomplete wird der partiell dokumentierte Kunde NICHT übersprungen, sondern abgerechnet", async () => {
    const results = await generateAll(); // skipIncomplete weggelassen
    const partial = resultFor(results, partialCustomerId);
    expect(partial).toBeDefined();
    // Er wird abgerechnet (deckt den einen abgedeckten Termin ab) …
    expect(partial!.status).toBe("created");
    // … und auf KEINEN Fall mit der „unvollständig"-Meldung übersprungen.
    expect(partial!.message).not.toBe(INCOMPLETE_MSG);
  });
});
