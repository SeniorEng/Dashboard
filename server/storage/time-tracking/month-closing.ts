import { eq, and, gte, lte, inArray, isNull, or, asc, notInArray, count, sql as sqlBuilder } from "drizzle-orm";
import {
  appointments,
  customers,
  employeeMonthClosings,
  employeeTimeEntries,
  users,
} from "@shared/schema";
import { db, type DbOrTx } from "../../lib/db";
import { employeeVisibleAppointmentsFilter } from "../appointment-helpers";
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
  const employeeFilter = employeeVisibleAppointmentsFilter(userId);

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
        notInArray(appointments.status, ["completed", "cancelled", "customer_no_show"]),
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
        eq(appointments.status, "completed"),
        isNull(appointments.signatureData),
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
        inArray(appointments.status, ["completed", "cancelled", "customer_no_show"]),
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

  const [allOpenAppts, allUnsignedAppts, allTimeEntryCounts, allCompletedCounts, allClosings] = await Promise.all([
    appointmentsRepo.selectColumnsFrom({
        employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
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
          notInArray(appointments.status, ["completed", "cancelled", "customer_no_show"]),
          or(
            inArray(appointments.assignedEmployeeId, employeeIds),
            and(
              isNull(appointments.assignedEmployeeId),
              or(
                inArray(customers.primaryEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId2, employeeIds),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart)),

    appointmentsRepo.selectColumnsFrom({
        employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
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
          eq(appointments.status, "completed"),
          isNull(appointments.signatureData),
          or(
            inArray(appointments.assignedEmployeeId, employeeIds),
            and(
              isNull(appointments.assignedEmployeeId),
              or(
                inArray(customers.primaryEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId2, employeeIds),
              ),
            ),
          ),
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
        employeeId: sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`.as('employee_id'),
        count: count(),
      }, db)
      .innerJoin(customers, eq(appointments.customerId, customers.id))
      .where(
        and(
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          isNull(appointments.deletedAt),
          inArray(appointments.status, ["completed", "cancelled", "customer_no_show"]),
          or(
            inArray(appointments.assignedEmployeeId, employeeIds),
            and(
              isNull(appointments.assignedEmployeeId),
              or(
                inArray(customers.primaryEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId, employeeIds),
                inArray(customers.backupEmployeeId2, employeeIds),
              ),
            ),
          ),
        ),
      )
      .groupBy(sqlBuilder`COALESCE(${appointments.assignedEmployeeId}, ${customers.primaryEmployeeId})`),

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

export async function reopenMonth(closingId: number, reopenedByUserId: number) {
  await db
    .update(employeeMonthClosings)
    .set({
      reopenedAt: new Date(),
      reopenedByUserId,
    })
    .where(eq(employeeMonthClosings.id, closingId));
}
