import type { Appointment, Customer } from "./schema";

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed";

export type AppointmentType = "Erstberatung" | "Kundentermin";

export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung";

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
}

export interface UpdateAppointmentPayload {
  status?: AppointmentStatus;
  actualStart?: Date;
  actualEnd?: Date;
  kilometers?: string;
  notes?: string;
  servicesDone?: string[];
  signatureData?: string;
}

export const APPOINTMENT_TYPES: AppointmentType[] = [
  "Erstberatung",
  "Kundentermin"
];

export const SERVICE_TYPES: ServiceType[] = [
  "Hauswirtschaft",
  "Alltagsbegleitung"
];

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

// Helper to calculate total duration for a Kundentermin
// Returns the sum of service durations, throws error if both are empty
export function calculateTotalDuration(
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined,
  allowEmpty: boolean = false
): number {
  const total = (hauswirtschaftDauer || 0) + (alltagsbegleitungDauer || 0);
  if (!allowEmpty && total === 0) {
    throw new Error("Mindestens ein Service mit Dauer muss ausgewählt werden");
  }
  return total;
}

// Helper to determine service type display
export function getServiceTypeFromDurations(
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined
): ServiceType | null {
  if (hauswirtschaftDauer && alltagsbegleitungDauer) {
    return "Hauswirtschaft"; // Both - show first one
  }
  if (hauswirtschaftDauer) return "Hauswirtschaft";
  if (alltagsbegleitungDauer) return "Alltagsbegleitung";
  return null;
}

// Time slot helpers
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

export function addMinutesToTime(time: string, minutesToAdd: number): string {
  const totalMinutes = timeToMinutes(time) + minutesToAdd;
  return minutesToTime(totalMinutes);
}

// Check if two time ranges overlap
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
  
  // Two ranges overlap if one starts before the other ends
  return s1 < e2 && s2 < e1;
}
