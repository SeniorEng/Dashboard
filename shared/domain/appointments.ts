import type { Appointment } from "../schema";
import { timeToMinutes, addMinutesToTime, formatDurationDisplay } from "../utils/datetime";

// ============================================
// TYPES
// ============================================

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed" | "cancelled";
export type AppointmentType = "Erstberatung" | "Kundentermin";
export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung" | "Erstberatung";
export type TravelOriginType = "home" | "appointment";

// ============================================
// CONSTANTS
// ============================================

export const APPOINTMENT_STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting", "completed", "cancelled"];
export const APPOINTMENT_TYPES: AppointmentType[] = ["Erstberatung", "Kundentermin"];
export const SERVICE_TYPES: ServiceType[] = ["Hauswirtschaft", "Alltagsbegleitung", "Erstberatung"];
export const TRAVEL_ORIGIN_TYPES: TravelOriginType[] = ["home", "appointment"];

export const STATUS_ORDER: Record<AppointmentStatus, number> = {
  "scheduled": 0,
  "in-progress": 1,
  "documenting": 2,
  "completed": 3,
  "cancelled": 4,
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  "scheduled": "Geplant",
  "in-progress": "Läuft",
  "documenting": "Dokumentation",
  "completed": "Abgeschlossen",
  "cancelled": "Storniert",
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
 * Status, die als "dokumentiert" für Leistungsnachweise gelten.
 * Nur Termine mit diesen Status werden in einen Leistungsnachweis aufgenommen.
 */
export const DOCUMENTED_STATUSES: AppointmentStatus[] = ["completed"];

/**
 * Status, die einen Leistungsnachweis blockieren.
 * Solange Termine mit diesen Status existieren, kann kein Leistungsnachweis erstellt werden.
 */
export const UNDOCUMENTED_STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting"];


export const PFLEGEGRAD_OPTIONS = [1, 2, 3, 4, 5] as const;
export type Pflegegrad = typeof PFLEGEGRAD_OPTIONS[number];

export const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240] as const;
export type DurationOption = typeof DURATION_OPTIONS[number];

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

export interface ServiceInfo {
  hasHauswirtschaft: boolean;
  hasAlltagsbegleitung: boolean;
  hasErstberatung: boolean;
  hasBoth: boolean;
  label: string;
  primaryType: ServiceType | null;
}

export interface CardServiceInfo extends ServiceInfo {
  borderClass: string;
}

const ALLOWED_CANCELLATION_SOURCES: AppointmentStatus[] = ["scheduled", "in-progress"];

export function isValidStatusTransition(
  currentStatus: AppointmentStatus,
  targetStatus: AppointmentStatus
): boolean {
  if (targetStatus === "cancelled" && ALLOWED_CANCELLATION_SOURCES.includes(currentStatus)) {
    return true;
  }
  const currentIndex = STATUS_ORDER[currentStatus];
  const targetIndex = STATUS_ORDER[targetStatus];
  return targetIndex === currentIndex || targetIndex === currentIndex + 1;
}

export function canModifyAppointment(status: AppointmentStatus): boolean {
  return status !== "completed";
}


export function canEditNotes(status: AppointmentStatus): boolean {
  return status === "scheduled" || status === "documenting";
}

export const STATUS_COLORS: Record<AppointmentStatus, string> = {
  "scheduled": "bg-muted text-muted-foreground border-muted-foreground/20",
  "in-progress": "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
  "documenting": "bg-orange-50 text-orange-700 border-orange-200",
  "completed": "bg-green-50 text-green-700 border-green-200",
  "cancelled": "bg-red-50 text-red-700 border-red-200",
};

export const APPOINTMENT_TYPE_COLORS: Record<AppointmentType, string> = {
  "Erstberatung": "bg-purple-100 text-purple-800 border-purple-200",
  "Kundentermin": "bg-teal-100 text-teal-800 border-teal-200",
};

export const SERVICE_TYPE_COLORS: Record<ServiceType, string> = {
  "Hauswirtschaft": "bg-amber-50 text-amber-700 border-amber-200",
  "Alltagsbegleitung": "bg-sky-50 text-sky-700 border-sky-200",
  "Erstberatung": "bg-purple-50 text-purple-700 border-purple-200",
};


export function getStatusColor(status: string): string {
  return STATUS_COLORS[status as AppointmentStatus] ?? STATUS_COLORS.scheduled;
}

export function getStatusLabel(status: string): string {
  return STATUS_LABELS[status as AppointmentStatus] ?? status;
}

export function getAppointmentTypeColor(appointmentType: string): string {
  return APPOINTMENT_TYPE_COLORS[appointmentType as AppointmentType] ?? APPOINTMENT_TYPE_COLORS.Kundentermin;
}

export function getServiceColor(serviceType: string | null): string {
  if (!serviceType) return "bg-gray-100 text-gray-600 border-gray-200";
  return SERVICE_TYPE_COLORS[serviceType as ServiceType] ?? "bg-gray-100 text-gray-600 border-gray-200";
}


export const STATUS_PRIORITY: Record<AppointmentStatus, number> = {
  "in-progress": 0,
  "documenting": 1,
  "scheduled": 2,
  "completed": 3,
  "cancelled": 4,
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


export interface TravelOriginSuggestion {
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
