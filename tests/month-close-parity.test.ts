/**
 * Task #1283 (Phase 2.1) — Auto-/Admin-Close-Parität + Eskalation.
 *
 * Ergänzt den Readiness-Regressionsschutz aus
 * `tests/month-close-unified-readiness.test.ts` um die noch fehlenden Lücken:
 *   (1) den Zustand „KEIN Termin" (keine Aktivität),
 *   (2) den ECHTEN Admin-Close-Endpoint (`POST /api/time-entries/admin/close-month`)
 *       statt nur der Readiness-Funktion, und
 *   (3) den Eskalations-NACHWEIS über die `notifications`-Tabelle (nicht nur das
 *       Audit-Log).
 *
 * Drei-Zustands-Parität — für ein und denselben Mitarbeiter müssen Auto-Close
 * (`autoCloseMonthForCutoff`) und manueller Admin-Close (Route) zur IDENTISCHEN
 * Entscheidung (abschließbar? ja/nein) und IDENTISCHEN Begründung (Blocker-Liste)
 * kommen, weil beide dieselbe Readiness-SSoT konsumieren:
 *   (A) KEIN Termin          — keine Aktivität → nicht abschließbar, KEINE Eskalation
 *   (B) OFFENER Termin       — offener Termin   → blockiert + eskaliert
 *   (C) COMPLETED-UNSIGNED   — fehlende Signatur → blockiert + eskaliert
 *
 * Eskalation (B/C): Cutoff erreicht, Auto-Close blockiert → Audit
 * `month_auto_close_blocked` UND eine `month_auto_close_blocked`-Benachrichtigung
 * je Admin; der Termin-Status bleibt dabei unangetastet.
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

// Eigener Monat, getrennt von #1172 (2022-05), damit der monatsweite Auto-Close
// der beiden Suiten sich nicht gegenseitig beeinflusst.
const TARGET_YEAR = 2021;
const TARGET_MONTH = 9;
const MM = String(TARGET_MONTH).padStart(2, "0");
const dateOn = (day: number) => `${TARGET_YEAR}-${MM}-${String(day).padStart(2, "0")}`;

async function getSeededServiceId(): Promise<number> {
  const res = await db.execute(sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`);
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

/** completed Termin via reale Doku-Route, danach Korrektur auf den Test-MA. */
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
        signature_data = ${signed ? "data:image/png;base64,PARITY_TEST_SIGNED" : null}
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

/** Eskalations-Benachrichtigungen für den blockierten Mitarbeiter. */
async function countBlockedNotifications(employeeId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM notifications
    WHERE type = 'month_auto_close_blocked' AND reference_id = ${employeeId}
  `);
  return Number((res.rows?.[0] as { c: number })?.c ?? 0);
}

async function apptStatus(appointmentId: number): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM appointments WHERE id = ${appointmentId}`);
  return (res.rows?.[0] as { status: string }).status;
}

async function adminClose(employeeId: number): Promise<{ status: number; data: any }> {
  return apiPost<any>("/api/time-entries/admin/close-month", {
    year: TARGET_YEAR,
    month: TARGET_MONTH,
    userId: employeeId,
  });
}

describe("Task #1283: Auto-Close == Admin-Close Parität + Eskalation", () => {
  let serviceId: number;

  // (A) KEIN Termin
  let custNoAppt: number;
  let empNoAppt: number;

  // (B) OFFENER Termin
  let custOpen: number;
  let empOpen: number;
  let openApptId: number;

  // (C) COMPLETED-UNSIGNED
  let custUnsigned: number;
  let empUnsigned: number;
  let unsignedApptId: number;

  beforeAll(async () => {
    serviceId = await getSeededServiceId();

    // (A) KEIN Termin: Mitarbeiter existiert + ist zugeordnet, aber ohne Aktivität.
    const cA = await createTestCustomer();
    custNoAppt = cA.id as number;
    empNoAppt = (await createTestEmployee({ nachnamePrefix: "P1283NoAppt" })).id;
    await assignEmployeeToCustomer(custNoAppt, empNoAppt);

    // (B) OFFENER Termin: Aktivität (completed+signiert) + zusätzlich ein offener Termin.
    const cB = await createTestCustomer();
    custOpen = cB.id as number;
    empOpen = (await createTestEmployee({ nachnamePrefix: "P1283Open" })).id;
    await assignEmployeeToCustomer(custOpen, empOpen);
    await makeCompletedAppt(custOpen, serviceId, empOpen, dateOn(7), true);
    openApptId = await makeOpenAppt(custOpen, serviceId, empOpen, dateOn(8));

    // (C) COMPLETED-UNSIGNED: completed-Termin OHNE Unterschrift.
    const cC = await createTestCustomer();
    custUnsigned = cC.id as number;
    empUnsigned = (await createTestEmployee({ nachnamePrefix: "P1283Unsigned" })).id;
    await assignEmployeeToCustomer(custUnsigned, empUnsigned);
    unsignedApptId = await makeCompletedAppt(custUnsigned, serviceId, empUnsigned, dateOn(9), false);
  });

  afterAll(async () => {
    await cleanupCustomer(custNoAppt);
    await cleanupCustomer(custOpen);
    await cleanupCustomer(custUnsigned);
  });

  it("Einzel- (Admin-Pfad) und Batch-Readiness (Auto-Pfad) sind pro Zustand deckungsgleich (Entscheidung + Blocker-Liste)", async () => {
    const admin = await timeTrackingStorage.getAdminMonthClosingReadiness(TARGET_YEAR, TARGET_MONTH);
    const adminFor = (id: number) => {
      const row = admin.find((e) => e.userId === id);
      if (!row) throw new Error(`Kein Batch-Readiness-Eintrag für Mitarbeiter ${id}`);
      return row;
    };

    for (const emp of [empNoAppt, empOpen, empUnsigned]) {
      const single = await timeTrackingStorage.getMonthClosingReadiness(emp, TARGET_YEAR, TARGET_MONTH);
      const batch = adminFor(emp);
      // Entscheidung + Begründung müssen byte-gleich sein (eine gemeinsame SSoT).
      expect(single.ready).toBe(batch.ready);
      expect(single.hasTimeEntries).toBe(batch.hasTimeEntries);
      expect(single.openAppointments).toEqual(batch.openAppointments);
      expect(single.unsignedAppointments).toEqual(batch.unsignedAppointments);
      // Kein Zustand ist abschließbar.
      expect(single.ready).toBe(false);
    }

    // Zustands-spezifische Begründung.
    const noAppt = await timeTrackingStorage.getMonthClosingReadiness(empNoAppt, TARGET_YEAR, TARGET_MONTH);
    expect(noAppt.hasTimeEntries).toBe(false);
    expect(noAppt.openAppointments).toHaveLength(0);
    expect(noAppt.unsignedAppointments).toHaveLength(0);

    const open = await timeTrackingStorage.getMonthClosingReadiness(empOpen, TARGET_YEAR, TARGET_MONTH);
    expect(open.hasTimeEntries).toBe(true);
    expect(open.openAppointments.length).toBeGreaterThan(0);

    const unsigned = await timeTrackingStorage.getMonthClosingReadiness(empUnsigned, TARGET_YEAR, TARGET_MONTH);
    expect(unsigned.hasTimeEntries).toBe(true);
    expect(unsigned.unsignedAppointments.length).toBeGreaterThan(0);
  });

  it("Admin-Close-Route lehnt alle drei Zustände mit der jeweiligen Begründung ab", async () => {
    const noAppt = await adminClose(empNoAppt);
    expect(noAppt.status).toBe(400);
    expect(String(noAppt.data?.message ?? "")).toContain("keine Zeiteinträge");

    const open = await adminClose(empOpen);
    expect(open.status).toBe(400);
    expect(String(open.data?.message ?? "")).toContain("offene(r) Termin");

    const unsigned = await adminClose(empUnsigned);
    expect(unsigned.status).toBe(400);
    expect(String(unsigned.data?.message ?? "")).toContain("ohne Unterschrift");

    // Keine der drei Ablehnungen darf einen Abschluss erzeugt haben.
    expect(await hasClosing(empNoAppt)).toBe(false);
    expect(await hasClosing(empOpen)).toBe(false);
    expect(await hasClosing(empUnsigned)).toBe(false);
  });

  it("Auto-Close trifft dieselbe Entscheidung wie der Admin-Close und eskaliert blockierte Mitarbeiter", async () => {
    const cutoff = computeMonthCloseCutoff(TARGET_YEAR, TARGET_MONTH);
    const result = await autoCloseMonthForCutoff(cutoff);
    expect(result.skipped).toBe(false);

    // (A) KEIN Termin → wie der Admin-Close NICHT abgeschlossen; mangels Aktivität
    // gibt es nichts zu eskalieren (keine Blockade-Audits/-Notifications).
    expect(await hasClosing(empNoAppt)).toBe(false);
    expect(await countAudit("month_auto_close_blocked", empNoAppt)).toBe(0);
    expect(await countBlockedNotifications(empNoAppt)).toBe(0);

    // (B) OFFENER Termin → blockiert + eskaliert; offener Termin unangetastet.
    expect(await hasClosing(empOpen)).toBe(false);
    expect(await countAudit("month_auto_close_blocked", empOpen)).toBeGreaterThan(0);
    expect(await countBlockedNotifications(empOpen)).toBeGreaterThan(0);
    expect(await apptStatus(openApptId)).toBe("documenting");

    // (C) COMPLETED-UNSIGNED → blockiert + eskaliert; Termin-Status NICHT überschrieben.
    expect(await hasClosing(empUnsigned)).toBe(false);
    expect(await countAudit("month_auto_close_blocked", empUnsigned)).toBeGreaterThan(0);
    expect(await countBlockedNotifications(empUnsigned)).toBeGreaterThan(0);
    expect(await apptStatus(unsignedApptId)).toBe("completed");
  });
});
