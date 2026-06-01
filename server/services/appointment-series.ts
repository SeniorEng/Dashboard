import { addMinutesToTimeHHMMSS } from "@shared/utils/datetime";
import type { CreateSeriesInput } from "@shared/schema";
import { appointments, appointmentServices as appointmentServicesTable } from "@shared/schema";
import { generateSeriesDates, type GeneratedDate } from "@shared/domain/appointments";
import { appointmentService } from "./appointments";
import { db, type DbOrTx } from "../lib/db";

export type { GeneratedDate };

export interface SeriesValidationResult {
  valid: boolean;
  error?: string;
  dates: GeneratedDate[];
  validDates: string[];
  conflicts: Array<{ date: string; reason: string }>;
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
): Promise<{ count: number; firstAppointmentId: number | null; firstDate: string | null }> {
  const client = tx || db;
  const totalDuration = input.services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const scheduledEnd = addMinutesToTimeHHMMSS(input.scheduledStart, totalDuration);

  let created = 0;
  let firstAppointmentId: number | null = null;
  let firstDate: string | null = null;

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

    if (firstAppointmentId === null) {
      firstAppointmentId = appointment.id;
      firstDate = dateStr;
    }
    created++;
  }

  return { count: created, firstAppointmentId, firstDate };
}
