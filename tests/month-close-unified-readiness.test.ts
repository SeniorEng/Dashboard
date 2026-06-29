/**
 * Task #1172 / #1496 — Monatsabschluss vereinheitlichen & bedingungslos machen.
 *
 * Die Readiness-Definition bleibt EINE SSoT: Einzel-Readiness
 * (`getMonthClosingReadiness`) und Batch-Readiness
 * (`getAdminMonthClosingReadiness`) MÜSSEN pro Mitarbeiter identische
 * Informations-Werte (ready/open/unsigned) liefern. Diese Werte sind seit
 * Task #1496 reine Anzeige-Information — sie steuern den Abschluss NICHT mehr.
 *
 * Der Auto-Close (`autoCloseMonthForCutoff`) ist die EINZIGE Abschluss-Mechanik
 * und schließt BEDINGUNGSLOS jeden Mitarbeiter mit Aktivität im Vormonat:
 *   (A) READY            — alles dokumentiert+unterschrieben → geschlossen
 *   (B) DOKU-UNSIGNED    — completed-Termin OHNE Unterschrift → trotzdem
 *                          geschlossen; Termin-Status bleibt `completed`;
 *                          eine „fehlende Unterschrift"-Benachrichtigung entsteht
 *   (C) OFFEN            — offener Termin → trotzdem geschlossen; Termin-Status
 *                          bleibt `documenting` (kein Schreibvorgang)
 *   (D) KEINE AKTIVITÄT  — nichts abzuschließen → NICHT geschlossen
 * Kein Zustand blockiert oder eskaliert mehr.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import { autoCloseMonthForCutoff } from "../server/services/month-close-scheduler";
import { computeMonthCloseCutoff } from "../shared/utils/month-close-cutoff";
import { timeTrackingStorage } from "../server/storage/time-tracking";
import {
  apiPost,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  assignEmployeeToCustomer,
  createAndDocumentAppointment,
} from "./test-utils";

const TARGET_YEAR = 2022;
const TARGET_MONTH = 5;

async function getSeededServiceId(): Promise<number> {
  const res = await db.execute(sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`);
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

/**
 * Erstellt einen completed Termin (über die reale Dokumentations-Route, die
 * `performed_by` auf den dokumentierenden Admin setzt) und korrigiert ihn per
 * SQL auf den Test-Mitarbeiter. `signed=true` setzt eine direkte Unterschrift —
 * exakt das Signal, das die Readiness-SSoT (`signature_data IS NULL`) auswertet.
 */
async function makeCompletedAppt(
  customerId: number,
  serviceId: number,
  employeeId: number,
  date: string,
  signed: boolean,
): Promise<number> {
  const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
    assignedEmployeeId: employeeId,
    date,
  });
  await db.execute(sql`
    UPDATE appointments
    SET performed_by_employee_id = ${employeeId},
        assigned_employee_id = ${employeeId},
        signature_data = ${signed ? "data:image/png;base64,UNIFIED_TEST_SIGNED" : null}
    WHERE id = ${appointmentId}
  `);
  return appointmentId;
}

/** Offener (nicht abgeschlossener) Termin → zählt als „open" in der Readiness. */
async function makeOpenAppt(
  customerId: number,
  serviceId: number,
  employeeId: number,
  date: string,
): Promise<number> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: "08:00",
    services: [{ serviceId, durationMinutes: 60 }],
    assignedEmployeeId: employeeId,
  });
  if (res.status !== 201) {
    throw new Error(`makeOpenAppt failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id as number;
  await db.execute(sql`
    UPDATE appointments
    SET status = 'documenting',
        signature_data = NULL,
        performed_by_employee_id = NULL,
        assigned_employee_id = ${employeeId}
    WHERE id = ${id}
  `);
  return id;
}

async function hasClosing(employeeId: number): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM employee_month_closings
    WHERE user_id = ${employeeId} AND year = ${TARGET_YEAR} AND month = ${TARGET_MONTH}
      AND reopened_at IS NULL
  `);
  return res.rows.length > 0;
}

async function countAudit(action: string, employeeId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM audit_log
    WHERE action = ${action} AND entity_type = 'month_closing' AND entity_id = ${employeeId}
  `);
  return Number((res.rows?.[0] as { c: number })?.c ?? 0);
}

async function countMissingSignatureNotifications(employeeId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM notifications
    WHERE type = 'month_close_missing_signature' AND reference_id = ${employeeId}
  `);
  return Number((res.rows?.[0] as { c: number })?.c ?? 0);
}

async function apptStatus(appointmentId: number): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM appointments WHERE id = ${appointmentId}`);
  return (res.rows?.[0] as { status: string }).status;
}

describe("Task #1172/#1496: Readiness == Anzeige-SSoT, Auto-Close == bedingungslos", () => {
  let serviceId: number;

  // (A) READY
  let custReady: number;
  let empReady: number;

  // (B) DOKU-UNSIGNED
  let custUnsigned: number;
  let empUnsigned: number;
  let unsignedApptId: number;

  // (C) OFFEN
  let custOpen: number;
  let empOpen: number;
  let openApptId: number;

  // (D) KEINE AKTIVITÄT
  let custNoAppt: number;
  let empNoAppt: number;

  beforeAll(async () => {
    serviceId = await getSeededServiceId();

    // (A) READY: Aktivität (completed) + unterschrieben.
    const cA = await createTestCustomer();
    custReady = cA.id as number;
    empReady = (await createTestEmployee({ nachnamePrefix: "U1172Ready" })).id;
    await assignEmployeeToCustomer(custReady, empReady);
    await makeCompletedAppt(custReady, serviceId, empReady, `${TARGET_YEAR}-0${TARGET_MONTH}-10`, true);

    // (B) DOKU-UNSIGNED: completed-Termin OHNE Unterschrift.
    const cB = await createTestCustomer();
    custUnsigned = cB.id as number;
    empUnsigned = (await createTestEmployee({ nachnamePrefix: "U1172Unsigned" })).id;
    await assignEmployeeToCustomer(custUnsigned, empUnsigned);
    unsignedApptId = await makeCompletedAppt(custUnsigned, serviceId, empUnsigned, `${TARGET_YEAR}-0${TARGET_MONTH}-11`, false);

    // (C) OFFEN: Aktivität (completed+signiert) + zusätzlich ein offener Termin.
    const cC = await createTestCustomer();
    custOpen = cC.id as number;
    empOpen = (await createTestEmployee({ nachnamePrefix: "U1172Open" })).id;
    await assignEmployeeToCustomer(custOpen, empOpen);
    await makeCompletedAppt(custOpen, serviceId, empOpen, `${TARGET_YEAR}-0${TARGET_MONTH}-12`, true);
    openApptId = await makeOpenAppt(custOpen, serviceId, empOpen, `${TARGET_YEAR}-0${TARGET_MONTH}-13`);

    // (D) KEINE AKTIVITÄT: zugeordnet, aber ohne Termin im Zielmonat.
    const cD = await createTestCustomer();
    custNoAppt = cD.id as number;
    empNoAppt = (await createTestEmployee({ nachnamePrefix: "U1172NoAppt" })).id;
    await assignEmployeeToCustomer(custNoAppt, empNoAppt);
  });

  afterAll(async () => {
    await cleanupCustomer(custReady);
    await cleanupCustomer(custUnsigned);
    await cleanupCustomer(custOpen);
    await cleanupCustomer(custNoAppt);
  });

  it("Einzel- und Batch-Readiness stimmen pro Mitarbeiter und Zustand überein (Anzeige-SSoT)", async () => {
    const admin = await timeTrackingStorage.getAdminMonthClosingReadiness(TARGET_YEAR, TARGET_MONTH);
    const adminFor = (id: number) => {
      const row = admin.find((e) => e.userId === id);
      if (!row) throw new Error(`Kein Batch-Readiness-Eintrag für Mitarbeiter ${id}`);
      return row;
    };

    const singleReady = await timeTrackingStorage.getMonthClosingReadiness(empReady, TARGET_YEAR, TARGET_MONTH);
    const singleUnsigned = await timeTrackingStorage.getMonthClosingReadiness(empUnsigned, TARGET_YEAR, TARGET_MONTH);
    const singleOpen = await timeTrackingStorage.getMonthClosingReadiness(empOpen, TARGET_YEAR, TARGET_MONTH);

    // (A) READY
    expect(singleReady.ready).toBe(true);
    expect(singleReady.ready).toBe(adminFor(empReady).ready);

    // (B) DOKU-UNSIGNED — fehlende Unterschrift ist sichtbar (Anzeige), blockiert aber nicht mehr.
    expect(singleUnsigned.unsignedAppointments.length).toBeGreaterThan(0);
    expect(singleUnsigned.ready).toBe(adminFor(empUnsigned).ready);
    expect(singleUnsigned.unsignedAppointments).toEqual(adminFor(empUnsigned).unsignedAppointments);

    // (C) OFFEN — offener Termin ist sichtbar (Anzeige).
    expect(singleOpen.openAppointments.length).toBeGreaterThan(0);
    expect(singleOpen.ready).toBe(adminFor(empOpen).ready);
    expect(singleOpen.openAppointments).toEqual(adminFor(empOpen).openAppointments);
  });

  it("Auto-Close schließt bedingungslos jeden Mitarbeiter mit Aktivität (außer ohne Aktivität)", async () => {
    const cutoff = computeMonthCloseCutoff(TARGET_YEAR, TARGET_MONTH);
    const result = await autoCloseMonthForCutoff(cutoff);
    expect(result.skipped).toBe(false);

    // (A) READY → geschlossen, Audit `month_auto_closed`.
    expect(await hasClosing(empReady)).toBe(true);
    expect(await countAudit("month_auto_closed", empReady)).toBeGreaterThan(0);

    // (B) DOKU-UNSIGNED → TROTZDEM geschlossen; Termin-Status bleibt `completed`;
    // eine „fehlende Unterschrift"-Benachrichtigung wird erzeugt.
    expect(await hasClosing(empUnsigned)).toBe(true);
    expect(await apptStatus(unsignedApptId)).toBe("completed");
    expect(await countMissingSignatureNotifications(empUnsigned)).toBeGreaterThan(0);

    // (C) OFFEN → TROTZDEM geschlossen; offener Termin-Status bleibt `documenting`.
    expect(await hasClosing(empOpen)).toBe(true);
    expect(await apptStatus(openApptId)).toBe("documenting");

    // (D) KEINE AKTIVITÄT → NICHT geschlossen (nichts abzuschließen).
    expect(await hasClosing(empNoAppt)).toBe(false);

    // Es gibt keinen Eskalations-/Blockade-Pfad mehr.
    for (const emp of [empReady, empUnsigned, empOpen, empNoAppt]) {
      expect(await countAudit("month_auto_close_blocked", emp)).toBe(0);
    }
  });
});
