import type { Appointment, Customer } from "../schema";

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
  assignedEmployeeName?: string | null;
  isLocked?: boolean;
  isMonthClosed?: boolean;
  lockedReason?: string;
  /**
   * Abgeleitetes Label aus `appointment_services` + `services.lohnart_kategorie`
   * (z.B. "Hauswirtschaft", "Alltagsbegleitung",
   * "Hauswirtschaft & Alltagsbegleitung"). Ersetzt die mit Task #396 entfernte
   * Spalte `appointments.service_type` und wird ausschließlich serverseitig
   * via SQL berechnet (siehe `server/storage/appointment-helpers.ts`).
   */
  serviceType: string | null;
}

interface CoverageUncoveredCustomer {
  id: number;
  name: string;
  role: string;
  primaryEmployeeName?: string;
}

interface CoverageMonthData {
  label: string;
  year: number;
  month: number;
  uncoveredCustomers: CoverageUncoveredCustomer[];
}

export interface CoverageCheckResponse {
  currentMonth: CoverageMonthData;
  nextMonth: CoverageMonthData;
}
