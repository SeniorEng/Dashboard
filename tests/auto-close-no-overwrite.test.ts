/**
 * Task #1119 / #1496 — Regressionsschutz: Der automatische Monatsabschluss
 * überschreibt KEINEN Termin-Status (insbesondere nicht auf `expired_unsigned`).
 *
 * Die Periodensperre hängt allein an `employee_month_closings`. „Nicht
 * abgerechnet" ist ein abgeleitetes Anzeige-Label (`deriveAppointmentDisplayStatus`)
 * und wird NIE persistiert.
 *
 * Task #1496 macht den Auto-Close zur EINZIGEN Abschluss-Mechanik und schließt
 * BEDINGUNGSLOS: Auch wenn noch offene (nicht dokumentierte) oder unsignierte
 * Termine existieren, wird der Monat geschlossen — es gibt keinen blockierenden/
 * eskalierenden Pfad mehr. Dieser Test stellt sicher, dass dabei
 *   (1) der Termin-Status unverändert bleibt (kein Schreibvorgang),
 *   (2) die Periodensperre TROTZ offenem Termin geschrieben wird (Monat zu),
 *   (3) KEINE Blockade-/Eskalations-Audits entstehen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { autoCloseMonthForCutoff } from "../server/services/month-close-scheduler";
import { computeMonthCloseCutoff } from "../shared/utils/month-close-cutoff";
import {
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  assignEmployeeToCustomer,
  createAndDocumentAppointment,
} from "./test-utils";

async function getSeededServiceId(): Promise<number> {
  const res = await db.execute(sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`);
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

const TARGET_YEAR = 2023;
const TARGET_MONTH = 3;

describe("Task #1119/#1496: Auto-Close schließt bedingungslos ohne Status-Überschreibung", () => {
  let customerId: number;
  let employeeId: number;
  let openAppointmentId: number;

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededServiceId();
    const employee = await createTestEmployee();
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // Aktivität im Zielmonat: ein completed+unterschriebener Termin macht den
    // Mitarbeiter überhaupt erst zum Abschluss-Kandidaten (Aktivitäts-Gate).
    const signed = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      date: `${TARGET_YEAR}-0${TARGET_MONTH}-10`,
    });
    await db.execute(sql`
      UPDATE appointments
      SET performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId},
          signature_data = 'data:image/png;base64,NOOVERWRITE_SIGNED'
      WHERE id = ${signed.appointmentId}
    `);

    // Ein offener (nicht abgeschlossener) Termin, der den Auto-Close NICHT mehr
    // blockiert — dessen Status aber NICHT überschrieben werden darf.
    const open = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      date: `${TARGET_YEAR}-0${TARGET_MONTH}-15`,
    });
    openAppointmentId = open.appointmentId;
    await db.execute(sql`
      UPDATE appointments
      SET date = ${`${TARGET_YEAR}-0${TARGET_MONTH}-15`},
          status = 'documenting',
          signature_data = NULL,
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId}
      WHERE id = ${openAppointmentId}
    `);
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
  });

  it("schließt bedingungslos und lässt den Termin-Status unangetastet", async () => {
    const cutoff = computeMonthCloseCutoff(TARGET_YEAR, TARGET_MONTH);
    const result = await autoCloseMonthForCutoff(cutoff);

    expect(result.skipped).toBe(false);

    // (1) Termin-Status bleibt der wahre Lebenszyklus-Status — NICHT expired_unsigned.
    const statusRes = await db.execute(sql`SELECT status FROM appointments WHERE id = ${openAppointmentId}`);
    expect((statusRes.rows?.[0] as { status: string }).status).toBe("documenting");

    // (2) Periodensperre IST trotz offenem Termin geschrieben — der Monat ist zu.
    const closingRes = await db.execute(sql`
      SELECT 1 FROM employee_month_closings
      WHERE user_id = ${employeeId} AND year = ${TARGET_YEAR} AND month = ${TARGET_MONTH}
        AND reopened_at IS NULL
    `);
    expect(closingRes.rows.length).toBe(1);

    // (3) Abschluss protokolliert, KEINE Blockade-/Eskalations-Audits.
    const closedAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM audit_log
      WHERE action = 'month_auto_closed'
        AND entity_type = 'month_closing'
        AND entity_id = ${employeeId}
    `);
    expect(Number((closedAudit.rows?.[0] as { c: number }).c)).toBeGreaterThan(0);

    const blockedAudit = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM audit_log
      WHERE action = 'month_auto_close_blocked'
        AND entity_type = 'month_closing'
        AND entity_id = ${employeeId}
    `);
    expect(Number((blockedAudit.rows?.[0] as { c: number }).c)).toBe(0);
  });
});
