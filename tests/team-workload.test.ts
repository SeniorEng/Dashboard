import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  users,
  employeeTimeEntries,
  appointments,
  appointmentServices,
  services,
  customers,
} from "@shared/schema";
import { loadTeamWorkload } from "../server/lib/team-workload";
import {
  createTestEmployee,
  deactivateTestEmployee,
  getAuthCookie,
  resetAuthCache,
} from "./test-utils";

/**
 * Task #365 / #1640 — Regressionsschutz für die monatsgenaue Divisor-Basis
 * (`monthsConsidered`) in `server/lib/team-workload.ts`.
 *
 * Der Divisor ist die Beschäftigungs-Basis: Werktage AB Eintrittsdatum. Tage
 * vor dem Eintritt schrumpfen den Divisor weiterhin. Abwesenheit
 * (Urlaub/Krankheit) schrumpft den Divisor seit Task #1640 NICHT mehr — sie
 * wird ausschließlich über den expliziten sickVac-Abzug in der SSoT
 * (`computeTeamWorkload`) verrechnet, damit Abwesenheit nicht doppelt zählt.
 * Diese Tests pinnen `monthsConsidered` an konkrete Werte, damit ein
 * versehentliches Zurückdrehen sofort auffällt.
 */

// Festes "now" in der Zukunft → 3-Monats-Fenster = Jan/Feb/Mär 2027.
// Wir wählen einen Zeitpunkt klar nach heute (Mai 2026), damit die
// Test-Termine garantiert keinen Konflikt mit produktiven Daten haben
// und der Test-User unauffällig bleibt.
const NOW = new Date("2027-04-15T12:00:00Z");

// Werktage (Mo–Fr) im Februar 2027 — wir buchen sie alle als Urlaub.
const FEB_WEEKDAYS_2027 = [
  "2027-02-01", "2027-02-02", "2027-02-03", "2027-02-04", "2027-02-05",
  "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12",
  "2027-02-15", "2027-02-16", "2027-02-17", "2027-02-18", "2027-02-19",
  "2027-02-22", "2027-02-23", "2027-02-24", "2027-02-25", "2027-02-26",
];

const createdEmployeeIds: number[] = [];
const createdAppointmentIds: number[] = [];
const createdServiceIds: number[] = [];
const createdCustomerIds: number[] = [];

afterAll(async () => {
  if (createdAppointmentIds.length > 0) {
    try {
      await db
        .delete(appointmentServices)
        .where(inArray(appointmentServices.appointmentId, createdAppointmentIds));
    } catch {}
    try {
      await db
        .delete(appointments)
        .where(inArray(appointments.id, createdAppointmentIds));
    } catch {}
  }
  if (createdServiceIds.length > 0) {
    try {
      await db.delete(services).where(inArray(services.id, createdServiceIds));
    } catch {}
  }
  if (createdCustomerIds.length > 0) {
    try {
      await db.delete(customers).where(inArray(customers.id, createdCustomerIds));
    } catch {}
  }
  for (const id of createdEmployeeIds) {
    try {
      await db
        .delete(employeeTimeEntries)
        .where(eq(employeeTimeEntries.userId, id));
    } catch {}
    await deactivateTestEmployee(id).catch(() => {});
  }
  resetAuthCache();
});

describe("Task #365 / #1640 — team-workload monthsConsidered", () => {
  it("ein voller Urlaubsmonat schrumpft den Divisor NICHT mehr (Abwesenheit zählt separat als sickVac)", async () => {
    await getAuthCookie();
    const emp = await createTestEmployee({ nachnamePrefix: "T365_Vac" });
    createdEmployeeIds.push(emp.id);

    // Eintritt deutlich vor dem Fenster, damit nur Urlaub die Verfügbarkeit
    // reduziert.
    await db
      .update(users)
      .set({ eintrittsdatum: "2024-01-01" })
      .where(eq(users.id, emp.id));

    await db.insert(employeeTimeEntries).values(
      FEB_WEEKDAYS_2027.map((d) => ({
        userId: emp.id,
        entryType: "urlaub",
        entryDate: d,
        isFullDay: true,
        durationMinutes: 480,
      })),
    );

    // Minimal-Kunden anlegen (appointments-Constraint braucht customer_id ODER prospect_id).
    // Wir verwenden raw SQL, damit das Insert nicht an Drizzle/DB-Schema-Drift
    // (z. B. nicht-existierender Spalten wie rechnung_an_kunde) scheitert.
    const custResult = await db.execute<{ id: number }>(
      sql`INSERT INTO customers (name, address, primary_employee_id) VALUES (${`T365 HW ${Date.now()}`}, ${"Teststraße 1, 10115 Berlin"}, ${emp.id}) RETURNING id`,
    );
    const cust = { id: Number((custResult.rows[0] as { id: number }).id) };
    createdCustomerIds.push(cust.id);

    // Hauswirtschaft-Stundenservice anlegen (genügt fürs Workload-SQL).
    const [hwService] = await db
      .insert(services)
      .values({
        name: `T365_HW_${Date.now()}`,
        unitType: "hours",
        lohnartKategorie: "hauswirtschaft",
      })
      .returning({ id: services.id });
    createdServiceIds.push(hwService.id);

    // Dokumentierte Termine: 240 Min im Januar + 240 Min im März.
    // Der Februar bleibt produktiv leer (kompletter Urlaub) → Σ = 480 Min.
    // Der Divisor bleibt 3.0 (Eintritt weit vor dem Fenster, Abwesenheit
    // schrumpft ihn seit #1640 NICHT mehr) → 480 / 3 = 160.
    const apptValues = [
      { date: "2027-01-15", duration: 240 },
      { date: "2027-03-15", duration: 240 },
    ];
    for (const { date, duration } of apptValues) {
      const [appt] = await db
        .insert(appointments)
        .values({
          customerId: cust.id,
          appointmentType: "kundentermin",
          date,
          scheduledStart: "09:00:00",
          durationPromised: duration,
          status: "documented",
          performedByEmployeeId: emp.id,
          assignedEmployeeId: emp.id,
        })
        .returning({ id: appointments.id });
      createdAppointmentIds.push(appt.id);
      await db.insert(appointmentServices).values({
        appointmentId: appt.id,
        serviceId: hwService.id,
        plannedDurationMinutes: duration,
        actualDurationMinutes: duration,
      });
    }

    const rows = await loadTeamWorkload(NOW);
    const row = rows.find((r) => r.employeeId === emp.id);

    expect(row, "Mitarbeiter sollte in der Workload-Liste auftauchen").toBeDefined();
    // Kernregression #1640: Abwesenheit schrumpft den Divisor NICHT. Alle drei
    // Monate sind Beschäftigungs-Monate (Eintritt 2024) → monthsConsidered = 3.0.
    // Würde die alte absence-shrink-Logik zurückkehren, käme hier 2.0 raus.
    expect(row!.monthsConsidered).toBeCloseTo(3.0, 2);
    // 480 produktive Min / 3 = 160.
    expect(row!.avgMonthlyHwMinutes).toBe(160);
    expect(row!.avgMonthlyAllMinutes).toBe(0);
    // Der volle Urlaubsmonat taucht stattdessen als sickVac-Abzug auf:
    // 20 Werktage × 480 Min = 9600 Min / 3 = 3200.
    expect(row!.avgSickVacMinutes).toBe(3200);
  });

  it("schliesst Tage vor dem Eintrittsdatum aus dem Fenster aus", async () => {
    await getAuthCookie();
    const emp = await createTestEmployee({ nachnamePrefix: "T365_Eintritt" });
    createdEmployeeIds.push(emp.id);

    // Eintritt mitten im Fenster: 1.2.2027 → Januar zählt nicht mehr mit.
    await db
      .update(users)
      .set({ eintrittsdatum: "2027-02-01" })
      .where(eq(users.id, emp.id));

    const rows = await loadTeamWorkload(NOW);
    const row = rows.find((r) => r.employeeId === emp.id);

    expect(row, "Mitarbeiter sollte in der Workload-Liste auftauchen").toBeDefined();
    // Jan = 0.0 (vor Eintritt), Feb = 1.0, Mär = 1.0 → 2.0.
    expect(row!.monthsConsidered).toBeCloseTo(2.0, 2);
  });
});
