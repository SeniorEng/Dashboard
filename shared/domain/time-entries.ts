import { timeToMinutes } from "../utils/datetime";

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  urlaub: "Urlaub",
  krankheit: "Krankheit",
  pause: "Pause",
  bueroarbeit: "Büroarbeit",
  vertrieb: "Vertrieb",
  sonstiges: "Sonstiges",
  verfuegbar: "Verfügbar",
  blocker: "Blocker / nicht verfügbar",
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

export const ENTRY_TYPES_WITHOUT_KILOMETERS = ["pause", "verfuegbar", "blocker"] as const;

export function entryTypeSupportsKilometers(entryType: string, isFullDay: boolean): boolean {
  if (isFullDay) return false;
  return !ENTRY_TYPES_WITHOUT_KILOMETERS.includes(entryType as typeof ENTRY_TYPES_WITHOUT_KILOMETERS[number]);
}

export function getEntryDuration(entry: { durationMinutes: number | null; startTime: string | null; endTime: string | null }): number {
  if (entry.durationMinutes && entry.durationMinutes > 0) {
    return entry.durationMinutes;
  }
  if (entry.startTime && entry.endTime) {
    const [startH, startM] = entry.startTime.split(':').map(Number);
    const [endH, endM] = entry.endTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return Math.max(0, endMinutes - startMinutes);
  }
  return 0;
}

