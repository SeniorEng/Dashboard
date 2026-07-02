/**
 * Task #1576 — End-to-End: origin-gated Leerfahrt-Lohnzeit über die ECHTE Route.
 *
 * Task #1575 hat auf Schema-Ebene abgesichert, dass ein No-Show-Submit mit
 * `travelOriginType='appointment'` OHNE `travelMinutes` abgelehnt wird. Das
 * schützt nur den Request-Contract. Dieser Test fährt den vollen No-Show-
 * Dokumentations-Pfad (`POST /api/appointments/:id/document-no-show`,
 * server/routes/appointment-documentation.ts) und prüft, dass die
 * origin-gekoppelte Lohn-Fahrtzeit stromabwärts tatsächlich als Nicht-Null
 * persistiert/berechnet ankommt.
 *
 * Zwei Fälle:
 *   - origin='appointment' + travelMinutes  → Fahrtzeit zählt (paid = Fahrt + Wartezeit)
 *   - origin='home'        + travelMinutes  → Fahrtzeit wird ignoriert (paid = Wartezeit)
 *
 * Verifiziert wird über dieselben zwei Lesepfade wie die SSoT-Tests:
 *   - Mitarbeiter-Sicht  "Meine Zeiten"        → `getTimeOverview` (Leerfahrten)
 *   - Admin-Sicht        "Mitarbeiterabrechnung"→ `getEmployeePayrollRows`
 *
 * Würde der Schreibpfad die origin-Kopplung droppen (Schema validiert, aber
 * die Fahrtzeit landet nie in `travelMinutes`/wird nie bezahlt), wird dieser
 * Test rot — genau die Regression, die der reine Schema-Guard NICHT sieht.
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
  apiPost,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft + Juli (kein bundesweiter Feiertag) → keine Feiertags-
// Stunden für den Minijobber, damit brutto == reiner Leerfahrten-Lohn.
// 2034-07-13 ist ein Donnerstag (kein Wochenende).
const YEAR = 2034;
const MONTH = 7;
const DATE = `${YEAR}-0${MONTH}-13`;

// HW-Satz aus dem Katalog (services.hauswirtschaft.employeeRateCents). Ein
// frischer Test-Mitarbeiter hat keine `role_wage_rates`-Zeile → der Lohn fällt
// auf diesen Katalog-Default zurück.
const HW_RATE_CENTS = 1600;

const TRAVEL_MINUTES = 30;
const WAIT_MINUTES = 10; // ≤ NO_SHOW_WAIT_CAP_MINUTES
const NO_SHOW_KM = 12;

let empFromAppt: { id: number };
let empFromHome: { id: number };
let customerId: number;
let apptFromApptId = 0;
let apptFromHomeId = 0;

async function makeMinijobber(prefix: string): Promise<{ id: number }> {
  const emp = await createTestEmployee({ nachnamePrefix: prefix });
  await db
    .update(users)
    .set({ employmentType: "minijobber" })
    .where(eq(users.id, emp.id));
  return { id: emp.id };
}

async function insertScheduledAppointment(employeeId: number, start: string, end: string): Promise<number> {
  const [row] = await db
    .insert(appointments)
    .values({
      customerId,
      appointmentType: "kundentermin",
      date: DATE,
      scheduledStart: start,
      scheduledEnd: end,
      durationPromised: 60,
      status: "scheduled",
      assignedEmployeeId: employeeId,
    })
    .returning({ id: appointments.id });
  return row.id;
}

beforeAll(async () => {
  await getAuthCookie();
  empFromAppt = await makeMinijobber("NoShowRouteAppt");
  empFromHome = await makeMinijobber("NoShowRouteHome");

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch {
      /* best-effort */
    }
  });

  apptFromApptId = await insertScheduledAppointment(empFromAppt.id, "09:00", "10:00");
  apptFromHomeId = await insertScheduledAppointment(empFromHome.id, "11:00", "12:00");
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #1576 — No-Show Leerfahrt-Lohn über die echte Route (origin-gated)", () => {
  it("origin='appointment': volle Route persistiert nicht-null Fahrt-Lohnzeit", async () => {
    const res = await apiPost<any>(`/api/appointments/${apptFromApptId}/document-no-show`, {
      actualStart: "09:00",
      travelOriginType: "appointment",
      travelFromAppointmentId: null,
      travelMinutes: TRAVEL_MINUTES,
      travelKilometers: NO_SHOW_KM,
      noShowReason: "nicht_angetroffen",
      noShowWaitMinutes: WAIT_MINUTES,
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("customer_no_show");

    const wage = computeNoShowWage({
      travelOriginType: "appointment",
      travelMinutes: TRAVEL_MINUTES,
      noShowWaitMinutes: WAIT_MINUTES,
      noShowKilometers: NO_SHOW_KM,
    });
    // Sanity: die Fahrtzeit trägt echt zum Lohn bei (nicht 0).
    expect(wage.travelMinutes).toBe(TRAVEL_MINUTES);
    expect(wage.paidMinutes).toBe(TRAVEL_MINUTES + WAIT_MINUTES);

    // Persistiert: die Route hat travelMinutes + origin geschrieben.
    const [persisted] = await db
      .select({
        travelOriginType: appointments.travelOriginType,
        travelMinutes: appointments.travelMinutes,
        noShowWaitMinutes: appointments.noShowWaitMinutes,
        noShowKilometers: appointments.noShowKilometers,
      })
      .from(appointments)
      .where(eq(appointments.id, apptFromApptId))
      .limit(1);
    expect(persisted.travelOriginType).toBe("appointment");
    expect(persisted.travelMinutes).toBe(TRAVEL_MINUTES);

    // Anzeige (Meine Zeiten → Leerfahrten): nicht-null Fahrt-Lohnzeit.
    const overview = await getTimeOverview(empFromAppt.id, { year: YEAR, month: MONTH });
    expect(overview.leerfahrten!.count).toBe(1);
    expect(overview.leerfahrten!.travelMinutes).toBe(TRAVEL_MINUTES);
    expect(overview.leerfahrten!.travelMinutes).toBeGreaterThan(0);
    expect(overview.leerfahrten!.wageMinutes).toBe(wage.paidMinutes);
    expect(overview.leerfahrten!.kilometers).toBe(NO_SHOW_KM);

    // Abrechnung (Mitarbeiterabrechnung): identische Stunden + Bewertung.
    const { rows } = await getEmployeePayrollRows(YEAR, MONTH);
    const adminRow = rows.find(r => r.employeeId === empFromAppt.id);
    expect(adminRow).toBeDefined();
    expect(adminRow!.stundenLeerfahrten).toBeCloseTo(wage.paidMinutes / 60, 2);

    const expectedWageCents = Math.round((wage.paidMinutes / 60) * HW_RATE_CENTS);
    expect(adminRow!.minijob).not.toBeNull();
    expect(adminRow!.minijob!.bruttoCents).toBe(expectedWageCents);
  });

  it("origin='home': volle Route ignoriert die Fahrtzeit, nur Wartezeit zählt", async () => {
    const res = await apiPost<any>(`/api/appointments/${apptFromHomeId}/document-no-show`, {
      actualStart: "11:00",
      travelOriginType: "home",
      // travelMinutes bewusst gesetzt, muss aber ignoriert werden (origin-gate).
      travelMinutes: TRAVEL_MINUTES,
      travelKilometers: NO_SHOW_KM,
      noShowReason: "nicht_angetroffen",
      noShowWaitMinutes: WAIT_MINUTES,
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("customer_no_show");

    const wage = computeNoShowWage({
      travelOriginType: "home",
      travelMinutes: TRAVEL_MINUTES,
      noShowWaitMinutes: WAIT_MINUTES,
      noShowKilometers: NO_SHOW_KM,
    });
    expect(wage.travelMinutes).toBe(0);
    expect(wage.paidMinutes).toBe(WAIT_MINUTES);
    expect(WAIT_MINUTES).toBeLessThanOrEqual(NO_SHOW_WAIT_CAP_MINUTES);

    // Anzeige: Fahrtzeit wird NICHT bezahlt (origin='home').
    const overview = await getTimeOverview(empFromHome.id, { year: YEAR, month: MONTH });
    expect(overview.leerfahrten!.count).toBe(1);
    expect(overview.leerfahrten!.travelMinutes).toBe(0);
    expect(overview.leerfahrten!.wageMinutes).toBe(wage.paidMinutes);

    // Abrechnung: identische Stunden + Bewertung.
    const { rows } = await getEmployeePayrollRows(YEAR, MONTH);
    const adminRow = rows.find(r => r.employeeId === empFromHome.id);
    expect(adminRow).toBeDefined();
    expect(adminRow!.stundenLeerfahrten).toBeCloseTo(wage.paidMinutes / 60, 2);

    const expectedWageCents = Math.round((wage.paidMinutes / 60) * HW_RATE_CENTS);
    expect(adminRow!.minijob).not.toBeNull();
    expect(adminRow!.minijob!.bruttoCents).toBe(expectedWageCents);
  });
});
