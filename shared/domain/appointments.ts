import type { Appointment, Weekday } from "../schema";
import { timeToMinutes, addMinutesToTime, formatDurationDisplay, parseLocalDate, isWeekend } from "../utils/datetime";
import { isHoliday } from "../utils/holidays";

// ============================================
// TYPES
// ============================================

export type AppointmentStatus = "scheduled" | "documenting" | "completed" | "cancelled" | "expired_unsigned" | "customer_no_show";
export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung" | "Erstberatung";
export type TravelOriginType = "home" | "appointment";

// ============================================
// CONSTANTS
// ============================================


const STATUS_ORDER: Record<AppointmentStatus, number> = {
  "scheduled": 0,
  "documenting": 1,
  "completed": 2,
  "cancelled": 3,
  "expired_unsigned": 4,
  "customer_no_show": 5,
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  "scheduled": "Geplant",
  "documenting": "Dokumentation",
  "completed": "Abgeschlossen",
  "cancelled": "Storniert",
  "expired_unsigned": "Nicht abgerechnet",
  "customer_no_show": "Kunde nicht angetroffen",
};

// ============================================
// STATUS DEFINITIONS FOR SERVICE RECORDS
// ============================================
//
// Diese Definitionen legen fest, welche Termin-Status für
// Leistungsnachweise als "dokumentiert" gelten.
//
// Workflow für Leistungsnachweise:
// 1. Termin durchführen → Status wechselt direkt zu "documenting"
// 2. Dokumentation ausfüllen (Dauer, Notizen, etc.)
// 3. Termin abschließen → Status wechselt zu "completed"
// 4. Leistungsnachweis erstellen (wenn ALLE Termine des Monats "completed" sind)
// 5. Unterschriften einholen (Mitarbeiter, dann Kunde)
//
// Ein Termin gilt als "dokumentiert" für Leistungsnachweise, wenn:
// - Status = "completed" (Termin wurde durchgeführt und dokumentiert)
//
// Ein Termin gilt als "undokumentiert" (blockiert Leistungsnachweis), wenn:
// - Status = "scheduled" (noch nicht durchgeführt)
// - Status = "documenting" (Dokumentation noch nicht abgeschlossen)
// ============================================

/**
 * Status, die einen Leistungsnachweis blockieren.
 * Solange Termine mit diesen Status existieren, kann kein Leistungsnachweis erstellt werden.
 */
export const UNDOCUMENTED_STATUSES: AppointmentStatus[] = ["scheduled", "documenting"];


export const PFLEGEGRAD_OPTIONS = [1, 2, 3, 4, 5] as const;

export const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240] as const;

// ============================================
// TIME FORMATTING UTILITIES
// ============================================

export function formatTimeSlot(time: string | null): string {
  if (!time) return "--:--";
  return time.slice(0, 5);
}

export function formatDuration(minutes: number): string {
  return formatDurationDisplay(minutes, "verbose");
}

export function doTimesOverlap(
  start1: string,
  end1: string,
  start2: string,
  end2: string
): boolean {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}


export function getEndTime(
  scheduledStart: string,
  scheduledEnd: string | null,
  durationPromised: number | null
): string {
  if (scheduledEnd) {
    return formatTimeSlot(scheduledEnd);
  }
  if (scheduledStart && durationPromised) {
    return addMinutesToTime(scheduledStart, durationPromised).slice(0, 5);
  }
  return "--:--";
}

interface ServiceInfo {
  hasHauswirtschaft: boolean;
  hasAlltagsbegleitung: boolean;
  hasErstberatung: boolean;
  hasBoth: boolean;
  label: string;
  primaryType: ServiceType | null;
}

interface CardServiceInfo extends ServiceInfo {
  borderClass: string;
}

const ALLOWED_CANCELLATION_SOURCES: AppointmentStatus[] = ["scheduled"];
const ALLOWED_NO_SHOW_SOURCES: AppointmentStatus[] = ["scheduled", "documenting"];

export function isValidStatusTransition(
  currentStatus: AppointmentStatus,
  targetStatus: AppointmentStatus
): boolean {
  if (targetStatus === "cancelled" && ALLOWED_CANCELLATION_SOURCES.includes(currentStatus)) {
    return true;
  }
  if (targetStatus === "customer_no_show" && ALLOWED_NO_SHOW_SOURCES.includes(currentStatus)) {
    return true;
  }
  if (currentStatus === "completed" && targetStatus === "documenting") {
    return true;
  }
  const currentIndex = STATUS_ORDER[currentStatus];
  const targetIndex = STATUS_ORDER[targetStatus];
  return targetIndex === currentIndex || targetIndex === currentIndex + 1;
}

export function canModifyAppointment(status: AppointmentStatus): boolean {
  return status !== "completed" && status !== "customer_no_show";
}

// ============================================
// "DOKU UNVOLLSTÄNDIG" — ABLEITUNG
// ============================================
//
// Ein Termin gilt als „Doku unvollständig" und wird in Termin-Listen
// gelb markiert, wenn er entweder
//   1) im Status `documenting` hängt (Mitarbeiter hat angefangen, aber
//      nicht abgeschlossen) — unabhängig vom Datum, ODER
//   2) im Status `scheduled` geblieben ist UND das geplante Termin-Ende
//      bereits in der Vergangenheit liegt.
//
// Bewusst NICHT als „Doku unvollständig" gelten: `completed`, `cancelled`,
// `expired_unsigned`, `customer_no_show`.

function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatLocalTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function isDocumentationOverdue(
  appointment: {
    status: AppointmentStatus | string;
    date: string;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    durationPromised?: number | null;
  },
  now: Date = new Date(),
): boolean {
  if (appointment.status === "documenting") return true;
  if (appointment.status !== "scheduled") return false;
  if (!appointment.date) return false;

  const todayIso = formatLocalIsoDate(now);
  if (appointment.date < todayIso) return true;
  if (appointment.date > todayIso) return false;

  // Heute: nur überfällig, wenn das geplante Ende bereits passiert ist.
  let end: string | null = appointment.scheduledEnd ? appointment.scheduledEnd.slice(0, 5) : null;
  if (!end && appointment.scheduledStart && appointment.durationPromised) {
    end = addMinutesToTime(appointment.scheduledStart, appointment.durationPromised).slice(0, 5);
  }
  if (!end) return false;
  return end < formatLocalTime(now);
}


export type DocumentationAgeBucket = "overdue" | "this-week" | "today";

export const DOCUMENTATION_AGE_BUCKET_LABELS: Record<DocumentationAgeBucket, string> = {
  "overdue": "Älter als 7 Tage",
  "this-week": "Diese Woche",
  "today": "Heute",
};

export const DOCUMENTATION_AGE_BUCKET_ORDER: DocumentationAgeBucket[] = ["overdue", "this-week", "today"];

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysOverdue(
  appointment: { date: string },
  now: Date = new Date(),
): number {
  const today = startOfLocalDay(now);
  const apt = startOfLocalDay(parseLocalDate(appointment.date));
  const ms = today.getTime() - apt.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function getDocumentationAgeBucket(
  appointment: { date: string },
  now: Date = new Date(),
): DocumentationAgeBucket {
  const days = daysOverdue(appointment, now);
  if (days > 7) return "overdue";
  if (days >= 1) return "this-week";
  return "today";
}

export function canEditNotes(status: AppointmentStatus): boolean {
  return status === "scheduled" || status === "documenting";
}

export const STATUS_PRIORITY: Record<AppointmentStatus, number> = {
  "documenting": 0,
  "scheduled": 1,
  "completed": 2,
  "cancelled": 3,
  "expired_unsigned": 4,
  "customer_no_show": 5,
};


export function getCardServiceInfoFromAppointment(appointment: {
  appointmentType: string;
  serviceType: string | null;
  durationPromised: number | null;
  status: string;
}): CardServiceInfo {
  const { appointmentType, serviceType, durationPromised } = appointment;
  
  if (appointmentType === "Erstberatung") {
    return {
      hasHauswirtschaft: false,
      hasAlltagsbegleitung: false,
      hasErstberatung: true,
      hasBoth: false,
      label: "Erstberatung",
      primaryType: "Erstberatung",
      borderClass: "bg-purple-500",
    };
  }

  const hasHauswirtschaft = serviceType === "Hauswirtschaft" || serviceType === "Hauswirtschaft & Alltagsbegleitung";
  const hasAlltagsbegleitung = serviceType === "Alltagsbegleitung" || serviceType === "Hauswirtschaft & Alltagsbegleitung";
  const hasBoth = hasHauswirtschaft && hasAlltagsbegleitung;

  let label: string;
  let primaryType: ServiceType | null = null;
  let borderClass: string;

  if (hasBoth) {
    label = "Hauswirtschaft & Alltagsbegleitung";
    primaryType = "Hauswirtschaft";
    borderClass = "";
  } else if (hasHauswirtschaft) {
    label = "Hauswirtschaft";
    primaryType = "Hauswirtschaft";
    borderClass = "bg-amber-500";
  } else if (hasAlltagsbegleitung) {
    label = "Alltagsbegleitung";
    primaryType = "Alltagsbegleitung";
    borderClass = "bg-sky-500";
  } else {
    label = serviceType || "Kundentermin";
    primaryType = null;
    borderClass = "bg-teal-500";
  }

  return { hasHauswirtschaft, hasAlltagsbegleitung, hasErstberatung: false, hasBoth, label, primaryType, borderClass };
}


interface TravelOriginSuggestion {
  suggestedOrigin: TravelOriginType;
  previousAppointment: Appointment | null;
  previousCustomerName?: string;
}

function getScheduledEndMinutes(apt: Appointment): number {
  if (apt.scheduledEnd) {
    return timeToMinutes(apt.scheduledEnd);
  }
  if (apt.scheduledStart && apt.durationPromised) {
    return timeToMinutes(apt.scheduledStart) + apt.durationPromised;
  }
  return timeToMinutes(apt.scheduledStart);
}

export function suggestTravelOrigin(
  currentAppointment: Appointment,
  sameDayAppointments: (Appointment & { customerName?: string })[]
): TravelOriginSuggestion {
  const currentStartMinutes = timeToMinutes(currentAppointment.scheduledStart);
  
  const appointmentsBefore = sameDayAppointments
    .filter(apt => apt.id !== currentAppointment.id)
    .map(apt => ({
      ...apt,
      scheduledStartMinutes: timeToMinutes(apt.scheduledStart),
      scheduledEndMinutes: getScheduledEndMinutes(apt),
    }))
    .filter(apt => apt.scheduledStartMinutes < currentStartMinutes)
    .sort((a, b) => b.scheduledStartMinutes - a.scheduledStartMinutes);

  if (appointmentsBefore.length > 0) {
    const previous = appointmentsBefore[0];
    const gapMinutes = currentStartMinutes - previous.scheduledEndMinutes;
    
    if (gapMinutes >= 0 && gapMinutes <= 60) {
      return {
        suggestedOrigin: "appointment",
        previousAppointment: previous,
        previousCustomerName: previous.customerName,
      };
    }
  }

  return {
    suggestedOrigin: "home",
    previousAppointment: null,
  };
}

export function validateServiceDocumentationFromServices(
  services: Array<{ actualDurationMinutes: number; details?: string | null; serviceName?: string }>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const hasAny = services.some(s => s.actualDurationMinutes > 0);
  if (!hasAny) {
    errors.push("Mindestens ein Service muss dokumentiert werden");
    return { valid: false, errors };
  }

  for (const s of services) {
    if (s.actualDurationMinutes > 0 && s.details && s.details.length > 120) {
      errors.push(`${s.serviceName || 'Service'} Details dürfen maximal 120 Zeichen haben`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// BOOKING DATE RULES (SSoT)
// ============================================

/**
 * Liegt das Datum mehr als 3 Monate vor "heute"?
 *
 * Pure Datums-Regel — zentrale Quelle für den Far-Past-Check, dessen Ergebnis
 * die Create-Policy als `isFarPast`-Flag konsumiert (die Policy bleibt damit
 * frei von "now"-Logik). `now` ist für Tests injizierbar.
 */
export function isMoreThan3MonthsInPast(dateStr: string, now: Date = new Date()): boolean {
  const date = parseLocalDate(dateStr);
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  threeMonthsAgo.setHours(0, 0, 0, 0);
  return date < threeMonthsAgo;
}

// ============================================
// SERIES DATE GENERATION (SSoT)
// ============================================
//
// Eine Quelle für die Wochentags-/Biweekly-Expansion einer Terminserie.
// Server (`validateSeriesDates`/`createSeriesAppointments`) UND Client-Vorschau
// (`use-new-appointment-form`) nutzen dieselbe Funktion, damit die angezeigte
// Vorschau exakt den tatsächlich angelegten Terminen entspricht.

const WEEKDAY_TO_JS_DAY: Record<Weekday, number> = {
  mo: 1,
  di: 2,
  mi: 3,
  do: 4,
  fr: 5,
};

export interface GeneratedDate {
  date: string;
  skipped: boolean;
  skipReason?: string;
}

function parseSeriesDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatSeriesDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Erzeugt alle Termin-Daten einer Serie zwischen `startDate` und `endDate`.
 *
 * Wochen werden Montag-ausgerichtet gezählt (ISO), damit `biweekly` jede zweite
 * Kalenderwoche trifft. Wochenenden und Feiertage werden als `skipped`-Einträge
 * markiert (nicht entfernt), Biweekly-Pausenwochen werden still ausgelassen.
 */
export function generateSeriesDates(
  startDate: string,
  endDate: string,
  weekdays: Weekday[],
  frequency: "weekly" | "biweekly",
): GeneratedDate[] {
  const start = parseSeriesDate(startDate);
  const end = parseSeriesDate(endDate);

  const targetDays = new Set(weekdays.map(w => WEEKDAY_TO_JS_DAY[w]));

  const results: GeneratedDate[] = [];
  const current = new Date(start);

  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

  let weekNumber = 0;
  let lastWeekStart = weekStart.getTime();

  while (current <= end) {
    const currentWeekStart = new Date(current);
    currentWeekStart.setDate(currentWeekStart.getDate() - ((currentWeekStart.getDay() + 6) % 7));

    if (currentWeekStart.getTime() !== lastWeekStart) {
      weekNumber++;
      lastWeekStart = currentWeekStart.getTime();
    }

    const dayOfWeek = current.getDay();
    const dateStr = formatSeriesDate(current);

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
