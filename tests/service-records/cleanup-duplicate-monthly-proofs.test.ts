/**
 * Task #1527 — Integrationstest für die Bereinigung bereits in Produktion
 * entstandener doppelter monatlicher Leistungsnachweise
 * (`cleanupDuplicateMonthlyProofs`).
 *
 * Task #1526 stoppte die NEU-Entstehung doppelter pending monatlicher LNs.
 * Dieses Skript räumt die historischen Duplikate auf: pro (customerId,
 * employeeId, year, month) mit >1 pending monatlichem LN bleibt der LN mit der
 * kleinsten id (Keeper) erhalten und sammelt alle Termin-Verknüpfungen ein; die
 * übrigen pending-Zeilen werden soft-gelöscht. GoBD-versiegelte LNs
 * (`employee_signed`/`completed`) werden NIEMALS angefasst.
 *
 * Verifiziert:
 *   1. Trockenlauf (`apply:false`) findet die Duplikat-Gruppe und schreibt
 *      NICHTS (kein Soft-Delete, kein Audit, keine Termin-Übernahme).
 *   2. Scharflauf (`apply:true`) übernimmt die Termine des Duplikats in den
 *      Keeper, soft-löscht das Duplikat, schreibt einen
 *      `service_record_deleted`-Audit-Eintrag und meldet 0 verbleibende
 *      Duplikat-Gruppen.
 *   3. Ein versiegelter (`completed`) LN derselben Periode bleibt unangetastet.
 *   4. Idempotenz: ein zweiter Scharflauf ist ein No-Op.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  monthlyServiceRecords,
  serviceRecordAppointments,
  auditLog,
  users,
} from "@shared/schema";
import {
  cleanupDuplicateMonthlyProofs,
  findDuplicatePendingGroups,
  mergeDuplicateGroup,
} from "../../server/scripts/cleanup-duplicate-monthly-proofs";
import {
  apiGet,
  apiPost,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 3;
const APPT_DATE = `${YEAR}-0${MONTH}-12`;
const APPT_DATE_2 = `${YEAR}-0${MONTH}-19`;

describe("cleanupDuplicateMonthlyProofs — historische Duplikate bereinigen", () => {
  let customerId: number;
  let employeeId: number;
  let serviceId: number;
  let superadminId: number;

  let keeperId: number;
  let duplicateId: number;
  let sealedId: number;
  let appt1: number;
  let appt2: number;

  async function createAppt(date: string, scheduledStart: string, scheduledEnd: string): Promise<number> {
    const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date,
      scheduledStart,
      scheduledEnd,
      notes: `Dup-LN-Cleanup-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId, durationMinutes: 30 }],
    });
    expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
    return res.data.id;
  }

  async function insertPendingMonthly(): Promise<number> {
    const [row] = await db
      .insert(monthlyServiceRecords)
      .values({
        customerId,
        employeeId,
        year: YEAR,
        month: MONTH,
        recordType: "monthly",
        status: "pending",
      })
      .returning({ id: monthlyServiceRecords.id });
    return row.id;
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isSuperAdmin, true)).limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const emp = await createTestEmployee({ nachnamePrefix: "DupLnCleanup" });
    employeeId = emp.id;

    const customer = await createTestCustomer({ assignedEmployeeId: employeeId });
    customerId = customer.id as number;

    const list = await apiGet<Array<{ id: number }>>("/api/services");
    serviceId = list.data[0].id;

    appt1 = await createAppt(APPT_DATE, "09:00", "09:30");
    appt2 = await createAppt(APPT_DATE_2, "09:00", "09:30");

    // Zwei pending monatliche LNs derselben Periode (das Duplikat-Szenario).
    keeperId = await insertPendingMonthly();
    duplicateId = await insertPendingMonthly();
    expect(duplicateId).toBeGreaterThan(keeperId);

    // appt1 hängt am Keeper, appt2 am Duplikat → muss übernommen werden.
    await db.insert(serviceRecordAppointments).values({ serviceRecordId: keeperId, appointmentId: appt1 });
    await db.insert(serviceRecordAppointments).values({ serviceRecordId: duplicateId, appointmentId: appt2 });

    // Ein versiegelter (completed) LN derselben Periode — darf NIE angefasst werden.
    const [sealed] = await db
      .insert(monthlyServiceRecords)
      .values({
        customerId,
        employeeId,
        year: YEAR,
        month: MONTH,
        recordType: "monthly",
        status: "completed",
      })
      .returning({ id: monthlyServiceRecords.id });
    sealedId = sealed.id;
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
  });

  it("Trockenlauf findet die Gruppe und schreibt nichts", async () => {
    const before = await cleanupDuplicateMonthlyProofs({ apply: false, customerIds: [customerId] });
    expect(before.groupsFound).toBe(1);
    expect(before.duplicatesFound).toBe(1);
    expect(before.softDeletedDuplicates).toBe(0);
    expect(before.findings[0].group.keeperId).toBe(keeperId);
    expect(before.findings[0].group.duplicateIds).toEqual([duplicateId]);
    expect(before.findings[0].movedAppointmentIdsByDuplicate[duplicateId]).toEqual([appt2]);

    // Nichts mutiert: Duplikat lebt, kein Audit.
    const [dup] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, duplicateId));
    expect(dup.deletedAt).toBeNull();
  });

  it("Scharflauf mergt Termine, soft-löscht das Duplikat und auditiert", async () => {
    const res = await cleanupDuplicateMonthlyProofs({
      apply: true,
      customerIds: [customerId],
      userId: superadminId,
      reason: "Task #1527 — historische Duplikate bereinigen (Test)",
    });
    expect(res.mergedGroups).toBe(1);
    expect(res.softDeletedDuplicates).toBe(1);
    expect(res.remainingGroups).toBe(0);

    // Keeper hat jetzt beide Termine.
    const keeperAppts = await db
      .select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, keeperId));
    expect(keeperAppts.map((r) => r.appointmentId).sort()).toEqual([appt1, appt2].sort());

    // Keeper lebt, Duplikat ist soft-gelöscht.
    const [keeper] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt, status: monthlyServiceRecords.status })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, keeperId));
    expect(keeper.deletedAt).toBeNull();
    expect(keeper.status).toBe("pending");

    const [dup] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, duplicateId));
    expect(dup.deletedAt).not.toBeNull();

    // Audit-Eintrag für die Lösch-Operation.
    const audits = await db
      .select({ userId: auditLog.userId, action: auditLog.action, entityId: auditLog.entityId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "service_record"), eq(auditLog.entityId, duplicateId)));
    const del = audits.find((a) => a.action === "service_record_deleted");
    expect(del, "service_record_deleted audit").toBeTruthy();
    expect(del!.userId).toBe(superadminId);
    expect((del!.metadata as Record<string, unknown>).mergedIntoServiceRecordId).toBe(keeperId);
  });

  it("lässt versiegelte (completed) LNs unangetastet", async () => {
    const [sealed] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt, status: monthlyServiceRecords.status })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, sealedId));
    expect(sealed.deletedAt).toBeNull();
    expect(sealed.status).toBe("completed");
  });

  it("ist idempotent (zweiter Scharflauf = No-Op)", async () => {
    const groups = await findDuplicatePendingGroups([customerId]);
    expect(groups).toHaveLength(0);

    const res = await cleanupDuplicateMonthlyProofs({
      apply: true,
      customerIds: [customerId],
      userId: superadminId,
      reason: "Task #1527 — Re-Run No-Op (Test)",
    });
    expect(res.groupsFound).toBe(0);
    expect(res.softDeletedDuplicates).toBe(0);
    expect(res.remainingGroups).toBe(0);
  });
});

/**
 * Race-Sicherheit: ein zwischen Erkennung und Mutation versiegeltes
 * (employee_signed/completed) LN darf NIEMALS gemergt/gelöscht werden und
 * erzeugt KEINEN Audit-Eintrag (Reviewer-Anforderung Task #1527).
 */
describe("mergeDuplicateGroup — Race-sichere Re-Verifikation unter Lock", () => {
  let customerId: number;
  let employeeId: number;
  let superadminId: number;

  async function insertMonthly(status: "pending" | "completed"): Promise<number> {
    const [row] = await db
      .insert(monthlyServiceRecords)
      .values({ customerId, employeeId, year: YEAR, month: MONTH, recordType: "monthly", status })
      .returning({ id: monthlyServiceRecords.id });
    return row.id;
  }

  function groupOf(keeperId: number, duplicateIds: number[]) {
    return { customerId, employeeId, year: YEAR, month: MONTH, keeperId, duplicateIds };
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isSuperAdmin, true)).limit(1);
    superadminId = admin?.id ?? auth.user.id;
    const emp = await createTestEmployee({ nachnamePrefix: "DupLnRace" });
    employeeId = emp.id;
    const customer = await createTestCustomer({ assignedEmployeeId: employeeId });
    customerId = customer.id as number;
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
  });

  it("überspringt ein versiegeltes Duplikat ohne Audit oder Soft-Delete", async () => {
    const keeperId = await insertMonthly("pending");
    const sealedDupId = await insertMonthly("completed"); // simuliert: dup wurde versiegelt

    const res = await mergeDuplicateGroup(groupOf(keeperId, [sealedDupId]), {
      userId: superadminId,
      reason: "Task #1527 — Race-Skip versiegeltes Duplikat (Test)",
    });
    expect(res.skippedGroup).toBe(false);
    expect(res.deletedInGroup).toBe(0);
    expect(res.skippedDupsInGroup).toBe(1);

    // Versiegeltes Duplikat unangetastet.
    const [dup] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt, status: monthlyServiceRecords.status })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, sealedDupId));
    expect(dup.deletedAt).toBeNull();
    expect(dup.status).toBe("completed");

    // KEIN Audit-Eintrag für das versiegelte Duplikat.
    const audits = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "service_record"), eq(auditLog.entityId, sealedDupId)));
    expect(audits).toHaveLength(0);
  });

  it("lässt die ganze Gruppe unangetastet, wenn der Keeper versiegelt ist", async () => {
    const sealedKeeperId = await insertMonthly("completed");
    const pendingDupId = await insertMonthly("pending");

    const res = await mergeDuplicateGroup(groupOf(sealedKeeperId, [pendingDupId]), {
      userId: superadminId,
      reason: "Task #1527 — Race-Skip versiegelter Keeper (Test)",
    });
    expect(res.skippedGroup).toBe(true);
    expect(res.deletedInGroup).toBe(0);

    // Das pending-Duplikat wurde NICHT gelöscht (nichts darf in einen
    // versiegelten Keeper gemergt werden).
    const [dup] = await db
      .select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, pendingDupId));
    expect(dup.deletedAt).toBeNull();

    const audits = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "service_record"), eq(auditLog.entityId, pendingDupId)));
    expect(audits).toHaveLength(0);
  });
});
