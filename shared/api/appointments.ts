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
  /**
   * Task #1736 — Zwei-Kräfte-Einsatz (Co-Visit): der reine Anzeige-NAME der
   * zweiten Kraft (Partner-Leg mit gleicher `coVisitGroupId`). Serverseitig aus
   * dem Partner-Leg abgeleitet (kein persistiertes Feld), damit sowohl Admins
   * ALS AUCH die am Einsatz beteiligte Kraft den Partner erkennen. Streng auf
   * den Namen begrenzt — er erweitert NICHT den Sichtbarkeits-/Doku-Scope.
   * NULL bei Einzelterminen (keine `coVisitGroupId`).
   */
  coVisitPartnerName?: string | null;
}

/**
 * Task #707 — Pro geplantem Kundentermin: passt er im eigenen Monat noch in das
 * verfügbare §45b-Kontingent? Wird vom Endpoint `GET /api/appointments/budget-fit`
 * geliefert und am Termin (Liste + Detail) als Warn-Indikator angezeigt.
 */
export interface AppointmentBudgetFit {
  appointmentId: number;
  date: string;
  plannedCostCents: number;
  /** false ⇒ der Termin hebt den kumulierten §45b-Verbrauch über die Allokation. */
  fitsInMonthlyBudget: boolean;
  /** Fehlbetrag in Cent zum Zeitpunkt, an dem dieser Termin gebucht würde (0 = passt). */
  shortfallCents: number;
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
