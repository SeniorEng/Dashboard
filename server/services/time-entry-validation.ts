/**
 * Validierungs-Helfer für `employeeTimeEntries`.
 *
 * Enthält die Konflikt-Prüfung gegen bestehende Termine und Zeiteinträge.
 * Wird sowohl beim Anlegen als auch beim Bearbeiten von Einträgen
 * verwendet sowie vom dedizierten `/check-conflicts` Endpoint.
 */

import { storage } from "../storage";
import { timeTrackingStorage } from "../storage/time-tracking";
import {
  formatTimeShort,
  getAppointmentEndMinutes,
  getEntryTypeLabel,
  timeRangesOverlap,
} from "@shared/domain/time-entries";
import { timeToMinutes } from "@shared/utils/datetime";

interface CheckTimeConflictsArgs {
  userId: number;
  date: string;
  startTime: string | null | undefined;
  endTime: string | null | undefined;
  isFullDay: boolean;
  excludeEntryId?: number;
  entryType?: string;
}

/**
 * Liefert eine deutsche Konflikt-Beschreibung oder `null`, wenn kein
 * Konflikt vorliegt. Organisatorische Eintragsarten (`verfuegbar`,
 * `blocker`) erzeugen nie Konflikte.
 */
export async function checkTimeConflicts(
  args: CheckTimeConflictsArgs,
): Promise<string | null> {
  const { userId, date, startTime, endTime, isFullDay, excludeEntryId, entryType } = args;

  if (entryType === "verfuegbar" || entryType === "blocker") {
    return null;
  }

  const dayAppointments = await storage.getAppointmentsForDay(userId, date);
  const activeAppointments = dayAppointments.filter(a => a.status !== 'cancelled');

  const allDayEntries = await timeTrackingStorage.getTimeEntriesForDate(userId, date);
  const otherEntries = allDayEntries
    .filter(e => e.id !== excludeEntryId)
    .filter(e => e.entryType !== "verfuegbar" && e.entryType !== "blocker");

  if (isFullDay) {
    if (activeAppointments.length > 0) {
      const apptTimes = activeAppointments
        .map(a => a.scheduledStart)
        .slice(0, 3)
        .join(", ");
      return `An diesem Tag gibt es bereits Termine (${apptTimes})`;
    }
    if (otherEntries.length > 0) {
      const entryTypes = otherEntries.map(e => getEntryTypeLabel(e.entryType)).slice(0, 3).join(", ");
      return `An diesem Tag gibt es bereits Zeiteinträge (${entryTypes})`;
    }
    return null;
  }

  for (const entry of otherEntries) {
    if (entry.isFullDay) {
      return `An diesem Tag ist bereits ein ganztägiger Eintrag (${getEntryTypeLabel(entry.entryType)}) vorhanden`;
    }
  }

  if (!startTime || !endTime) {
    return null;
  }

  const newStart = timeToMinutes(startTime);
  const newEnd = timeToMinutes(endTime);

  if (newEnd <= newStart) {
    return "Die Endzeit muss nach der Startzeit liegen";
  }

  for (const appt of activeAppointments) {
    const apptStart = timeToMinutes(appt.scheduledStart);
    const apptEnd = getAppointmentEndMinutes(appt);

    if (apptEnd === -1) continue;

    if (timeRangesOverlap(newStart, newEnd, apptStart, apptEnd)) {
      const customerName = appt.customer?.name
        || `${appt.customer?.vorname || ''} ${appt.customer?.nachname || ''}`.trim()
        || 'Unbekannt';
      return `Überlappung mit Termin um ${appt.scheduledStart.slice(0, 5)} Uhr bei ${customerName}`;
    }
  }

  for (const entry of otherEntries) {
    if (entry.isFullDay) {
      return `An diesem Tag ist bereits ein ganztägiger Eintrag (${getEntryTypeLabel(entry.entryType)}) vorhanden`;
    }

    if (entry.startTime && entry.endTime) {
      const entryStart = timeToMinutes(entry.startTime);
      const entryEnd = timeToMinutes(entry.endTime);

      if (timeRangesOverlap(newStart, newEnd, entryStart, entryEnd)) {
        return `Überlappung mit bestehendem Eintrag (${getEntryTypeLabel(entry.entryType)}) von ${formatTimeShort(entry.startTime)} bis ${formatTimeShort(entry.endTime)} Uhr`;
      }
    }
  }

  return null;
}
