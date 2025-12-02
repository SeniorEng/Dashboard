import type { Appointment, Customer } from "./schema";

export type AppointmentStatus = "scheduled" | "in-progress" | "documenting" | "completed";

export type AppointmentType = "First Visit" | "Customer Appointment" | "Hauswirtschaft" | "Alltagsbegleitung";

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
  "First Visit",
  "Customer Appointment", 
  "Hauswirtschaft",
  "Alltagsbegleitung"
];

export const SERVICE_OPTIONS = [
  "Vital Signs Check",
  "Medication Administered", 
  "Personal Hygiene",
  "Meal Preparation",
  "Housekeeping",
  "Social Activity"
] as const;

export type ServiceOption = typeof SERVICE_OPTIONS[number];
