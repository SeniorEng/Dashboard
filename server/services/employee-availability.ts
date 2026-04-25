import {
  users,
  appointments,
  customers,
  prospects,
  employeeTimeEntries,
} from "@shared/schema";
import { timeToMinutes, addDays as addDaysShared, minutesToTimeDisplay } from "@shared/utils/datetime";
import { db } from "../lib/db";
import { eq, and, isNull, inArray, sql, asc } from "drizzle-orm";

function minutesToHHMM(mins: number): string {
  return minutesToTimeDisplay(((mins % 1440) + 1440) % 1440);
}

function computeFreeSlots(
  availability: { startTime: string | null; endTime: string | null }[],
  blockedSlots: { start: number; end: number }[]
): { start: string; end: string }[] {
  if (availability.length === 0) return [];

  const freeSlots: { start: string; end: string }[] = [];

  for (const slot of availability) {
    if (!slot.startTime || !slot.endTime) continue;
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);

    const relevantBlocks = blockedSlots
      .filter((b) => b.start < slotEnd && b.end > slotStart)
      .sort((a, b) => a.start - b.start);

    let cursor = slotStart;
    for (const block of relevantBlocks) {
      if (block.start > cursor) {
        freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(block.start) });
      }
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < slotEnd) {
      freeSlots.push({ start: minutesToHHMM(cursor), end: minutesToHHMM(slotEnd) });
    }
  }

  return freeSlots;
}

function collectBlockedSlots(
  dayAppointments: { scheduledStart: string | null; scheduledEnd: string | null; durationMinutes: number | null }[],
  dayTimeEntries: { startTime: string | null; endTime: string | null }[],
  dayBlockers: { startTime: string | null; endTime: string | null }[],
): { start: number; end: number }[] {
  const blockedSlots: { start: number; end: number }[] = [];
  for (const appt of dayAppointments) {
    if (appt.scheduledStart) {
      const s = timeToMinutes(appt.scheduledStart);
      const e = appt.scheduledEnd ? timeToMinutes(appt.scheduledEnd) : s + (appt.durationMinutes || 60);
      blockedSlots.push({ start: s, end: e });
    }
  }
  for (const te of dayTimeEntries) {
    if (te.startTime && te.endTime) {
      blockedSlots.push({
        start: timeToMinutes(te.startTime.slice(0, 5)),
        end: timeToMinutes(te.endTime.slice(0, 5)),
      });
    }
  }
  for (const blocker of dayBlockers) {
    if (blocker.startTime && blocker.endTime) {
      blockedSlots.push({
        start: timeToMinutes(blocker.startTime.slice(0, 5)),
        end: timeToMinutes(blocker.endTime.slice(0, 5)),
      });
    }
  }
  return blockedSlots;
}

export function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function buildDateRange(startDate: string, days: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(addDaysShared(startDate, i));
  }
  return dates;
}

export type WeeklyAvailabilityDay = {
  availability: { startTime: string | null; endTime: string | null }[];
  appointments: {
    appointmentId: number;
    customerId: number | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    durationMinutes: number | null;
    customerName: string;
    status: string;
  }[];
  absence: "urlaub" | "krankheit" | null;
  blockers: "fullday" | { startTime: string; endTime: string }[] | null;
  freeSlots: { start: string; end: string }[];
};

export type WeeklyAvailabilityEmployee = {
  id: number;
  displayName: string;
  days: Record<string, WeeklyAvailabilityDay>;
};

export type WeeklyAvailabilityResponse = {
  dates: string[];
  employees: WeeklyAvailabilityEmployee[];
};

/**
 * Liefert die Wochen-Verfügbarkeit für die gegebenen Mitarbeiter über die
 * angegebenen Tage. Beinhaltet Verfügbarkeit, Termine, Abwesenheiten,
 * Zeiterfassungseinträge und Blocker.
 */
export async function loadEmployeesWeeklyAvailability(
  employeeIds: number[],
  dates: string[],
): Promise<WeeklyAvailabilityResponse> {
  if (employeeIds.length === 0 || dates.length === 0) {
    return { dates, employees: [] };
  }

  const [employeeData, availabilityEntries, absenceEntries, rangeAppointments, timeEntries, blockerEntries] = await Promise.all([
    db.select({
      id: users.id,
      displayName: users.displayName,
      vorname: users.vorname,
      nachname: users.nachname,
    })
      .from(users)
      .where(and(inArray(users.id, employeeIds), eq(users.isActive, true)))
      .orderBy(asc(users.displayName)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
    })
      .from(employeeTimeEntries)
      .where(and(
        inArray(employeeTimeEntries.userId, employeeIds),
        inArray(employeeTimeEntries.entryDate, dates),
        eq(employeeTimeEntries.entryType, "verfuegbar"),
        isNull(employeeTimeEntries.deletedAt),
      ))
      .orderBy(asc(employeeTimeEntries.startTime)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      entryType: employeeTimeEntries.entryType,
    })
      .from(employeeTimeEntries)
      .where(and(
        inArray(employeeTimeEntries.userId, employeeIds),
        inArray(employeeTimeEntries.entryDate, dates),
        inArray(employeeTimeEntries.entryType, ["urlaub", "krankheit"]),
        isNull(employeeTimeEntries.deletedAt),
      )),

    db.select({
      appointmentId: appointments.id,
      customerId: appointments.customerId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      durationPromised: appointments.durationPromised,
      customerName: sql`COALESCE(
        ${customers.vorname} || ' ' || ${customers.nachname},
        ${customers.name},
        ${prospects.vorname} || ' ' || ${prospects.nachname},
        'Erstberatung'
      )`.as("customer_name"),
      status: appointments.status,
    })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
      .where(and(
        inArray(appointments.assignedEmployeeId, employeeIds),
        inArray(appointments.date, dates),
        isNull(appointments.deletedAt),
        sql`${appointments.status} != 'cancelled'`,
      ))
      .orderBy(asc(appointments.scheduledStart)),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
      entryType: employeeTimeEntries.entryType,
    })
      .from(employeeTimeEntries)
      .where(and(
        inArray(employeeTimeEntries.userId, employeeIds),
        inArray(employeeTimeEntries.entryDate, dates),
        inArray(employeeTimeEntries.entryType, ["arbeitszeit", "pause", "fahrt"]),
        isNull(employeeTimeEntries.deletedAt),
      )),

    db.select({
      userId: employeeTimeEntries.userId,
      entryDate: employeeTimeEntries.entryDate,
      startTime: employeeTimeEntries.startTime,
      endTime: employeeTimeEntries.endTime,
      isFullDay: employeeTimeEntries.isFullDay,
    })
      .from(employeeTimeEntries)
      .where(and(
        inArray(employeeTimeEntries.userId, employeeIds),
        inArray(employeeTimeEntries.entryDate, dates),
        eq(employeeTimeEntries.entryType, "blocker"),
        isNull(employeeTimeEntries.deletedAt),
      ))
      .orderBy(asc(employeeTimeEntries.startTime)),
  ]);

  const result: WeeklyAvailabilityEmployee[] = employeeData.map((emp) => {
    const empName = emp.displayName || `${emp.vorname || ""} ${emp.nachname || ""}`.trim();
    const daysData: Record<string, WeeklyAvailabilityDay> = {};

    for (const date of dates) {
      const dayAvail = availabilityEntries
        .filter((a) => a.userId === emp.id && a.entryDate === date)
        .map((a) => ({
          startTime: a.startTime?.slice(0, 5) || null,
          endTime: a.endTime?.slice(0, 5) || null,
        }));

      const dayAppointments = rangeAppointments
        .filter((a) => a.assignedEmployeeId === emp.id && a.date === date)
        .map((a) => {
          const start = a.scheduledStart?.slice(0, 5) || null;
          let end = a.scheduledEnd?.slice(0, 5) || null;
          if (!end && start && a.durationPromised) {
            end = minutesToHHMM(timeToMinutes(start) + a.durationPromised);
          }
          return {
            appointmentId: a.appointmentId,
            customerId: a.customerId,
            scheduledStart: start,
            scheduledEnd: end,
            durationMinutes: a.durationPromised,
            customerName: String(a.customerName),
            status: a.status as string,
          };
        });

      const dayTimeEntries = timeEntries
        .filter((t) => t.userId === emp.id && t.entryDate === date && t.startTime && t.endTime);

      const dayBlockers = blockerEntries
        .filter((b) => b.userId === emp.id && b.entryDate === date);

      const absence = absenceEntries.find((a) => a.userId === emp.id && a.entryDate === date);

      const hasFullDayBlocker = dayBlockers.some((b) => b.isFullDay);

      const blockedSlots = collectBlockedSlots(dayAppointments, dayTimeEntries, dayBlockers);

      const freeSlots = (absence || hasFullDayBlocker) ? [] : computeFreeSlots(dayAvail, blockedSlots);

      const blockerSlots = dayBlockers
        .filter((b) => b.startTime && b.endTime && !b.isFullDay)
        .map((b) => ({
          startTime: b.startTime!.slice(0, 5),
          endTime: b.endTime!.slice(0, 5),
        }));

      daysData[date] = {
        availability: dayAvail,
        appointments: dayAppointments,
        absence: absence ? (absence.entryType as "urlaub" | "krankheit") : null,
        blockers: hasFullDayBlocker ? "fullday" : blockerSlots.length > 0 ? blockerSlots : null,
        freeSlots,
      };
    }

    return { id: emp.id, displayName: empName, days: daysData };
  });

  return { dates, employees: result };
}
