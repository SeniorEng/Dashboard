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
