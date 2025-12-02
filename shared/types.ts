import type { Appointment, Customer } from "./schema";
export {
  type AppointmentStatus,
  type AppointmentType,
  type ServiceType,
  type TravelOriginType,
  type Pflegegrad,
  type DurationOption,
  type ServiceOption,
  type ServiceInfo,
  type CardServiceInfo,
  type TravelOriginSuggestion,
  type ServiceDocumentation,
  APPOINTMENT_TYPES,
  APPOINTMENT_STATUSES,
  SERVICE_TYPES,
  TRAVEL_ORIGIN_TYPES,
  PFLEGEGRAD_OPTIONS,
  DURATION_OPTIONS,
  SERVICE_OPTIONS,
  STATUS_ORDER,
  STATUS_LABELS,
  STATUS_COLORS,
  STATUS_PRIORITY,
  APPOINTMENT_TYPE_COLORS,
  SERVICE_TYPE_COLORS,
  SERVICE_BORDER_COLORS,
  timeToMinutes,
  minutesToTime,
  addMinutesToTime,
  formatTimeSlot,
  formatDuration,
  doTimesOverlap,
  calculateTotalDuration,
  getEndTime,
  getServiceInfo,
  getCardServiceInfo,
  isValidStatusTransition,
  canModifyAppointment,
  canEditSchedulingFields,
  canEditDocumentationFields,
  canEditNotes,
  getStatusColor,
  getStatusLabel,
  getAppointmentTypeColor,
  getServiceColor,
  getServiceBorderColor,
  suggestTravelOrigin,
  getServicesToDocument,
  validateServiceDocumentation,
} from "./domain/appointments";

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
}

export interface UpdateAppointmentPayload {
  status?: "scheduled" | "in-progress" | "documenting" | "completed";
  actualStart?: Date;
  actualEnd?: Date;
  kilometers?: string;
  notes?: string;
  servicesDone?: string[];
  signatureData?: string;
}

export function getServiceTypeFromDurations(
  hauswirtschaftDauer: number | null | undefined,
  alltagsbegleitungDauer: number | null | undefined
): "Hauswirtschaft" | "Alltagsbegleitung" | null {
  if (hauswirtschaftDauer && alltagsbegleitungDauer) {
    return "Hauswirtschaft";
  }
  if (hauswirtschaftDauer) return "Hauswirtschaft";
  if (alltagsbegleitungDauer) return "Alltagsbegleitung";
  return null;
}
