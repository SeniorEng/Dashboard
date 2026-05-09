import { timeToMinutes } from "../utils/datetime";

const ENTRY_TYPE_LABELS: Record<string, string> = {
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

const TIME_HHMM_REGEX = /^\d{2}:\d{2}(:\d{2})?$/;

export type TimeRangeValidation =
  | { ok: true }
  | { ok: false; reason: "invalid_format" | "end_before_start"; message: string };

/**
 * Reine Validierung eines optionalen Zeit-Bereichs (HH:MM bzw. HH:MM:SS).
 *
 * - Fehlende Werte gelten als gültig (es gibt nichts zu prüfen — Pflichtfelder
 *   werden an anderer Stelle erzwungen).
 * - Fehlerhaftes Format und „Ende ≤ Start" liefern eine deutsche Meldung,
 *   identisch zu den bisherigen Inline-Checks im Hook und Server.
 */
export function validateTimeRange(args: {
  startTime?: string | null;
  endTime?: string | null;
}): TimeRangeValidation {
  const { startTime, endTime } = args;
  if (!startTime || !endTime) return { ok: true };

  if (!TIME_HHMM_REGEX.test(startTime) || !TIME_HHMM_REGEX.test(endTime)) {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Ungültiges Zeitformat (HH:MM erwartet)",
    };
  }

  if (endTime <= startTime) {
    return {
      ok: false,
      reason: "end_before_start",
      message: "Die Endzeit muss nach der Startzeit liegen",
    };
  }

  return { ok: true };
}

const ENTRY_TYPES_WITHOUT_KILOMETERS = ["pause", "verfuegbar", "blocker"] as const;

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

/**
 * Liste der Eintragsarten, die als "echte" Arbeitszeit zählen
 * (relevant für Pausenpflicht und Arbeitszeit-Kappung gem. ArbZG).
 *
 * Pause selbst zählt NICHT als Arbeitszeit. Urlaub/Krankheit sind
 * Abwesenheiten. Verfügbar/Blocker sind organisatorisch.
 */
const WORK_ENTRY_TYPES = ["bueroarbeit", "vertrieb", "sonstiges"] as const;
type WorkEntryType = typeof WORK_ENTRY_TYPES[number];

export function isWorkEntryType(entryType: string): entryType is WorkEntryType {
  return (WORK_ENTRY_TYPES as readonly string[]).includes(entryType);
}

/**
 * Pausenpflicht gem. §4 ArbZG:
 * - > 6 h Arbeit  → mindestens 30 min Pause
 * - > 9 h Arbeit  → mindestens 45 min Pause
 *
 * Liefert 0, wenn keine Pause vorgeschrieben ist.
 */
export function calculateRequiredBreak(workMinutes: number): number {
  if (workMinutes > 540) return 45; // > 9 h
  if (workMinutes > 360) return 30; // > 6 h
  return 0;
}

/**
 * Tägliches gesetzliches Arbeitszeit-Maximum gem. §3 ArbZG: 10 h = 600 min.
 */
export const ARBZG_MAX_DAILY_MINUTES = 600;

