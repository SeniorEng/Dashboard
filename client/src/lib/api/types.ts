/**
 * API Response Types
 * 
 * Centralized type definitions for API responses.
 * These types ensure consistency between frontend and backend.
 */

import type { 
  Customer, 
  Appointment, 
  User,
  InsuranceProvider,
  CustomerContact,
  CustomerCareLevelHistory,
  CustomerBudget,
  CustomerContract,
  EmployeeRole,
} from "@shared/schema";

// ============================================
// PAGINATION
// ============================================

export interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
  offset: number;
}

// ============================================
// AUTH
// ============================================

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  isAdmin: boolean;
  isActive: boolean;
  roles: EmployeeRole[];
}

export interface AuthResponse {
  user: AuthUser;
  availableServices: string[];
}

export interface LoginRequest {
  email: string;
  password: string;
}

// ============================================
// EMPLOYEES
// ============================================

export interface EmployeeListItem {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  isActive: boolean;
  isAdmin: boolean;
  roles: EmployeeRole[];
  createdAt: string;
}

// ============================================
// CUSTOMERS
// ============================================

export interface CustomerListItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  email: string | null;
  telefon: string | null;
  address: string | null;
  stadt: string | null;
  pflegegrad: number | null;
  primaryEmployee: { displayName: string } | null;
  hasActiveContract: boolean;
  createdAt: string;
}

export interface CustomerListParams extends PaginationParams {
  pflegegrad?: string;
  primaryEmployeeId?: string;
}

export interface CustomerDetail extends Customer {
  currentInsurance: {
    id: number;
    providerName: string;
    versichertennummer: string;
    validFrom: string;
  } | null;
  contacts: CustomerContactItem[];
  careLevelHistory: CustomerCareLevelHistoryItem[];
  currentBudgets: CustomerBudgetsInfo | null;
  activeContractCount: number;
}

export interface CustomerContactItem {
  id: number;
  contactType: string;
  isPrimary: boolean;
  vorname: string;
  nachname: string;
  telefon: string;
  email: string | null;
  notes: string | null;
}

export interface CustomerCareLevelHistoryItem {
  id: number;
  pflegegrad: number;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
}

export interface CustomerBudgetsInfo {
  entlastungsbetrag45b: number;
  verhinderungspflege39: number;
  pflegesachleistungen36: number;
}

export interface CreateCustomerRequest {
  vorname: string;
  nachname: string;
  telefon?: string;
  festnetz?: string;
  email?: string;
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  pflegegrad?: number;
  pflegegradSeit?: string;
  insurance?: {
    providerId: number;
    versichertennummer: string;
    validFrom: string;
  };
  contacts?: Array<{
    contactType: string;
    isPrimary: boolean;
    vorname: string;
    nachname: string;
    telefon: string;
    email?: string;
    notes?: string;
  }>;
  budgets?: {
    entlastungsbetrag45b: number;
    verhinderungspflege39: number;
    pflegesachleistungen36: number;
    validFrom: string;
  };
  contract?: {
    contractStart: string;
    hoursPerPeriod: number;
    periodType: string;
    rates?: Array<{
      serviceCategory: string;
      hourlyRateCents: number;
    }>;
  };
}

// ============================================
// APPOINTMENTS
// ============================================

export interface AppointmentWithCustomer extends Appointment {
  customer: Customer | null;
}

export interface CreateAppointmentRequest {
  customerId: number;
  date: string;
  scheduledStart: string;
  hauswirtschaftDauer?: number;
  alltagsbegleitungDauer?: number;
  notes?: string;
}

export interface CreateErstberatungRequest {
  customer: {
    vorname: string;
    nachname: string;
    telefon: string;
    strasse: string;
    nr: string;
    plz: string;
    stadt: string;
    pflegegrad: number;
  };
  date: string;
  scheduledStart: string;
  erstberatungDauer: number;
  notes?: string;
}

export interface UpdateAppointmentRequest {
  status?: string;
  actualStart?: string;
  actualEnd?: string;
  date?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  hauswirtschaftDauer?: number;
  alltagsbegleitungDauer?: number;
  notes?: string;
  kilometers?: string;
  servicesDone?: string[];
  signatureData?: string;
}

export interface DocumentAppointmentRequest {
  hauswirtschaftActualDauer?: number | null;
  hauswirtschaftDetails?: string | null;
  alltagsbegleitungActualDauer?: number | null;
  alltagsbegleitungDetails?: string | null;
  erstberatungActualDauer?: number | null;
  erstberatungDetails?: string | null;
  travelOriginType: 'home' | 'appointment';
  travelFromAppointmentId?: number | null;
  travelKilometers: number;
  travelMinutes?: number | null;
  notes?: string | null;
}

// ============================================
// INSURANCE
// ============================================

export interface InsuranceProviderItem {
  id: number;
  name: string;
  ikNummer: string;
}

// ============================================
// TIME TRACKING
// ============================================

export type TimeEntryType = 
  | "urlaub"
  | "krankheit"
  | "pause"
  | "bueroarbeit"
  | "vertrieb"
  | "schulung"
  | "besprechung"
  | "sonstiges";

export interface TimeEntry {
  id: number;
  userId: number;
  entryType: TimeEntryType;
  entryDate: string;
  startTime: string | null;
  endTime: string | null;
  isFullDay: boolean;
  durationMinutes: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntryWithUser extends TimeEntry {
  user: {
    displayName: string;
  };
}

export interface CreateTimeEntryRequest {
  entryType: TimeEntryType;
  entryDate: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  isFullDay?: boolean;
  durationMinutes?: number | null;
  notes?: string | null;
}

export interface UpdateTimeEntryRequest extends Partial<CreateTimeEntryRequest> {}

export interface VacationSummary {
  year: number;
  totalDays: number;
  carryOverDays: number;
  usedDays: number;
  plannedDays: number;
  remainingDays: number;
  sickDays: number;
}

export interface AppointmentWithCustomerName {
  id: number;
  customerId: number;
  createdByUserId: number | null;
  appointmentType: string;
  serviceType: string | null;
  hauswirtschaftDauer: number | null;
  alltagsbegleitungDauer: number | null;
  erstberatungDauer: number | null;
  hauswirtschaftActualDauer: number | null;
  hauswirtschaftDetails: string | null;
  alltagsbegleitungActualDauer: number | null;
  alltagsbegleitungDetails: string | null;
  erstberatungActualDauer: number | null;
  erstberatungDetails: string | null;
  date: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  durationPromised: number;
  actualStart: string | null;
  actualEnd: string | null;
  status: string;
  notes: string | null;
  travelOriginType: string | null;
  travelFromAppointmentId: number | null;
  travelKilometers: number | null;
  travelMinutes: number | null;
  kilometers: string | null;
  signatureData: string | null;
  servicesDone: string[] | null;
  createdAt: string;
  customerName: string;
}

export interface ServiceHoursSummary {
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  erstberatungMinutes: number;
}

export interface TravelSummary {
  totalKilometers: number;
  totalMinutes: number;
}

export interface TimeEntrySummary {
  urlaubDays: number;
  krankheitDays: number;
  pauseMinutes: number;
  bueroarbeitMinutes: number;
  vertriebMinutes: number;
  schulungMinutes: number;
  besprechungMinutes: number;
  sonstigesMinutes: number;
}

export interface TimeOverviewData {
  period: { year: number; month: number };
  serviceHours: ServiceHoursSummary;
  travel: TravelSummary;
  timeEntries: TimeEntrySummary;
  appointments: AppointmentWithCustomerName[];
  otherEntries: TimeEntry[];
}
