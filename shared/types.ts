import type { Appointment, Customer } from "./schema";

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed";

export type AppointmentType = "Erstberatung" | "Kundentermin";

export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung";

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
}

export interface UpdateAppointmentPayload {
  status?: AppointmentStatus;
  startTime?: Date;
  endTime?: Date;
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

export const SERVICE_OPTIONS = [
  "Vitalzeichen prüfen",
  "Medikamente verabreicht", 
  "Körperpflege",
  "Mahlzeit zubereitet",
  "Haushaltsarbeiten",
  "Soziale Aktivität"
] as const;

export type ServiceOption = typeof SERVICE_OPTIONS[number];

export function getDisplayLabel(appointment: { appointmentType: string; serviceType: string | null }): string {
  if (appointment.appointmentType === "Erstberatung") {
    return "Erstberatung";
  }
  if (appointment.serviceType) {
    return appointment.serviceType;
  }
  return "Kundentermin";
}
