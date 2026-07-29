/**
 * Task #1886 — Erstberatung ist ZWEISEITIG:
 *
 *  - KUNDENSEITE: nie abgerechnet. Eine abgeschlossene, kundenlose Erstberatung
 *    (`appointment_type='Erstberatung'`, `customer_id=NULL`) darf in den
 *    kundenseitigen „abrechenbar/dokumentiert aber fehlt"-Audits (hier: der
 *    Prozess-Gesundheits-KPI `appointmentsWithoutRecord`) NICHT als Lücke
 *    auftauchen und nie als „Kundenunterschrift fehlt" geflaggt werden.
 *  - MITARBEITERSEITE: zählt voll. Dieselbe Erstberatung muss in der
 *    Mitarbeiterabrechnung (`getEmployeePayrollRows` → `stundenErstberatung`)
 *    als geleistete Arbeitszeit erscheinen.
 *
 * Zur Gegenprobe zeigt ein ansonsten identischer echter Kundentermin (completed,
 * ohne Leistungsnachweis, unsigniert), dass die Kunden-Lücken-Kennzahl für echte
 * Kunden-Termine UNVERÄNDERT anschlägt (keine Regression durch den Carve-out).
 *
 * DB-Integrationstest: seedet einen isolierten historischen Monat direkt per
 * Insert und prüft die exportierten SSoTs. Deltas statt Absolutwerte, damit
 * Fremddaten/Parallelität die Aussage nicht verfälschen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { getAuthCookie, createTestEmployee, createTestCustomer, cleanupCustomer } from "./test-utils";
import { getProcessHealthSummary } from "../server/storage/statistics/process-health";
import { getEmployeePayrollRows } from "../server/storage/time-tracking/payroll-hours";
import { resolvePeriod } from "../server/storage/statistics/common";

// resolvePeriod validiert year >= 2020; isolierter, sonst ungenutzter Monat
// (weit weg von 2021-03 des process-health-Tests und den 2025/2026-Budget-Tests),
// damit parallele Test-Daten die Delta-Assertions nicht verfälschen.
const YEAR = 2020;
const MONTH = 11;
const PERIOD = resolvePeriod({ year: YEAR, month: MONTH });

let employeeId: number;
let erstberatungServiceId: number;
let prospectId: number;
const appointmentIds: number[] = [];
const customerIds: number[] = [];

function dateOf(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Abgeschlossene, kundenlose Erstberatung (customer_id NULL) mit 60 Service-Minuten,
 *  ausgeführt vom Test-Mitarbeiter. */
async function insertErstberatung(day: number): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO appointments (
      prospect_id, customer_id, appointment_type, date, scheduled_start,
      scheduled_end, duration_promised, status, performed_by_employee_id, assigned_employee_id
    ) VALUES (
      ${prospectId}, NULL, 'Erstberatung', ${dateOf(day)}::date, '10:00:00',
      '11:00:00', 60, 'completed', ${employeeId}, ${employeeId}
    ) RETURNING id
  `);
  const apptId = Number((r.rows[0] as { id: number }).id);
  await db.execute(sql`
    INSERT INTO appointment_services (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
    VALUES (${apptId}, ${erstberatungServiceId}, 60, 60)
  `);
  appointmentIds.push(apptId);
  return apptId;
}

/** Echter Kundentermin: completed, unsigniert, ohne Leistungsnachweis → echte
 *  kundenseitige Lücke. */
async function insertKundentermin(customerId: number, day: number): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO appointments (
      customer_id, appointment_type, date, scheduled_start, scheduled_end,
      duration_promised, status, performed_by_employee_id, assigned_employee_id
    ) VALUES (
      ${customerId}, 'kundentermin', ${dateOf(day)}::date, '12:00:00', '13:00:00',
      60, 'completed', ${employeeId}, ${employeeId}
    ) RETURNING id
  `);
  const apptId = Number((r.rows[0] as { id: number }).id);
  appointmentIds.push(apptId);
  return apptId;
}

async function woRecordCount(): Promise<number> {
  return (await getProcessHealthSummary(PERIOD)).appointmentsWithoutRecord.current;
}

async function payrollRow() {
  const { rows } = await getEmployeePayrollRows(YEAR, MONTH);
  return rows.find((r) => r.employeeId === employeeId);
}

beforeAll(async () => {
  await getAuthCookie();
  const emp = await createTestEmployee({ nachnamePrefix: "t1886" });
  employeeId = emp.id;
  const svc = await db.execute(sql`SELECT id FROM services WHERE code = 'erstberatung' LIMIT 1`);
  erstberatungServiceId = Number((svc.rows[0] as { id: number }).id);
  const prospectRes = await db.execute(sql`
    INSERT INTO prospects (vorname, nachname, status)
    VALUES ('Test1886', 'ZweiseitigProspect', 'neu')
    RETURNING id
  `);
  prospectId = Number((prospectRes.rows[0] as { id: number }).id);
});

afterAll(async () => {
  if (appointmentIds.length > 0) {
    await db.execute(sql`DELETE FROM appointment_services WHERE appointment_id IN (${sql.join(appointmentIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM appointments WHERE id IN (${sql.join(appointmentIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (prospectId) await db.execute(sql`DELETE FROM prospects WHERE id = ${prospectId}`);
  for (const id of customerIds) await cleanupCustomer(id);
});

describe("Task #1886 – Erstberatung: Kundenabrechnung nein, Mitarbeiterabrechnung ja", () => {
  it("eine abgeschlossene Erstberatung erhöht die Kunden-Lücken-KPI NICHT und wird nicht als 'Unterschrift fehlt' geflaggt, bleibt aber in der Mitarbeiterabrechnung erhalten", async () => {
    const before = await woRecordCount();

    await insertErstberatung(4);

    // Kundenseite: kein neuer „Termin ohne Leistungsnachweis".
    expect(await woRecordCount()).toBe(before);

    // Mitarbeiterseite: 60 Min Erstberatung = 1 h, voll erfasst; NICHT als
    // „Kundenunterschrift fehlt" gezählt (kundenlos).
    const row = await payrollRow();
    expect(row).toBeDefined();
    expect(row!.stundenErstberatung).toBeGreaterThan(0);
    expect(row!.unsignedAppointmentCount).toBe(0);
  });

  it("ein echter Kundentermin (completed, ohne LN) schlägt in derselben Kunden-Lücken-KPI weiterhin an (kein Overblocking)", async () => {
    const c = await createTestCustomer();
    customerIds.push(c.id);

    const before = await woRecordCount();
    await insertKundentermin(c.id, 5);

    expect(await woRecordCount()).toBe(before + 1);

    // Gegenprobe Mitarbeiterseite: der echte unsignierte Kundentermin IST eine
    // „Kundenunterschrift fehlt"-Position (Abgrenzung zur Erstberatung oben).
    const row = await payrollRow();
    expect(row!.unsignedAppointmentCount).toBeGreaterThan(0);
  });
});
