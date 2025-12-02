import type { Appointment } from "../schema";

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed";
export type AppointmentType = "Erstberatung" | "Kundentermin";
export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung";

export const APPOINTMENT_STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting", "completed"];
export const APPOINTMENT_TYPES: AppointmentType[] = ["Erstberatung", "Kundentermin"];
export const SERVICE_TYPES: ServiceType[] = ["Hauswirtschaft", "Alltagsbegleitung"];

export const STATUS_ORDER: Record<AppointmentStatus, number> = {
  "scheduled": 0,
  "in-progress": 1,
  "documenting": 2,
  "completed": 3,
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  "scheduled": "Geplant",
  "in-progress": "Läuft",
  "documenting": "Dokumentation",
  "completed": "Abgeschlossen",
};

export const PFLEGEGRAD_OPTIONS = [1, 2, 3, 4, 5] as const;
export type Pflegegrad = typeof PFLEGEGRAD_OPTIONS[number];

export const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240] as const;
export type DurationOption = typeof DURATION_OPTIONS[number];

export const SERVICE_OPTIONS = [
  "Vitalzeichen prüfen",
  "Medikamente verabreicht",
  "Körperpflege",
  "Mahlzeit zubereitet",
  "Haushaltsarbeiten",
  "Soziale Aktivität"
] as const;
export type ServiceOption = typeof SERVICE_OPTIONS[number];

export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): string {
  const normalizedMinutes = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalizedMinutes / 60);
  const mins = normalizedMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

export function addMinutesToTime(time: string, minutesToAdd: number): string {
  const totalMinutes = timeToMinutes(time) + minutesToAdd;
  return minutesToTime(totalMinutes);
}

export function formatTimeSlot(time: string | null): string {
  if (!time) return "--:--";
  return time.slice(0, 5);
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min.`;
  if (m === 0) return `${h} Std.`;
  return `${h} Std. ${m} Min.`;
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

export function calculateTotalDuration(
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined
): number {
  return (hauswirtschaftDauer || 0) + (alltagsbegleitungDauer || 0);
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
  hasBoth: boolean;
  label: string;
  primaryType: ServiceType | null;
}

export function getServiceInfo(
  appointmentType: string,
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined,
  legacyServiceType?: string | null
): ServiceInfo {
  if (appointmentType === "Erstberatung") {
    return {
      hasHauswirtschaft: false,
      hasAlltagsbegleitung: false,
      hasBoth: false,
      label: "Erstberatung",
      primaryType: null,
    };
  }

  const hasHauswirtschaft = !!hauswirtschaftDauer;
  const hasAlltagsbegleitung = !!alltagsbegleitungDauer;
  const hasBoth = hasHauswirtschaft && hasAlltagsbegleitung;

  let label: string;
  let primaryType: ServiceType | null = null;

  if (hasBoth) {
    label = "Hauswirtschaft & Alltagsbegleitung";
    primaryType = "Hauswirtschaft";
  } else if (hasHauswirtschaft) {
    label = "Hauswirtschaft";
    primaryType = "Hauswirtschaft";
  } else if (hasAlltagsbegleitung) {
    label = "Alltagsbegleitung";
    primaryType = "Alltagsbegleitung";
  } else if (legacyServiceType === "Hauswirtschaft") {
    label = "Hauswirtschaft";
    primaryType = "Hauswirtschaft";
  } else if (legacyServiceType === "Alltagsbegleitung") {
    label = "Alltagsbegleitung";
    primaryType = "Alltagsbegleitung";
  } else {
    label = "Kundentermin";
    primaryType = null;
  }

  return { hasHauswirtschaft, hasAlltagsbegleitung, hasBoth, label, primaryType };
}

export function isValidStatusTransition(
  currentStatus: AppointmentStatus,
  targetStatus: AppointmentStatus
): boolean {
  const currentIndex = STATUS_ORDER[currentStatus];
  const targetIndex = STATUS_ORDER[targetStatus];
  return targetIndex === currentIndex || targetIndex === currentIndex + 1;
}

export function canModifyAppointment(status: AppointmentStatus): boolean {
  return status !== "completed";
}

export function canEditSchedulingFields(
  currentStatus: AppointmentStatus,
  targetStatus: AppointmentStatus
): boolean {
  return currentStatus === "scheduled" && targetStatus === "scheduled";
}

export function canEditDocumentationFields(status: AppointmentStatus): boolean {
  return status === "documenting";
}

export function canEditNotes(status: AppointmentStatus): boolean {
  return status === "scheduled" || status === "documenting";
}
