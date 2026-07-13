import { eq, and, gte, lte, inArray, isNull, asc, notInArray, count, sql as sqlBuilder } from "drizzle-orm";
import {
  appointments,
  customers,
  employeeMonthClosings,
  employeeTimeEntries,
  users,
} from "@shared/schema";
import { db, type DbOrTx } from "../../lib/db";
import { FINAL_APPOINTMENT_STATUSES } from "@shared/domain/appointments";
import {
  employeeMonthClosingResponsibilityFilter,
  employeesMonthClosingResponsibilityFilter,
  monthClosingResponsibilityCoalesce,
} from "../appointment-helpers";
import { appointmentCompletedButUnsignedCondition, completedButUnsignedSqlRaw } from "../../lib/appointment-signed";
import { monthDateRange } from "./shared";
import { appointmentsRepo, employeeTimeEntriesRepo } from "../../repos";

export async function isMonthClosed(userId: number, dateStr: string): Promise<boolean> {
  const [yearStr, monthStr] = dateStr.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const closing = await db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.userId, userId),
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month),
      ),
    )
    .limit(1);
  return closing.length > 0 && !closing[0].reopenedAt;
}

export async function getMonthClosingReadiness(userId: number, year: number, month: number) {
  const { startDate, endDate } = monthDateRange(year, month);
  const employeeFilter = employeeMonthClosingResponsibilityFilter(userId);

  const openAppointments = await appointmentsRepo.selectColumnsFrom({
      id: appointments.id,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      status: appointments.status,
      customerId: appointments.customerId,
      customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
    }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        employeeFilter,
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        notInArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]),
      ),
    )
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  const unsignedAppointments = await appointmentsRepo.selectColumnsFrom({
      id: appointments.id,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      status: appointments.status,
      customerId: appointments.customerId,
      customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
    }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        employeeFilter,
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        appointmentCompletedButUnsignedCondition(),
      ),
    )
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  const timeEntryCount = await employeeTimeEntriesRepo.selectColumnsFrom({ count: count() }, db)
    .where(
      and(
        eq(employeeTimeEntries.userId, userId),
        gte(employeeTimeEntries.entryDate, startDate),
        lte(employeeTimeEntries.entryDate, endDate),
        isNull(employeeTimeEntries.deletedAt),
      ),
    );

  const completedAppointmentCount = await appointmentsRepo.selectColumnsFrom({ count: count() }, db)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        employeeFilter,
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
        inArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]),
      ),
    );

  const timeEntries = Number(timeEntryCount[0]?.count ?? 0);
  const completedAppts = Number(completedAppointmentCount[0]?.count ?? 0);
  const hasActivity = timeEntries > 0 || completedAppts > 0;

  const mapAppointment = (a: { id: number; date: string; scheduledStart: string | null; status: string; customerName: unknown }) => ({
    id: a.id,
    date: a.date,
    scheduledStart: a.scheduledStart,
    status: a.status,
    customerName: String(a.customerName ?? "Unbekannt"),
  });

  return {
    ready: openAppointments.length === 0 && unsignedAppointments.length === 0 && hasActivity,
    openAppointments: openAppointments.map(mapAppointment),
    unsignedAppointments: unsignedAppointments.map(mapAppointment),
    hasTimeEntries: hasActivity,
    timeEntryCount: timeEntries + completedAppts,
  };
}

export async function getAdminMonthClosingReadiness(year: number, month: number) {
  const { startDate, endDate } = monthDateRange(year, month);

  const activeEmployees = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.isAdmin, false)));

  if (activeEmployees.length === 0) return [];

  const employeeIds = activeEmployees.map(e => e.id);

  const responsibilityMembership = employeesMonthClosingResponsibilityFilter(employeeIds);

  const [allOpenAppts, allUnsignedAppts, allTimeEntryCounts, allCompletedCounts, allClosings] = await Promise.all([
    appointmentsRepo.selectColumnsFrom({
        employeeId: monthClosingResponsibilityCoalesce().as('employee_id'),
        id: appointments.id,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        status: appointments.status,
        customerId: appointments.customerId,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      }, db)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          notInArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]),
          responsibilityMembership,
        ),
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart)),

    appointmentsRepo.selectColumnsFrom({
        employeeId: monthClosingResponsibilityCoalesce().as('employee_id'),
        id: appointments.id,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        status: appointments.status,
        customerId: appointments.customerId,
        customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name})`.as('customer_name'),
      }, db)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          appointmentCompletedButUnsignedCondition(),
          responsibilityMembership,
        ),
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart)),

    employeeTimeEntriesRepo.selectColumnsFrom({
        userId: employeeTimeEntries.userId,
        count: count(),
      }, db)
      .where(
        and(
          inArray(employeeTimeEntries.userId, employeeIds),
          gte(employeeTimeEntries.entryDate, startDate),
          lte(employeeTimeEntries.entryDate, endDate),
          isNull(employeeTimeEntries.deletedAt),
        ),
      )
      .groupBy(employeeTimeEntries.userId),

    appointmentsRepo.selectColumnsFrom({
        employeeId: monthClosingResponsibilityCoalesce().as('employee_id'),
        count: count(),
      }, db)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          inArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]),
          responsibilityMembership,
        ),
      )
      .groupBy(monthClosingResponsibilityCoalesce()),

    db
      .select()
      .from(employeeMonthClosings)
      .where(
        and(
          eq(employeeMonthClosings.year, year),
          eq(employeeMonthClosings.month, month),
          inArray(employeeMonthClosings.userId, employeeIds),
        ),
      ),
  ]);

  const mapAppointment = (a: { id: number; date: string; scheduledStart: string | null; status: string; customerName: unknown }) => ({
    id: a.id,
    date: a.date,
    scheduledStart: a.scheduledStart,
    status: a.status,
    customerName: String(a.customerName ?? "Unbekannt"),
  });

  const openByEmployee = new Map<number, typeof allOpenAppts>();
  for (const appt of allOpenAppts) {
    const empId = Number(appt.employeeId);
    if (!openByEmployee.has(empId)) openByEmployee.set(empId, []);
    openByEmployee.get(empId)!.push(appt);
  }

  const unsignedByEmployee = new Map<number, typeof allUnsignedAppts>();
  for (const appt of allUnsignedAppts) {
    const empId = Number(appt.employeeId);
    if (!unsignedByEmployee.has(empId)) unsignedByEmployee.set(empId, []);
    unsignedByEmployee.get(empId)!.push(appt);
  }

  const timeEntryCountMap = new Map(allTimeEntryCounts.map(r => [r.userId, Number(r.count)]));
  const completedCountMap = new Map(allCompletedCounts.map(r => [Number(r.employeeId), Number(r.count)]));
  const closingMap = new Map(allClosings.map(c => [c.userId, c]));

  return activeEmployees.map(emp => {
    const openAppts = openByEmployee.get(emp.id) ?? [];
    const unsignedAppts = unsignedByEmployee.get(emp.id) ?? [];
    const timeEntries = timeEntryCountMap.get(emp.id) ?? 0;
    const completedAppts = completedCountMap.get(emp.id) ?? 0;
    const hasActivity = timeEntries > 0 || completedAppts > 0;
    const closing = closingMap.get(emp.id);
    const isClosed = !!(closing && !closing.reopenedAt);

    return {
      userId: emp.id,
      displayName: emp.displayName,
      isClosed,
      closingId: closing?.id ?? null,
      ready: openAppts.length === 0 && unsignedAppts.length === 0 && hasActivity,
      openAppointments: openAppts.map(mapAppointment),
      unsignedAppointments: unsignedAppts.map(mapAppointment),
      hasTimeEntries: hasActivity,
      timeEntryCount: timeEntries + completedAppts,
    };
  });
}

/**
 * Task #1496 — Aktive Liste „fehlende Unterschriften nach Abschluss".
 *
 * Liefert alle DOKUMENTIERTEN (status = 'completed'), aber noch NICHT
 * unterschriebenen Termine, deren zuständiger Monat bereits ABGESCHLOSSEN ist
 * (`employee_month_closings` ohne `reopened_at`). Rein abgeleitet aus der
 * bestehenden „Dokumentiert"-Stufe, gefiltert auf geschlossene Monate — kein
 * neues Datenmodell, kein neuer Status. Ein Eintrag verschwindet automatisch,
 * sobald der Termin unterschrieben ist (direkt oder via Leistungsnachweis),
 * weil dann `completedButUnsignedSqlRaw` nicht mehr greift.
 *
 * Die Monats-Zuständigkeit folgt exakt derselben SSoT wie Readiness/Reminder:
 * `COALESCE(performed_by, assigned, primary_employee)`.
 */
export async function getMissingSignaturesInClosedMonths(): Promise<
  Array<{
    id: number;
    date: string;
    scheduledStart: string | null;
    customerName: string;
    employeeName: string;
    year: number;
    month: number;
  }>
> {
  const result = await db.execute(sqlBuilder`
    SELECT
      a.id AS id,
      a.date AS date,
      a.scheduled_start AS scheduled_start,
      COALESCE(c.vorname || ' ' || c.nachname, c.name) AS customer_name,
      resp.display_name AS employee_name,
      EXTRACT(YEAR FROM a.date)::int AS year,
      EXTRACT(MONTH FROM a.date)::int AS month
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    JOIN users resp
      ON resp.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id, c.primary_employee_id)
    JOIN employee_month_closings emc
      ON emc.user_id = resp.id
     AND emc.year = EXTRACT(YEAR FROM a.date)::int
     AND emc.month = EXTRACT(MONTH FROM a.date)::int
     AND emc.reopened_at IS NULL
    WHERE a.deleted_at IS NULL
      AND ${completedButUnsignedSqlRaw("a")}
    ORDER BY a.date DESC, a.scheduled_start ASC
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    date: String(r.date),
    scheduledStart: r.scheduled_start === null || r.scheduled_start === undefined ? null : String(r.scheduled_start),
    customerName: String(r.customer_name ?? "Unbekannt"),
    employeeName: String(r.employee_name ?? "Unbekannt"),
    year: Number(r.year),
    month: Number(r.month),
  }));
}

export async function getMonthClosing(userId: number, year: number, month: number) {
  const rows = await db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.userId, userId),
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month),
      ),
    )
    .limit(1);
  return rows[0] || null;
}

export async function getAdminMonthClosings(year: number, month: number) {
  return db
    .select()
    .from(employeeMonthClosings)
    .where(
      and(
        eq(employeeMonthClosings.year, year),
        eq(employeeMonthClosings.month, month),
      ),
    );
}

export async function closeMonth(
  userId: number,
  year: number,
  month: number,
  closedByUserId: number,
  existingId?: number,
  txOrDb: DbOrTx = db,
) {
  if (existingId) {
    await txOrDb
      .update(employeeMonthClosings)
      .set({
        closedAt: new Date(),
        closedByUserId,
        reopenedAt: null,
        reopenedByUserId: null,
      })
      .where(eq(employeeMonthClosings.id, existingId));
  } else {
    await txOrDb.insert(employeeMonthClosings).values({
      userId,
      year,
      month,
      closedByUserId,
    });
  }
}
