import { 
  type Customer, 
  type InsertCustomer, 
  type Appointment, 
  type InsertAppointment,
  type UpdateAppointment,
  type MonthlyServiceRecord,
  type InsertServiceRecord,
  type Invoice,
  type InvoiceLineItem,
  type SystemSettings,
  type CompanySettings,
  monthlyServiceRecords,
  users,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { eq } from "drizzle-orm";
import { db } from "./lib/db";
import { decryptRow, encryptRow } from "./lib/encrypted-row";

import * as customersStorage from "./storage/customers-storage";
import * as appointmentsStorage from "./storage/appointments-storage";
import * as serviceRecordsStorage from "./storage/service-records-storage";
import * as billingStorage from "./storage/billing-storage";

export interface AppointmentServiceWithDetails {
  id: number;
  serviceId: number;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
  serviceName: string;
  serviceCode: string | null;
  serviceUnitType: string;
}

export interface InvoiceWithCustomer extends Invoice {
  // Achtung: überschreibt das gleichnamige Invoice-Snapshot-Feld mit dem
  // aktuellen Kundennamen aus dem JOIN. Vorname/Nachname werden separat
  // projiziert, damit die UI „Vor- und Nachname" sauber anzeigen kann.
  customerName: string;
  customerVorname: string | null;
  customerNachname: string | null;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

import type { PaginatedResult } from "@shared/types";

export interface SearchOptions {
  query: string;
  assignedCustomerIds?: number[];
  limit?: number;
}

export interface IStorage {
  // Customers
  getCustomers(options?: { status?: string; search?: string }): Promise<Customer[]>;
  getCustomersByIds(ids: number[]): Promise<Customer[]>;
  getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean })[]>;
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  deleteCustomer(id: number): Promise<boolean>;
  getAssignedCustomerIds(employeeId: number): Promise<number[]>;
  getPrimaryCustomerIds(employeeId: number): Promise<number[]>;
  getCurrentlyAssignedCustomerIds(employeeId: number): Promise<number[]>;

  // Birthday queries
  getActiveEmployeesWithBirthday(): Promise<{ id: number; displayName: string; geburtsdatum: string | null; strasse: string | null; hausnummer: string | null; plz: string | null; stadt: string | null; createdAt: Date }[]>;
  getActiveCustomersWithBirthday(): Promise<{ id: number; name: string; geburtsdatum: string | null; strasse: string | null; hausnummer: string | null; plz: string | null; stadt: string | null; primaryEmployeeId: number | null; backupEmployeeId: number | null; backupEmployeeId2: number | null; createdAt: Date }[]>;
  getAdminUserIds(): Promise<number[]>;
  
  // Optimized search
  searchCustomers(options: SearchOptions): Promise<Customer[]>;
  searchAppointmentsWithCustomers(options: SearchOptions): Promise<AppointmentWithCustomer[]>;
  
  // Appointments - Basic
  getAppointments(): Promise<Appointment[]>;
  getAppointment(id: number): Promise<Appointment | undefined>;
  getAppointmentIncludeDeleted(id: number): Promise<Appointment | undefined>;
  createAppointment(appointment: InsertAppointment): Promise<Appointment>;
  updateAppointment(id: number, appointment: UpdateAppointment, tx?: import("./lib/db").DbOrTx): Promise<Appointment | undefined>;
  deleteAppointment(id: number): Promise<boolean>;
  getAppointmentsByDate(date: string): Promise<Appointment[]>;
  
  // Appointments - Counts
  getAppointmentCountsByDates(dates: string[], customerIds?: number[], employeeId?: number, assignedOnly?: boolean): Promise<Record<string, number>>;

  // Appointments - With Customer (optimized)
  getAppointmentsWithCustomers(date?: string, customerIds?: number[], employeeId?: number, assignedOnly?: boolean): Promise<AppointmentWithCustomer[]>;
  getAppointmentsWithCustomersPaginated(
    date?: string, 
    options?: PaginationOptions
  ): Promise<PaginatedResult<AppointmentWithCustomer>>;
  getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined>;
  getUndocumentedAppointments(today: string, customerIds?: number[], employeeId?: number, assignedOnly?: boolean, nowTime?: string): Promise<AppointmentWithCustomer[]>;
  getPlannedConsultations(filter: "overdue" | "upcoming" | "all", today: string): Promise<AppointmentWithCustomer[]>;
  
  // Get appointments for a specific employee on a specific day
  getAppointmentsForDay(employeeId: number, date: string): Promise<AppointmentWithCustomer[]>;
  
  // Monthly Service Records (Leistungsnachweise)
  getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number, customerId?: number): Promise<MonthlyServiceRecord[]>;
  getServiceRecordsForCustomer(customerId: number): Promise<MonthlyServiceRecord[]>;
  getServiceRecord(id: number): Promise<MonthlyServiceRecord | undefined>;
  getServiceRecordByPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<MonthlyServiceRecord | undefined>;
  createServiceRecord(record: InsertServiceRecord): Promise<MonthlyServiceRecord>;
  signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer', userId?: number, signingIp?: string | null, signingLocation?: string | null): Promise<MonthlyServiceRecord | undefined>;
  updateServiceRecord(id: number, data: Partial<typeof monthlyServiceRecords.$inferInsert>): Promise<MonthlyServiceRecord | undefined>;
  getAppointmentsForServiceRecord(serviceRecordId: number): Promise<AppointmentWithCustomer[]>;
  addAppointmentsToServiceRecord(serviceRecordId: number, appointmentIds: number[]): Promise<void>;
  getDocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<AppointmentWithCustomer[]>;
  getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<AppointmentWithCustomer[]>;
  getPendingServiceRecords(employeeId: number): Promise<MonthlyServiceRecord[]>;
  isAppointmentLocked(appointmentId: number): Promise<boolean>;
  getAppointmentIdsInServiceRecords(appointmentIds: number[]): Promise<number[]>;
  getServiceRecordForAppointment(appointmentId: number): Promise<MonthlyServiceRecord | undefined>;
  
  // Optimized overview query
  getServiceRecordsOverview(employeeId: number, year: number, month: number): Promise<ServiceRecordOverviewItem[]>;
  
  // Optimized period check - counts only
  getAppointmentCountsForPeriod(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<{ documentedCount: number; undocumentedCount: number }>;
  getCoveredBySingleCount(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<number>;
  getCoveredByMonthlyCount(customerId: number, employeeId: number, year: number, month: number, isPrimary?: boolean): Promise<number>;

  // Appointment Services
  getAppointmentServices(appointmentId: number): Promise<AppointmentServiceWithDetails[]>;
  getBatchAppointmentServices(appointmentIds: number[]): Promise<Record<number, AppointmentServiceWithDetails[]>>;
  createAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void>;
  replaceAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void>;
  updateAppointmentServiceDocumentation(appointmentId: number, serviceUpdates: { serviceId: number; actualDurationMinutes: number; details?: string | null }[], tx?: import("./lib/db").DbOrTx): Promise<void>;
  getServicesByIds(serviceIds: number[]): Promise<{ id: number; code: string }[]>;

  // User Onboarding
  updateUserOnboarding(userId: number): Promise<void>;
  resetUserOnboarding(userId: number): Promise<void>;

  // System Settings
  getSystemSettings(): Promise<SystemSettings>;
  updateSystemSettings(id: number, data: Partial<SystemSettings>, userId: number): Promise<SystemSettings>;

  // Company Settings
  getCompanySettings(): Promise<CompanySettings>;
  updateCompanySettings(data: Partial<CompanySettings>, userId: number): Promise<CompanySettings>;

  // Billing / Invoices
  getInvoices(filters: { year?: number; month?: number; customerId?: number; status?: string }): Promise<InvoiceWithCustomer[]>;
  getInvoice(id: number): Promise<InvoiceWithCustomer | undefined>;
  createInvoice(data: Record<string, unknown>, lineItems: Record<string, unknown>[], userId: number): Promise<Invoice>;
  updateInvoiceStatus(id: number, status: string, userId: number): Promise<Invoice>;
  getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]>;
  getInvoicesForCustomerMonth(customerId: number, year: number, month: number): Promise<Invoice[]>;
}

export interface ServiceRecordOverviewItem {
  customerId: number;
  customerName: string;
  existingRecordId: number | null;
  existingRecordStatus: string | null;
  singleRecords: { id: number; status: string; recordType: string }[];
  documentedCount: number;
  undocumentedCount: number;
  totalAppointments: number;
  coveredBySingleCount: number;
  coveredByMonthlyCount: number;
}

class DatabaseStorage implements IStorage {
  // Customers
  getCustomers = customersStorage.getCustomers;
  getCustomer = customersStorage.getCustomer;
  createCustomer = customersStorage.createCustomer;
  deleteCustomer = customersStorage.deleteCustomer;
  getCurrentlyAssignedCustomerIds = customersStorage.getCurrentlyAssignedCustomerIds;
  getAssignedCustomerIds = customersStorage.getAssignedCustomerIds;
  getPrimaryCustomerIds = customersStorage.getPrimaryCustomerIds;
  getCustomersForEmployee = customersStorage.getCustomersForEmployee;
  getCustomersByIds = customersStorage.getCustomersByIds;
  getActiveEmployeesWithBirthday = customersStorage.getActiveEmployeesWithBirthday;
  getActiveCustomersWithBirthday = customersStorage.getActiveCustomersWithBirthday;
  getAdminUserIds = customersStorage.getAdminUserIds;
  searchCustomers = customersStorage.searchCustomers;
  searchAppointmentsWithCustomers = customersStorage.searchAppointmentsWithCustomers;

  // Appointments
  getAppointments = appointmentsStorage.getAppointments;
  getAppointment = appointmentsStorage.getAppointment;
  getAppointmentIncludeDeleted = appointmentsStorage.getAppointmentIncludeDeleted;
  getAppointmentsByDate = appointmentsStorage.getAppointmentsByDate;
  getAppointmentCountsByDates = appointmentsStorage.getAppointmentCountsByDates;
  createAppointment = appointmentsStorage.createAppointment;
  updateAppointment = appointmentsStorage.updateAppointment;
  deleteAppointment = appointmentsStorage.deleteAppointment;
  getAppointmentsWithCustomers = appointmentsStorage.getAppointmentsWithCustomers;
  getAppointmentsWithCustomersPaginated = appointmentsStorage.getAppointmentsWithCustomersPaginated;
  getAppointmentWithCustomer = appointmentsStorage.getAppointmentWithCustomer;
  getUndocumentedAppointments = appointmentsStorage.getUndocumentedAppointments;
  getPlannedConsultations = appointmentsStorage.getPlannedConsultations;
  getAppointmentsForDay = appointmentsStorage.getAppointmentsForDay;
  getAppointmentServices = appointmentsStorage.getAppointmentServices;
  getBatchAppointmentServices = appointmentsStorage.getBatchAppointmentServices;
  createAppointmentServices = appointmentsStorage.createAppointmentServices;
  replaceAppointmentServices = appointmentsStorage.replaceAppointmentServices;
  updateAppointmentServiceDocumentation = appointmentsStorage.updateAppointmentServiceDocumentation;
  getServicesByIds = appointmentsStorage.getServicesByIds;

  // Service Records
  getServiceRecordsForEmployee = serviceRecordsStorage.getServiceRecordsForEmployee;
  getServiceRecordsForCustomer = serviceRecordsStorage.getServiceRecordsForCustomer;
  getServiceRecord = serviceRecordsStorage.getServiceRecord;
  getServiceRecordByPeriod = serviceRecordsStorage.getServiceRecordByPeriod;
  createServiceRecord = serviceRecordsStorage.createServiceRecord;
  signServiceRecord = serviceRecordsStorage.signServiceRecord;
  updateServiceRecord = serviceRecordsStorage.updateServiceRecord;
  getAppointmentsForServiceRecord = serviceRecordsStorage.getAppointmentsForServiceRecord;
  addAppointmentsToServiceRecord = serviceRecordsStorage.addAppointmentsToServiceRecord;
  getDocumentedAppointmentsForPeriod = serviceRecordsStorage.getDocumentedAppointmentsForPeriod;
  getUndocumentedAppointmentsForPeriod = serviceRecordsStorage.getUndocumentedAppointmentsForPeriod;
  getPendingServiceRecords = serviceRecordsStorage.getPendingServiceRecords;
  getAppointmentIdsInServiceRecords = serviceRecordsStorage.getAppointmentIdsInServiceRecords;
  getServiceRecordForAppointment = serviceRecordsStorage.getServiceRecordForAppointment;
  isAppointmentLocked = serviceRecordsStorage.isAppointmentLocked;
  getServiceRecordsOverview = serviceRecordsStorage.getServiceRecordsOverview;
  getAppointmentCountsForPeriod = serviceRecordsStorage.getAppointmentCountsForPeriod;
  getCoveredBySingleCount = serviceRecordsStorage.getCoveredBySingleCount;
  getCoveredByMonthlyCount = serviceRecordsStorage.getCoveredByMonthlyCount;

  // Billing
  getInvoices = billingStorage.getInvoices;
  getInvoice = billingStorage.getInvoice;
  createInvoice = billingStorage.createInvoice;
  updateInvoiceStatus = billingStorage.updateInvoiceStatus;
  getInvoiceLineItems = billingStorage.getInvoiceLineItems;
  getInvoicesForCustomerMonth = billingStorage.getInvoicesForCustomerMonth;

  // User Onboarding
  async updateUserOnboarding(userId: number): Promise<void> {
    await db.update(users).set({ onboardingCompleted: true }).where(eq(users.id, userId));
  }

  async resetUserOnboarding(userId: number): Promise<void> {
    await db.update(users).set({ onboardingCompleted: false }).where(eq(users.id, userId));
  }

  // System Settings
  async getSystemSettings(): Promise<SystemSettings> {
    const { systemSettings } = await import("@shared/schema");
    const existing = await db.select().from(systemSettings).limit(1);
    if (existing.length > 0) return existing[0];
    const [created] = await db.insert(systemSettings).values({ autoBreaksEnabled: true }).returning();
    return created;
  }

  async updateSystemSettings(id: number, data: Partial<SystemSettings>, userId: number): Promise<SystemSettings> {
    const { systemSettings } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [updated] = await db.update(systemSettings).set({ ...data, updatedAt: new Date(), updatedByUserId: userId }).where(eq(systemSettings.id, id)).returning();
    return updated;
  }

  // Company Settings
  private companySettingsCache: { data: CompanySettings; expiresAt: number } | null = null;
  private static COMPANY_SETTINGS_TTL_MS = 5 * 60 * 1000;

  async getCompanySettings(): Promise<CompanySettings> {
    if (this.companySettingsCache && Date.now() < this.companySettingsCache.expiresAt) {
      return this.companySettingsCache.data;
    }
    const { companySettings } = await import("@shared/schema");
    const existing = await db.select().from(companySettings).limit(1);
    const raw = existing.length > 0
      ? existing[0]
      : (await db.insert(companySettings).values({}).returning())[0];
    const result = decryptRow(companySettings, raw);
    this.companySettingsCache = {
      data: result,
      expiresAt: Date.now() + DatabaseStorage.COMPANY_SETTINGS_TTL_MS,
    };
    return result;
  }

  async updateCompanySettings(data: Partial<CompanySettings>, userId: number): Promise<CompanySettings> {
    this.companySettingsCache = null;
    const { companySettings } = await import("@shared/schema");
    const encryptedData = encryptRow(companySettings, data);
    const existing = await db.select().from(companySettings).limit(1);
    if (existing.length === 0) {
      const [created] = await db.insert(companySettings).values({ ...encryptedData, updatedByUserId: userId }).returning();
      const decrypted = decryptRow(companySettings, created);
      this.companySettingsCache = {
        data: decrypted,
        expiresAt: Date.now() + DatabaseStorage.COMPANY_SETTINGS_TTL_MS,
      };
      return decrypted;
    }
    const { eq } = await import("drizzle-orm");
    const [updated] = await db.update(companySettings)
      .set({ ...encryptedData, updatedAt: new Date(), updatedByUserId: userId })
      .where(eq(companySettings.id, existing[0].id))
      .returning();
    const decrypted = decryptRow(companySettings, updated);
    this.companySettingsCache = {
      data: decrypted,
      expiresAt: Date.now() + DatabaseStorage.COMPANY_SETTINGS_TTL_MS,
    };
    return decrypted;
  }
}

export const storage = new DatabaseStorage();
