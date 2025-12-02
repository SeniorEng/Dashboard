import type { Appointment } from "../schema";

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed";
export type AppointmentType = "Erstberatung" | "Kundentermin";
export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung";
export type TravelOriginType = "home" | "appointment";

export const APPOINTMENT_STATUSES: AppointmentStatus[] = ["scheduled", "in-progress", "documenting", "completed"];
export const APPOINTMENT_TYPES: AppointmentType[] = ["Erstberatung", "Kundentermin"];
export const SERVICE_TYPES: ServiceType[] = ["Hauswirtschaft", "Alltagsbegleitung"];
export const TRAVEL_ORIGIN_TYPES: TravelOriginType[] = ["home", "appointment"];

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

export interface CardServiceInfo extends ServiceInfo {
  borderClass: string;
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

export const STATUS_COLORS: Record<AppointmentStatus, string> = {
  "scheduled": "bg-muted text-muted-foreground border-muted-foreground/20",
  "in-progress": "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
  "documenting": "bg-orange-50 text-orange-700 border-orange-200",
  "completed": "bg-green-50 text-green-700 border-green-200",
};

export const APPOINTMENT_TYPE_COLORS: Record<AppointmentType, string> = {
  "Erstberatung": "bg-purple-100 text-purple-800 border-purple-200",
  "Kundentermin": "bg-teal-100 text-teal-800 border-teal-200",
};

export const SERVICE_TYPE_COLORS: Record<ServiceType, string> = {
  "Hauswirtschaft": "bg-amber-50 text-amber-700 border-amber-200",
  "Alltagsbegleitung": "bg-sky-50 text-sky-700 border-sky-200",
};

export const SERVICE_BORDER_COLORS: Record<ServiceType, string> = {
  "Hauswirtschaft": "border-amber-400",
  "Alltagsbegleitung": "border-sky-400",
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

export function getServiceBorderColor(serviceType: ServiceType): string {
  return SERVICE_BORDER_COLORS[serviceType];
}

export const STATUS_PRIORITY: Record<AppointmentStatus, number> = {
  "in-progress": 0,
  "documenting": 1,
  "scheduled": 2,
  "completed": 3,
};

export function getCardServiceInfo(
  appointmentType: string,
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined,
  legacyServiceType?: string | null
): CardServiceInfo {
  const info = getServiceInfo(appointmentType, hauswirtschaftDauer, alltagsbegleitungDauer, legacyServiceType);
  
  let borderClass: string;
  if (appointmentType === "Erstberatung") {
    borderClass = "bg-purple-500";
  } else if (info.hasBoth) {
    borderClass = "";
  } else if (info.primaryType === "Hauswirtschaft") {
    borderClass = "bg-amber-500";
  } else if (info.primaryType === "Alltagsbegleitung") {
    borderClass = "bg-sky-500";
  } else {
    borderClass = "bg-teal-500";
  }
  
  return { ...info, borderClass };
}

export interface TravelOriginSuggestion {
  suggestedOrigin: TravelOriginType;
  previousAppointment: Appointment | null;
  previousCustomerName?: string;
}

export function suggestTravelOrigin(
  currentAppointment: Appointment,
  sameDayAppointments: (Appointment & { customerName?: string })[]
): TravelOriginSuggestion {
  const currentStartMinutes = timeToMinutes(currentAppointment.scheduledStart);
  
  const completedBefore = sameDayAppointments
    .filter(apt => 
      apt.id !== currentAppointment.id &&
      apt.status === "completed" &&
      apt.actualEnd !== null
    )
    .map(apt => ({
      ...apt,
      endMinutes: apt.actualEnd ? new Date(apt.actualEnd).getHours() * 60 + new Date(apt.actualEnd).getMinutes() : 0
    }))
    .filter(apt => apt.endMinutes < currentStartMinutes)
    .sort((a, b) => b.endMinutes - a.endMinutes);

  if (completedBefore.length > 0) {
    const previous = completedBefore[0];
    return {
      suggestedOrigin: "appointment",
      previousAppointment: previous,
      previousCustomerName: previous.customerName,
    };
  }

  return {
    suggestedOrigin: "home",
    previousAppointment: null,
  };
}

export interface ServiceDocumentation {
  serviceType: ServiceType;
  plannedDuration: number;
  actualDuration: number | null;
  details: string | null;
}

export function getServicesToDocument(appointment: Appointment): ServiceDocumentation[] {
  const services: ServiceDocumentation[] = [];
  
  if (appointment.hauswirtschaftDauer) {
    services.push({
      serviceType: "Hauswirtschaft",
      plannedDuration: appointment.hauswirtschaftDauer,
      actualDuration: appointment.hauswirtschaftActualDauer,
      details: appointment.hauswirtschaftDetails,
    });
  }
  
  if (appointment.alltagsbegleitungDauer) {
    services.push({
      serviceType: "Alltagsbegleitung",
      plannedDuration: appointment.alltagsbegleitungDauer,
      actualDuration: appointment.alltagsbegleitungActualDauer,
      details: appointment.alltagsbegleitungDetails,
    });
  }
  
  return services;
}

export function validateServiceDocumentation(
  appointment: Appointment,
  hauswirtschaftActualDauer: number | null | undefined,
  hauswirtschaftDetails: string | null | undefined,
  alltagsbegleitungActualDauer: number | null | undefined,
  alltagsbegleitungDetails: string | null | undefined
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (appointment.hauswirtschaftDauer) {
    if (!hauswirtschaftActualDauer || hauswirtschaftActualDauer < 1) {
      errors.push("Bitte geben Sie die tatsächliche Dauer für Hauswirtschaft an");
    }
    if (hauswirtschaftDetails && hauswirtschaftDetails.length > 55) {
      errors.push("Hauswirtschaft Details dürfen maximal 55 Zeichen haben");
    }
  }
  
  if (appointment.alltagsbegleitungDauer) {
    if (!alltagsbegleitungActualDauer || alltagsbegleitungActualDauer < 1) {
      errors.push("Bitte geben Sie die tatsächliche Dauer für Alltagsbegleitung an");
    }
    if (alltagsbegleitungDetails && alltagsbegleitungDetails.length > 55) {
      errors.push("Alltagsbegleitung Details dürfen maximal 55 Zeichen haben");
    }
  }
  
  return { valid: errors.length === 0, errors };
}
