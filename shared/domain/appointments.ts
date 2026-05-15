import type { Appointment } from "../schema";
import { timeToMinutes, addMinutesToTime, formatDurationDisplay } from "../utils/datetime";

// ============================================
// TYPES
// ============================================

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed" | "cancelled" | "expired_unsigned" | "customer_no_show";
export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung" | "Erstberatung";
export type TravelOriginType = "home" | "appointment";

// ============================================
// CONSTANTS
// ============================================


const STATUS_ORDER: Record<AppointmentStatus, number> = {
  "scheduled": 0,
  "in-progress": 1,
  "documenting": 2,
  "completed": 3,
  "cancelled": 4,
  "expired_unsigned": 5,
  "customer_no_show": 6,
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  "scheduled": "Geplant",
  "in-progress": "Läuft",
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
// 1. Termin durchführen → Status wechselt zu "documenting"
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
// - Status = "in-progress" (läuft gerade)
// - Status = "documenting" (Dokumentation noch nicht abgeschlossen)
// ============================================

/**
 * Status, die einen Leistungsnachweis blockieren.
 * Solange Termine mit diesen Status existieren, kann kein Leistungsnachweis erstellt werden.
 */
export const UNDOCUMENTED_STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting"];


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

const ALLOWED_CANCELLATION_SOURCES: AppointmentStatus[] = ["scheduled", "in-progress"];
const ALLOWED_NO_SHOW_SOURCES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting"];

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
// Bewusst NICHT als „Doku unvollständig" gelten: `in-progress`
// (läuft gerade, regulär), `completed`, `cancelled`, `expired_unsigned`,
// `customer_no_show`.

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

function parseLocalDate(iso: string): Date {
  const [y, m, day] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, day || 1);
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
  "in-progress": 0,
  "documenting": 1,
  "scheduled": 2,
  "completed": 3,
  "cancelled": 4,
  "expired_unsigned": 5,
  "customer_no_show": 6,
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
