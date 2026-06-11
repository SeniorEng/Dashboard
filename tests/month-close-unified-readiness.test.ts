/**
 * Task #1172 — Monatsabschluss vereinheitlichen.
 *
 * Regressionsschutz: Auto-Close, Admin-Close (Einzel) und Batch-Close teilen
 * EINE Readiness-Definition. Für ein und denselben Mitarbeiter MUSS die
 * Abschluss-Entscheidung in allen drei Pfaden identisch sein:
 *   - Einzel-Readiness  → `getMonthClosingReadiness(userId, year, month)`
 *   - Batch-Readiness    → `getAdminMonthClosingReadiness(year, month)`
 *   - Auto-Close         → `autoCloseMonthForCutoff(cutoff)`
 *
 * Geprüft werden die drei Zustände von Test-MA 114674:
 *   (A) READY            — Aktivität vorhanden, alles dokumentiert+unterschrieben
 *   (B) BLOCKED_UNSIGNED — completed-Termin OHNE Unterschrift (fehlende Signatur)
 *   (C) BLOCKED_OPEN     — offener (nicht abgeschlossener) Termin
 *
 * Policy (Task #1172): Eine fehlende Unterschrift BLOCKIERT den automatischen
 * Abschluss und eskaliert an die Geschäftsführung — identische Entscheidung wie
 * beim manuellen Admin-Close. Der Termin-Status wird dabei NIE überschrieben.
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

async function apptStatus(appointmentId: number): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM appointments WHERE id = ${appointmentId}`);
  return (res.rows?.[0] as { status: string }).status;
}

describe("Task #1172: Einheitliche Readiness — single == batch == auto-close", () => {
  let serviceId: number;

  // (A) READY
  let custReady: number;
  let empReady: number;

  // (B) BLOCKED_UNSIGNED
  let custUnsigned: number;
  let empUnsigned: number;
  let unsignedApptId: number;

  // (C) BLOCKED_OPEN
  let custOpen: number;
  let empOpen: number;
  let openApptId: number;

  beforeAll(async () => {
    serviceId = await getSeededServiceId();

    // (A) READY: Aktivität (completed) + unterschrieben → abschließbar.
    const cA = await createTestCustomer();
    custReady = cA.id as number;
    empReady = (await createTestEmployee({ nachnamePrefix: "U1172Ready" })).id;
    await assignEmployeeToCustomer(custReady, empReady);
    await makeCompletedAppt(custReady, serviceId, empReady, `${TARGET_YEAR}-0${TARGET_MONTH}-10`, true);

    // (B) BLOCKED_UNSIGNED: completed-Termin OHNE Unterschrift.
    const cB = await createTestCustomer();
    custUnsigned = cB.id as number;
    empUnsigned = (await createTestEmployee({ nachnamePrefix: "U1172Unsigned" })).id;
    await assignEmployeeToCustomer(custUnsigned, empUnsigned);
    unsignedApptId = await makeCompletedAppt(custUnsigned, serviceId, empUnsigned, `${TARGET_YEAR}-0${TARGET_MONTH}-11`, false);

    // (C) BLOCKED_OPEN: Aktivität (completed+signiert) + zusätzlich ein offener Termin.
    const cC = await createTestCustomer();
    custOpen = cC.id as number;
    empOpen = (await createTestEmployee({ nachnamePrefix: "U1172Open" })).id;
    await assignEmployeeToCustomer(custOpen, empOpen);
    await makeCompletedAppt(custOpen, serviceId, empOpen, `${TARGET_YEAR}-0${TARGET_MONTH}-12`, true);
    openApptId = await makeOpenAppt(custOpen, serviceId, empOpen, `${TARGET_YEAR}-0${TARGET_MONTH}-13`);
  });

  afterAll(async () => {
    await cleanupCustomer(custReady);
    await cleanupCustomer(custUnsigned);
    await cleanupCustomer(custOpen);
  });

  it("Einzel- und Batch-Readiness stimmen pro Mitarbeiter und Zustand überein", async () => {
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
    expect(adminFor(empReady).ready).toBe(true);
    expect(singleReady.ready).toBe(adminFor(empReady).ready);

    // (B) BLOCKED_UNSIGNED — fehlende Unterschrift blockiert.
    expect(singleUnsigned.ready).toBe(false);
    expect(singleUnsigned.unsignedAppointments.length).toBeGreaterThan(0);
    expect(adminFor(empUnsigned).ready).toBe(false);
    expect(singleUnsigned.ready).toBe(adminFor(empUnsigned).ready);

    // (C) BLOCKED_OPEN — offener Termin blockiert.
    expect(singleOpen.ready).toBe(false);
    expect(singleOpen.openAppointments.length).toBeGreaterThan(0);
    expect(adminFor(empOpen).ready).toBe(false);
    expect(singleOpen.ready).toBe(adminFor(empOpen).ready);
  });

  it("Auto-Close trifft dieselbe Entscheidung wie die Readiness (schließen vs. blockieren+eskalieren)", async () => {
    const cutoff = computeMonthCloseCutoff(TARGET_YEAR, TARGET_MONTH);
    const result = await autoCloseMonthForCutoff(cutoff);
    expect(result.skipped).toBe(false);

    // (A) READY → geschlossen, Audit `month_auto_closed`, NICHT blockiert.
    expect(await hasClosing(empReady)).toBe(true);
    expect(await countAudit("month_auto_closed", empReady)).toBeGreaterThan(0);
    expect(await countAudit("month_auto_close_blocked", empReady)).toBe(0);

    // (B) BLOCKED_UNSIGNED → NICHT geschlossen, eskaliert, Termin-Status unangetastet.
    expect(await hasClosing(empUnsigned)).toBe(false);
    expect(await countAudit("month_auto_close_blocked", empUnsigned)).toBeGreaterThan(0);
    expect(await apptStatus(unsignedApptId)).toBe("completed");

    // (C) BLOCKED_OPEN → NICHT geschlossen, eskaliert, offener Termin unangetastet.
    expect(await hasClosing(empOpen)).toBe(false);
    expect(await countAudit("month_auto_close_blocked", empOpen)).toBeGreaterThan(0);
    expect(await apptStatus(openApptId)).toBe("documenting");
  });
});
