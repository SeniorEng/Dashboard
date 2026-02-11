import { timeToMinutes } from "../utils/datetime";

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  urlaub: "Urlaub",
  krankheit: "Krankheit",
  pause: "Pause",
  bueroarbeit: "Büroarbeit",
  vertrieb: "Vertrieb",
  schulung: "Schulung",
  besprechung: "Besprechung",
  sonstiges: "Sonstiges",
};

export function getEntryTypeLabel(entryType: string): string {
  return ENTRY_TYPE_LABELS[entryType] || entryType;
}

export function formatTimeShort(time: string): string {
  return time.slice(0, 5);
}

export function timeRangesOverlap(
  start1: number, end1: number,
  start2: number, end2: number
): boolean {
  return start1 < end2 && start2 < end1;
}

export function getAppointmentEndMinutes(appt: {
  scheduledStart: string;
  scheduledEnd: string | null;
  actualEnd: string | null;
  durationPromised: number;
  travelMinutes: number | null;
}): number {
  const apptStart = timeToMinutes(appt.scheduledStart);

  if (appt.actualEnd) {
    return timeToMinutes(appt.actualEnd);
  }

  if (appt.scheduledEnd) {
    return timeToMinutes(appt.scheduledEnd);
  }

  const duration = appt.durationPromised + (appt.travelMinutes || 0);
  if (duration > 0) {
    return apptStart + duration;
  }

  return -1;
}

export const FULL_DAY_ENTRY_TYPES = ["urlaub", "krankheit"] as const;

export function isFullDayEntryType(entryType: string): boolean {
  return (FULL_DAY_ENTRY_TYPES as readonly string[]).includes(entryType);
}

export const MONTH_CLOSING_ERRORS = {
  alreadyClosed: "Dieser Monat ist bereits abgeschlossen.",
  notClosed: "Dieser Monat ist nicht abgeschlossen.",
  invalidInput: "Ungültige Eingabe",
  invalidYearMonth: "Ungültiges Jahr oder Monat",
} as const;
