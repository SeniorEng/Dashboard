import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Massenerstellung — „nur Kunden ohne offene Termine abrechnen" (Task #1771)
 *
 * Der Dialog „Alle erstellen" hat GENAU EINE Checkbox `readyOnly`
 * (`POST /api/billing/generate-all`, Feld `readyOnly`), per Default AN:
 *   - readyOnly=true  → NUR Kunden OHNE offene (geplante) Termine werden
 *     abgerechnet; Kunden mit noch offenen Terminen werden NICHT abgerechnet,
 *     sondern als „übersprungen" mit der Meldung „Noch offene Termine" gemeldet.
 *   - readyOnly weggelassen/false → ALLE berechtigten Kunden (mit signiertem LN)
 *     werden abgerechnet (Bestandsverhalten).
 *
 * Damit trifft die Massenerstellung DIESELBE Menge wie die Karten-Gruppierung
 * „Bereit zum Abrechnen" auf der Abrechnungsseite — beide leiten „offen?" aus
 * DERSELBEN SSoT ab (`getClusterAmountAppointmentsByCustomer` bzw.
 * `hasOpenAppointments`, FINAL_APPOINTMENT_STATUSES). Dieser Test sichert ab:
 *   (a) ein READY-Kunde (dokumentiert+signiert, KEIN offener Termin) wird bei
 *       readyOnly=true trotzdem abgerechnet,
 *   (b) ein OPEN-Kunde (dokumentiert+signierter LN, ABER zusätzlich ein offener
 *       geplanter Termin im Monat) wird bei readyOnly=true übersprungen — mit
 *       exakt dieser Meldung,
 *   (c) derselbe OPEN-Kunde wird ohne readyOnly abgerechnet (der abgedeckte
 *       Termin wird berechnet, der offene ignoriert).
 * Eine Regression würde entweder legitime Rechnungen still fallenlassen oder
 * Kunden mit offenen Terminen fälschlich mit-abrechnen.
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
        notes: `RO-${tag}-${uniqueId()}`,
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
    vorname: "RO",
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
        nachname: "RO",
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

async function generateAll(readyOnly?: boolean): Promise<GenResult[]> {
  const body: Record<string, any> = { billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR };
  if (readyOnly !== undefined) body.readyOnly = readyOnly;
  const res = await apiPost<any>("/api/billing/generate-all", body);
  if (res.status !== 200) {
    throw new Error(`generate-all failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return (res.data.results ?? []) as GenResult[];
}

function resultFor(results: GenResult[], customerId: number): GenResult | undefined {
  return results.find((r) => r.customerId === customerId);
}

const OPEN_MSG = "Noch offene Termine";

// ---------- Lifecycle ----------

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<any[]>("/api/services/all");
  const hw = servicesRes.data.find((s: any) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestRO" });
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

describe("RO: generate-all readyOnly rechnet nur Kunden OHNE offene Termine ab", () => {
  let readyCustomerId: number; // (a) dokumentiert+signiert, KEIN offener Termin
  let openCustomerId: number;  // (b) dokumentiert+signierter LN + zusätzl. offener Termin

  beforeAll(async () => {
    // (a) READY: ein dokumentierter Termin, LN deckt ihn ab, KEIN offener Termin.
    readyCustomerId = await createSelbstzahlerCustomer("ready");
    const readyAppt = await createApptInDayRange(readyCustomerId, 30, 1, 14, "ready");
    await documentAppointment(readyAppt.id, readyAppt.time, 30, "ready");
    await createAndSignServiceRecord(readyCustomerId); // deckt den einen Termin

    // (b) OPEN: ERST einen Termin dokumentieren + signierten LN erstellen (macht
    // den Kunden zum Abrechnungs-Kandidaten), DANACH einen zusätzlichen geplanten
    // (undokumentierten) Termin anlegen → offener Termin im Monat.
    openCustomerId = await createSelbstzahlerCustomer("open");
    const openEarly = await createApptInDayRange(openCustomerId, 30, 1, 14, "open-early");
    await documentAppointment(openEarly.id, openEarly.time, 30, "open-early");
    await createAndSignServiceRecord(openCustomerId, [openEarly.id]); // deckt den frühen
    // Zusätzlicher geplanter Termin (NICHT dokumentiert) → offener Termin im Monat.
    await createApptInDayRange(openCustomerId, 30, 15, LAST_DAY, "open-late");
  });

  it("RO-1 — /eligible-customers listet beide Kunden als Kandidaten (signierter LN im Monat)", async () => {
    const ready = await eligibleRowFor(readyCustomerId);
    expect(ready).toBeDefined();
    expect(ready!.completedAppointments).toBe(1);
    expect(ready!.coveredAppointments).toBe(1);

    // Der OPEN-Kunde hat GENAU EINEN dokumentierten (abgedeckten) Termin; der
    // zusätzliche geplante Termin ist NICHT dokumentiert (taucht hier nicht als
    // completed auf) — er ist der offene Termin, der den Skip auslöst.
    const open = await eligibleRowFor(openCustomerId);
    expect(open).toBeDefined();
    expect(open!.completedAppointments).toBe(1);
    expect(open!.coveredAppointments).toBe(1);
  });

  it("RO-2 — readyOnly=true: READY wird erstellt, OPEN uebersprungen mit Meldung", async () => {
    const results = await generateAll(true);

    // (a) READY (kein offener Termin) → wird abgerechnet.
    const ready = resultFor(results, readyCustomerId);
    expect(ready).toBeDefined();
    expect(ready!.status).toBe("created");

    // (b) OPEN (noch offener Termin) → übersprungen mit exakt dieser Meldung.
    const open = resultFor(results, openCustomerId);
    expect(open).toBeDefined();
    expect(open!.status).toBe("skipped");
    expect(open!.message).toBe(OPEN_MSG);

    // Der READY-Kunde wurde NICHT fälschlich mit der offene-Termine-Meldung übersprungen.
    const wronglySkipped = results.filter(
      (r) => r.message === OPEN_MSG && r.customerId === readyCustomerId,
    );
    expect(wronglySkipped).toHaveLength(0);
  });
});

describe("RO-3: generate-all ohne readyOnly rechnet auch Kunden mit offenen Terminen ab", () => {
  let openCustomerId: number;

  beforeAll(async () => {
    // Frischer OPEN-Kunde (unabhängig vom Lauf oben): ein dokumentierter +
    // signierter Termin plus ein zusätzlicher geplanter (offener) Termin.
    openCustomerId = await createSelbstzahlerCustomer("open-noflag");
    const early = await createApptInDayRange(openCustomerId, 30, 1, 14, "noflag-early");
    await documentAppointment(early.id, early.time, 30, "noflag-early");
    await createAndSignServiceRecord(openCustomerId, [early.id]); // deckt den frühen
    await createApptInDayRange(openCustomerId, 30, 15, LAST_DAY, "noflag-late");
  });

  it("RO-3.1 — /eligible-customers meldet den Kunden als Kandidaten (signierter LN)", async () => {
    const row = await eligibleRowFor(openCustomerId);
    expect(row).toBeDefined();
    expect(row!.coveredAppointments).toBeGreaterThan(0);
  });

  it("RO-3.2 — ohne readyOnly wird der Kunde mit offenem Termin NICHT übersprungen, sondern abgerechnet", async () => {
    const results = await generateAll(); // readyOnly weggelassen
    const open = resultFor(results, openCustomerId);
    expect(open).toBeDefined();
    // Er wird abgerechnet (deckt den einen abgedeckten Termin ab) …
    expect(open!.status).toBe("created");
    // … und auf KEINEN Fall mit der offene-Termine-Meldung übersprungen.
    expect(open!.message).not.toBe(OPEN_MSG);
  });
});
