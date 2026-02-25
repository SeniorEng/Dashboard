/**
 * Zentrale Typen-Exports für CareConnect
 * 
 * Diese Datei dient als Haupt-Import-Punkt für Frontend-Komponenten.
 * Sie re-exportiert Typen und Funktionen aus spezialisierten Modulen.
 * 
 * Struktur:
 * - @shared/schema.ts      → Datenbank-Schemas, Drizzle-Typen, Zod-Validierung
 * - @shared/domain/*       → Business-Logik und Domain-Typen
 * - @shared/utils/*        → Utility-Funktionen (datetime, phone, etc.)
 * - @shared/types.ts       → API-Response-Typen und Re-Exports (diese Datei)
 */

import type { Appointment, Customer } from "./schema";

// ============================================
// RE-EXPORTS FROM DOMAIN/APPOINTMENTS
// ============================================

export {
  // Types
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
  // Constants
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
  // Time formatting utilities
  formatTimeSlot,
  formatDuration,
  // Time comparison
  doTimesOverlap,
  calculateTotalDurationFromServices,
  getEndTime,
  // Service helpers
  getServiceInfoFromServices,
  getCardServiceInfoFromAppointment,
  getCardServiceInfoFromServices,
  validateServiceDocumentationFromServices,
  // Status helpers
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
  // Travel helpers
  suggestTravelOrigin,
} from "./domain/appointments";

// ============================================
// API RESPONSE TYPES
// ============================================

/**
 * Termin mit verknüpftem Kunden (für Listen-Anzeige)
 */
export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
}

/**
 * Payload für Termin-Updates
 * @deprecated Verwende stattdessen die Zod-Schemas aus schema.ts
 */
export interface UpdateAppointmentPayload {
  status?: "scheduled" | "in-progress" | "documenting" | "completed" | "cancelled";
  actualStart?: string;
  actualEnd?: string;
  notes?: string;
  servicesDone?: string[];
  signatureData?: string;
}

// ============================================
// PAGINATION
// ============================================

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================
// LABOR LAW TYPES
// ============================================

export interface MissingBreakDay {
  date: string;
  totalWorkMinutes: number;
  requiredBreakMinutes: number;
  documentedBreakMinutes: number;
}

export interface OpenTasksSummary {
  daysWithMissingBreaks: MissingBreakDay[];
}

// ============================================
// BIRTHDAY TYPES
// ============================================

export interface BirthdayEntry {
  id: number;
  type: "employee" | "customer";
  name: string;
  geburtsdatum: string;
  daysUntil: number;
  age: number;
  cardSent?: boolean;
  cardSentAt?: string | null;
}

