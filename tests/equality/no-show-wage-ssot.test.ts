/**
 * Task #167 — SSoT: "Was ist eine Leerfahrt (No-Show) wert?" (Lohn an den MA)
 *
 * Ein `customer_no_show` (vergebliche Anfahrt) wird dem Mitarbeiter bezahlt:
 * origin-gated Fahrtzeit (`travel_minutes` nur wenn `travel_origin_type =
 * 'appointment'`) + gedeckelte Wartezeit (`no_show_wait_minutes`, max
 * {@link NO_SHOW_WAIT_CAP_MINUTES}), bewertet zum Hauswirtschafts-Satz; die
 * No-Show-Km stammen ausschließlich aus `no_show_kilometers`. Diese Frage
 * beantwortet die EINE Domänen-SSoT `computeNoShowWage`
 * (shared/domain/no-show-wage.ts).
 *
 * Zwei Lesepfade konsumieren diese Zahlen:
 *   - Mitarbeiter-Sicht  "Meine Zeiten"        → `getTimeOverview` (Leerfahrten)
 *   - Admin-Sicht        "Mitarbeiterabrechnung"→ `getEmployeePayrollRows`
 *
 * Historisch rechneten beide Sichten unabhängig — sobald eine die Regel
 * (Cap, origin-Gate, Km-Quelle, Bewertung) anders auslegte, drifteten die
 * ausgezahlten Beträge auseinander. Dieser Test bucht EINEN No-Show mit
 * absichtlich „giftigen" Eingaben (Wartezeit > Cap, Fahrt von zu Hause vs. von
 * Termin) und prüft, dass beide Sichten identische Lohn-Minuten und Km ableiten
 * und die Bewertung exakt `round(Minuten/60 * HW-Satz)` ist.
 *
 * Läuft eine Sicht je wieder auf eine eigene Rechnung, wird dieser Test rot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, users } from "@shared/schema";
import { getTimeOverview } from "../../server/storage/time-tracking/overview";
import { getEmployeePayrollRows } from "../../server/storage/time-tracking/payroll-hours";
import {
  computeNoShowWage,
  NO_SHOW_WAIT_CAP_MINUTES,
} from "@shared/domain/no-show-wage";
import {
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft + Juli (kein bundesweiter Feiertag) → keine Feiertags-
// Stunden für den Minijobber, damit brutto == reiner Leerfahrten-Lohn.
// Direkte DB-Inserts → Wochenend-/Cutoff-Policies spielen keine Rolle.
const YEAR = 2033;
const MONTH = 7;
const DATE = `${YEAR}-0${MONTH}-13`;

// HW-Satz aus dem Katalog (services.hauswirtschaft.employeeRateCents). Ein
// frischer Test-Mitarbeiter hat keine `role_wage_rates`-Zeile → der Lohn fällt
// auf diesen Katalog-Default zurück (siehe resolvedWageCentsSql).
const HW_RATE_CENTS = 1600;

// Giftige Eingaben: Wartezeit ÜBER dem Cap (muss auf 15 gedeckelt werden),
// Fahrtzeit gesetzt (zählt nur bei origin='appointment'), echte No-Show-Km.
const TRAVEL_MINUTES = 40;
const RAW_WAIT_MINUTES = 20; // > NO_SHOW_WAIT_CAP_MINUTES → wird gekappt
const NO_SHOW_KM = 25;

let empFromAppt: { id: number };
let empFromHome: { id: number };
let customerId: number;

async function makeMinijobber(prefix: string): Promise<{ id: number }> {
  const emp = await createTestEmployee({ nachnamePrefix: prefix });
  await db
    .update(users)
    .set({ employmentType: "minijobber" })
    .where(eq(users.id, emp.id));
  return { id: emp.id };
}

beforeAll(async () => {
  await getAuthCookie();
  empFromAppt = await makeMinijobber("NoShowWageAppt");
  empFromHome = await makeMinijobber("NoShowWageHome");

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      const { apiPost } = await import("../test-utils");
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch {
      /* best-effort */
    }
  });

  // MA #1: kommt von einem anderen Termin → Fahrtzeit zählt.
  await db.insert(appointments).values({
    customerId,
    appointmentType: "kundentermin",
    date: DATE,
    scheduledStart: "09:00",
    scheduledEnd: "10:00",
    durationPromised: 60,
    status: "customer_no_show",
    assignedEmployeeId: empFromAppt.id,
    performedByEmployeeId: empFromAppt.id,
    travelOriginType: "appointment",
    travelMinutes: TRAVEL_MINUTES,
    noShowWaitMinutes: RAW_WAIT_MINUTES,
    noShowKilometers: NO_SHOW_KM,
  });

  // MA #2: kommt von zu Hause → Fahrtzeit zählt NICHT (origin-gated).
  await db.insert(appointments).values({
    customerId,
    appointmentType: "kundentermin",
    date: DATE,
    scheduledStart: "11:00",
    scheduledEnd: "12:00",
    durationPromised: 60,
    status: "customer_no_show",
    assignedEmployeeId: empFromHome.id,
    performedByEmployeeId: empFromHome.id,
    travelOriginType: "home",
    travelMinutes: TRAVEL_MINUTES, // gesetzt, muss aber ignoriert werden
    noShowWaitMinutes: RAW_WAIT_MINUTES,
    noShowKilometers: NO_SHOW_KM,
  });
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #167 — No-Show-Lohn SSoT (computeNoShowWage)", () => {
  it("Wartezeit wird auf den Cap gedeckelt (Eingabe > Cap)", () => {
    const wage = computeNoShowWage({
      travelOriginType: "appointment",
      travelMinutes: TRAVEL_MINUTES,
      noShowWaitMinutes: RAW_WAIT_MINUTES,
      noShowKilometers: NO_SHOW_KM,
    });
    expect(RAW_WAIT_MINUTES).toBeGreaterThan(NO_SHOW_WAIT_CAP_MINUTES);
    expect(wage.waitMinutes).toBe(NO_SHOW_WAIT_CAP_MINUTES);
    expect(wage.paidMinutes).toBe(TRAVEL_MINUTES + NO_SHOW_WAIT_CAP_MINUTES);
  });

  it("origin='appointment': Anzeige und Abrechnung leiten identische Lohn-Minuten/Km ab", async () => {
    const wage = computeNoShowWage({
      travelOriginType: "appointment",
      travelMinutes: TRAVEL_MINUTES,
      noShowWaitMinutes: RAW_WAIT_MINUTES,
      noShowKilometers: NO_SHOW_KM,
    });

    const overview = await getTimeOverview(empFromAppt.id, { year: YEAR, month: MONTH });
    expect(overview.leerfahrten!.count).toBe(1);
    expect(overview.leerfahrten!.wageMinutes).toBe(wage.paidMinutes);
    expect(overview.leerfahrten!.kilometers).toBe(wage.kilometers);

    const { rows } = await getEmployeePayrollRows(YEAR, MONTH);
    const adminRow = rows.find(r => r.employeeId === empFromAppt.id);
    expect(adminRow).toBeDefined();

    // Anzeige (Minuten/60) === Admin-Stunden.
    expect(adminRow!.stundenLeerfahrten).toBeCloseTo(wage.paidMinutes / 60, 2);
    expect(adminRow!.kilometerLeerfahrten).toBeCloseTo(wage.kilometers, 1);

    // Bewertung exakt round(Minuten/60 * HW-Satz); Minijobber mit NUR diesem
    // Termin ⇒ brutto == reiner Leerfahrten-Lohn.
    const expectedWageCents = Math.round((wage.paidMinutes / 60) * HW_RATE_CENTS);
    expect(adminRow!.minijob).not.toBeNull();
    expect(adminRow!.minijob!.bruttoCents).toBe(expectedWageCents);
  });

  it("origin='home': Fahrtzeit wird ignoriert, nur gedeckelte Wartezeit zählt (beide Sichten)", async () => {
    const wage = computeNoShowWage({
      travelOriginType: "home",
      travelMinutes: TRAVEL_MINUTES,
      noShowWaitMinutes: RAW_WAIT_MINUTES,
      noShowKilometers: NO_SHOW_KM,
    });
    expect(wage.travelMinutes).toBe(0);
    expect(wage.paidMinutes).toBe(NO_SHOW_WAIT_CAP_MINUTES);

    const overview = await getTimeOverview(empFromHome.id, { year: YEAR, month: MONTH });
    expect(overview.leerfahrten!.wageMinutes).toBe(wage.paidMinutes);
    expect(overview.leerfahrten!.travelMinutes).toBe(0);

    const { rows } = await getEmployeePayrollRows(YEAR, MONTH);
    const adminRow = rows.find(r => r.employeeId === empFromHome.id);
    expect(adminRow!.stundenLeerfahrten).toBeCloseTo(wage.paidMinutes / 60, 2);

    const expectedWageCents = Math.round((wage.paidMinutes / 60) * HW_RATE_CENTS);
    expect(adminRow!.minijob!.bruttoCents).toBe(expectedWageCents);
  });
});
