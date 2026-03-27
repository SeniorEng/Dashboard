import { isWeekend, addMinutesToTimeHHMMSS } from "@shared/utils/datetime";
import { isHoliday } from "@shared/utils/holidays";
import type { Weekday, CreateSeriesInput } from "@shared/schema";
import { appointments, appointmentServices as appointmentServicesTable } from "@shared/schema";
import { appointmentService } from "./appointments";
import { db, type DbOrTx } from "../lib/db";

const WEEKDAY_TO_JS_DAY: Record<Weekday, number> = {
  mo: 1,
  di: 2,
  mi: 3,
  do: 4,
  fr: 5,
};

const MAX_SERIES_MONTHS = 12;

export interface GeneratedDate {
  date: string;
  skipped: boolean;
  skipReason?: string;
}

export interface SeriesValidationResult {
  valid: boolean;
  error?: string;
  dates: GeneratedDate[];
  validDates: string[];
  conflicts: Array<{ date: string; reason: string }>;
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function generateSeriesDates(
  startDate: string,
  endDate: string,
  weekdays: Weekday[],
  frequency: "weekly" | "biweekly",
): GeneratedDate[] {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  const maxEnd = new Date(start);
  maxEnd.setMonth(maxEnd.getMonth() + MAX_SERIES_MONTHS);
  const effectiveEnd = end < maxEnd ? end : maxEnd;

  const targetDays = new Set(weekdays.map(w => WEEKDAY_TO_JS_DAY[w]));

  const results: GeneratedDate[] = [];
  const current = new Date(start);

  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

  let weekNumber = 0;
  let lastWeekStart = weekStart.getTime();

  while (current <= effectiveEnd) {
    const currentWeekStart = new Date(current);
    currentWeekStart.setDate(currentWeekStart.getDate() - ((currentWeekStart.getDay() + 6) % 7));

    if (currentWeekStart.getTime() !== lastWeekStart) {
      weekNumber++;
      lastWeekStart = currentWeekStart.getTime();
    }

    const dayOfWeek = current.getDay();
    const dateStr = formatDate(current);

    if (targetDays.has(dayOfWeek)) {
      const shouldSkipBiweekly = frequency === "biweekly" && weekNumber % 2 !== 0;

      if (shouldSkipBiweekly) {
        // skip silently for biweekly
      } else if (isWeekend(dateStr)) {
        results.push({ date: dateStr, skipped: true, skipReason: "Wochenende" });
      } else {
        const holidayName = isHoliday(dateStr);
        if (holidayName) {
          results.push({ date: dateStr, skipped: true, skipReason: `Feiertag: ${holidayName}` });
        } else {
          results.push({ date: dateStr, skipped: false });
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return results;
}

export async function validateSeriesDates(
  input: CreateSeriesInput,
): Promise<SeriesValidationResult> {
  const dates = generateSeriesDates(
    input.startDate,
    input.endDate,
    input.weekdays,
    input.frequency,
  );

  const validDates = dates.filter(d => !d.skipped).map(d => d.date);

  if (validDates.length === 0) {
    return {
      valid: false,
      error: "Keine gültigen Termine im gewählten Zeitraum gefunden.",
      dates,
      validDates: [],
      conflicts: [],
    };
  }

  if (validDates.length > 365) {
    return {
      valid: false,
      error: "Zu viele Termine (max. 365). Bitte verkürzen Sie den Zeitraum.",
      dates,
      validDates: [],
      conflicts: [],
    };
  }

  const totalDuration = input.services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const scheduledEnd = addMinutesToTimeHHMMSS(input.scheduledStart, totalDuration);

  const conflicts: Array<{ date: string; reason: string }> = [];

  for (const dateStr of validDates) {
    const employeeOverlap = await appointmentService.checkOverlap(
      dateStr,
      input.scheduledStart,
      scheduledEnd,
      input.assignedEmployeeId,
    );

    if (employeeOverlap.hasOverlap) {
      conflicts.push({ date: dateStr, reason: "Mitarbeiter-Terminüberschneidung" });
      continue;
    }

    const customerOverlap = await appointmentService.checkCustomerOverlap(
      dateStr,
      input.scheduledStart,
      scheduledEnd,
      input.customerId,
    );

    if (customerOverlap) {
      conflicts.push({ date: dateStr, reason: "Kunde hat bereits einen Termin" });
    }
  }

  const nonConflictDates = validDates.filter(d => !conflicts.some(c => c.date === d));

  return {
    valid: nonConflictDates.length > 0,
    dates,
    validDates: nonConflictDates,
    conflicts,
  };
}

export async function createSeriesAppointments(
  seriesId: number,
  input: CreateSeriesInput,
  validDates: string[],
  createdByUserId: number,
  tx?: DbOrTx,
): Promise<number> {
  const client = tx || db;
  const totalDuration = input.services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const scheduledEnd = addMinutesToTimeHHMMSS(input.scheduledStart, totalDuration);

  let created = 0;

  for (const dateStr of validDates) {
    const appointmentData = {
      customerId: input.customerId,
      appointmentType: "Kundentermin" as const,
      date: dateStr,
      scheduledStart: input.scheduledStart,
      scheduledEnd,
      durationPromised: totalDuration,
      notes: input.notes || null,
      status: "scheduled" as const,
      assignedEmployeeId: input.assignedEmployeeId,
      createdByUserId,
      seriesId,
      isSeriesException: false,
    };

    const [appointment] = await client.insert(appointments).values(appointmentData).returning();

    if (input.services.length > 0) {
      await client.insert(appointmentServicesTable).values(
        input.services.map(s => ({
          appointmentId: appointment.id,
          serviceId: s.serviceId,
          plannedDurationMinutes: s.durationMinutes,
        })),
      );
    }

    created++;
  }

  return created;
}
