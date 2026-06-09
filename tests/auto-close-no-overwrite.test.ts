/**
 * Task #1119 — Regressionsschutz: Der automatische Monatsabschluss überschreibt
 * KEINEN Termin-Status mehr auf `expired_unsigned`.
 *
 * Die Periodensperre hängt allein an `employee_month_closings`. „Nicht
 * abgerechnet" ist ein abgeleitetes Anzeige-Label und wird zur Laufzeit über
 * `deriveAppointmentDisplayStatus` erzeugt — nie persistiert. Dieser Test
 * stellt sicher, dass ein nicht dokumentiert+unterschriebener Termin nach dem
 * Auto-Close unverändert seinen wahren Lebenszyklus-Status behält und der
 * Monat dennoch geschlossen wird.
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

describe("Task #1119: Auto-Close überschreibt keinen Termin-Status", () => {
  let customerId: number;
  let employeeId: number;
  let appointmentId: number;

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededServiceId();
    const employee = await createTestEmployee();
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    const { appointmentId: aId } = await createAndDocumentAppointment(
      customerId,
      serviceId,
      { assignedEmployeeId: employeeId },
    );
    appointmentId = aId;

    // Termin in den Zielmonat verschieben, dem Mitarbeiter zuordnen und sicher
    // in den Status `documenting` (nicht dokumentiert+unterschrieben) bringen.
    await db.execute(sql`
      UPDATE appointments
      SET date = ${`${TARGET_YEAR}-0${TARGET_MONTH}-15`},
          status = 'documenting',
          signature_data = NULL,
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId}
      WHERE id = ${appointmentId}
    `);
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
  });

  it("schließt den Monat, lässt den Termin-Status aber unangetastet", async () => {
    const cutoff = computeMonthCloseCutoff(TARGET_YEAR, TARGET_MONTH);
    const result = await autoCloseMonthForCutoff(cutoff);

    expect(result.skipped).toBe(false);

    // Termin-Status bleibt der wahre Lebenszyklus-Status — NICHT expired_unsigned.
    const statusRes = await db.execute(sql`SELECT status FROM appointments WHERE id = ${appointmentId}`);
    expect((statusRes.rows?.[0] as { status: string }).status).toBe("documenting");

    // Die Periodensperre wurde gesetzt (employee_month_closings-Zeile existiert).
    const closingRes = await db.execute(sql`
      SELECT 1 FROM employee_month_closings
      WHERE user_id = ${employeeId} AND year = ${TARGET_YEAR} AND month = ${TARGET_MONTH}
    `);
    expect(closingRes.rows.length).toBe(1);
  });
});
