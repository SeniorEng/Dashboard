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
 * - @shared/api/*          → API-Response-Typen
 * - @shared/types.ts       → Re-Exports (diese Datei)
 */

// ============================================
// RE-EXPORTS FROM DOMAIN/APPOINTMENTS
// ============================================

export {
  // Types
  type AppointmentStatus,
  type ServiceType,
  type TravelOriginType,
  type ServiceInfo,
  // Constants
  PFLEGEGRAD_OPTIONS,
  DURATION_OPTIONS,
  STATUS_LABELS,
  STATUS_COLORS,
  STATUS_PRIORITY,
  SERVICE_TYPE_COLORS,
  // Time formatting utilities
  formatTimeSlot,
  formatDuration,
  // Time comparison
  doTimesOverlap,
  getEndTime,
  // Service helpers
  getCardServiceInfoFromAppointment,
  validateServiceDocumentationFromServices,
  // Status helpers
  isValidStatusTransition,
  canModifyAppointment,
  canEditNotes,
  getStatusColor,
  getStatusLabel,
  getAppointmentTypeColor,
  getServiceColor,
  // Travel helpers
  suggestTravelOrigin,
} from "./domain/appointments";

// ============================================
// RE-EXPORTS FROM API TYPES
// ============================================

export type { AppointmentWithCustomer } from "./api/appointments";
export type { PaginatedResult } from "./api/pagination";
export type { MissingBreakDay, OpenTasksSummary } from "./api/labor-law";
export type { BirthdayEntry } from "./api/birthdays";
