import { 
  type Customer, 
  type InsertCustomer, 
  type Appointment, 
  type InsertAppointment,
  type UpdateAppointment,
  type MonthlyServiceRecord,
  type InsertServiceRecord,
  type ServiceRecordStatus,
  type Invoice,
  type InvoiceLineItem,
  type SystemSettings,
  type CompanySettings,
  customers, 
  appointments,
  monthlyServiceRecords,
  serviceRecordAppointments,
  users,
} from "@shared/schema";
import { computeDataHash } from "./services/signature-integrity";
import type { AppointmentWithCustomer } from "@shared/types";
import { eq, count, sql as sqlBuilder, lt, ne, and, or, ilike, inArray, isNull, isNotNull } from "drizzle-orm";
import { customerIdsCache } from "./services/cache";
import { db } from "./lib/db";

const appointmentWithCustomerSelectFields = {
  id: appointments.id,
  customerId: appointments.customerId,
  createdByUserId: appointments.createdByUserId,
  assignedEmployeeId: appointments.assignedEmployeeId,
  appointmentType: appointments.appointmentType,
  serviceType: appointments.serviceType,
  date: appointments.date,
  scheduledStart: appointments.scheduledStart,
  scheduledEnd: appointments.scheduledEnd,
  durationPromised: appointments.durationPromised,
  status: appointments.status,
  actualStart: appointments.actualStart,
  actualEnd: appointments.actualEnd,
  travelOriginType: appointments.travelOriginType,
  travelFromAppointmentId: appointments.travelFromAppointmentId,
  travelKilometers: appointments.travelKilometers,
  travelMinutes: appointments.travelMinutes,
  customerKilometers: appointments.customerKilometers,
  notes: appointments.notes,
  servicesDone: appointments.servicesDone,
  createdAt: appointments.createdAt,
  performedByEmployeeId: appointments.performedByEmployeeId,
  customer: {
    id: customers.id,
    name: customers.name,
    vorname: customers.vorname,
    nachname: customers.nachname,
    email: customers.email,
    festnetz: customers.festnetz,
    telefon: customers.telefon,
    geburtsdatum: customers.geburtsdatum,
    address: customers.address,
    strasse: customers.strasse,
    nr: customers.nr,
    plz: customers.plz,
    stadt: customers.stadt,
    pflegegrad: customers.pflegegrad,
    primaryEmployeeId: customers.primaryEmployeeId,
    backupEmployeeId: customers.backupEmployeeId,
    needs: customers.needs,
    createdAt: customers.createdAt,
    updatedAt: customers.updatedAt,
    createdByUserId: customers.createdByUserId,
  }
};

function mapAppointmentRow(row: any): AppointmentWithCustomer {
  return {
    id: row.id,
    customerId: row.customerId,
    createdByUserId: row.createdByUserId,
    assignedEmployeeId: row.assignedEmployeeId,
    appointmentType: row.appointmentType,
    serviceType: row.serviceType,
    date: row.date,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    durationPromised: row.durationPromised,
    status: row.status,
    actualStart: row.actualStart,
    actualEnd: row.actualEnd,
    travelOriginType: row.travelOriginType,
    travelFromAppointmentId: row.travelFromAppointmentId,
    travelKilometers: row.travelKilometers,
    travelMinutes: row.travelMinutes,
    customerKilometers: row.customerKilometers,
    notes: row.notes,
    servicesDone: row.servicesDone,
    signatureData: row.signatureData ?? null,
    signatureHash: row.signatureHash ?? null,
    signedAt: row.signedAt ?? null,
    signedByUserId: row.signedByUserId ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    performedByEmployeeId: row.performedByEmployeeId,
    customer: row.customer?.id ? row.customer : null,
  };
}

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
  customerName: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchOptions {
  query: string;
  assignedCustomerIds?: number[];
  limit?: number;
}

export interface IStorage {
  // Customers
  getCustomers(): Promise<Customer[]>;
  getCustomersByIds(ids: number[]): Promise<Customer[]>;
  getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean })[]>;
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  deleteCustomer(id: number): Promise<boolean>;
  getAssignedCustomerIds(employeeId: number): Promise<number[]>;
  getCurrentlyAssignedCustomerIds(employeeId: number): Promise<number[]>;

  // Birthday queries
  getActiveEmployeesWithBirthday(): Promise<{ id: number; displayName: string; geburtsdatum: string | null }[]>;
  getActiveCustomersWithBirthday(): Promise<{ id: number; name: string; geburtsdatum: string | null }[]>;
  
  // Optimized search
  searchCustomers(options: SearchOptions): Promise<Customer[]>;
  searchAppointmentsWithCustomers(options: SearchOptions): Promise<AppointmentWithCustomer[]>;
  
  // Appointments - Basic
  getAppointments(): Promise<Appointment[]>;
  getAppointment(id: number): Promise<Appointment | undefined>;
  getAppointmentIncludeDeleted(id: number): Promise<Appointment | undefined>;
  createAppointment(appointment: InsertAppointment): Promise<Appointment>;
  updateAppointment(id: number, appointment: UpdateAppointment): Promise<Appointment | undefined>;
  deleteAppointment(id: number): Promise<boolean>;
  getAppointmentsByDate(date: string): Promise<Appointment[]>;
  
  // Appointments - Counts
  getAppointmentCountsByDates(dates: string[], customerIds?: number[]): Promise<Record<string, number>>;

  // Appointments - With Customer (optimized)
  getAppointmentsWithCustomers(date?: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]>;
  getAppointmentsWithCustomersPaginated(
    date?: string, 
    options?: PaginationOptions
  ): Promise<PaginatedResult<AppointmentWithCustomer>>;
  getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined>;
  getUndocumentedAppointments(beforeDate: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]>;
  
  // Atomic operations (with application-level rollback)
  createErstberatungWithCustomer(
    customer: InsertCustomer,
    appointment: Omit<InsertAppointment, 'customerId'>
  ): Promise<{ customer: Customer; appointment: Appointment }>;
  
  // Get appointments for a specific employee on a specific day
  getAppointmentsForDay(employeeId: number, date: string): Promise<AppointmentWithCustomer[]>;
  
  // Monthly Service Records (Leistungsnachweise)
  getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number, customerId?: number): Promise<MonthlyServiceRecord[]>;
  getServiceRecordsForCustomer(customerId: number): Promise<MonthlyServiceRecord[]>;
  getServiceRecord(id: number): Promise<MonthlyServiceRecord | undefined>;
  getServiceRecordByPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<MonthlyServiceRecord | undefined>;
  createServiceRecord(record: InsertServiceRecord): Promise<MonthlyServiceRecord>;
  signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer', userId?: number): Promise<MonthlyServiceRecord | undefined>;
  updateServiceRecord(id: number, data: Record<string, unknown>): Promise<MonthlyServiceRecord | undefined>;
  getAppointmentsForServiceRecord(serviceRecordId: number): Promise<AppointmentWithCustomer[]>;
  addAppointmentsToServiceRecord(serviceRecordId: number, appointmentIds: number[]): Promise<void>;
  getDocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]>;
  getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]>;
  getPendingServiceRecords(employeeId: number): Promise<MonthlyServiceRecord[]>;
  isAppointmentLocked(appointmentId: number): Promise<boolean>;
  
  // Optimized overview query
  getServiceRecordsOverview(employeeId: number, year: number, month: number): Promise<ServiceRecordOverviewItem[]>;
  
  // Optimized period check - counts only
  getAppointmentCountsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<{ documentedCount: number; undocumentedCount: number }>;

  // Appointment Services
  getAppointmentServices(appointmentId: number): Promise<AppointmentServiceWithDetails[]>;
  getBatchAppointmentServices(appointmentIds: number[]): Promise<Record<number, AppointmentServiceWithDetails[]>>;
  createAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void>;
  replaceAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void>;
  updateAppointmentServiceDocumentation(appointmentId: number, serviceUpdates: { serviceId: number; actualDurationMinutes: number; details?: string | null }[]): Promise<void>;
  getServicesByIds(serviceIds: number[]): Promise<{ id: number; code: string }[]>;

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
  getNextInvoiceNumber(year: number): Promise<string>;
  getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]>;
  getInvoicesForCustomerMonth(customerId: number, year: number, month: number): Promise<Invoice[]>;
}

export interface ServiceRecordOverviewItem {
  customerId: number;
  customerName: string;
  existingRecordId: number | null;
  existingRecordStatus: string | null;
  documentedCount: number;
  undocumentedCount: number;
  totalAppointments: number;
}

export class DatabaseStorage implements IStorage {
  // Customers
  async getCustomers(): Promise<Customer[]> {
    return await db.select().from(customers).where(isNull(customers.deletedAt));
  }

  async getCustomer(id: number): Promise<Customer | undefined> {
    const result = await db.select().from(customers).where(eq(customers.id, id));
    return result[0];
  }

  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const result = await db.insert(customers).values(customer).returning();
    const created = result[0];
    customerIdsCache.invalidateForCustomer(created.primaryEmployeeId, created.backupEmployeeId);
    return created;
  }

  async deleteCustomer(id: number): Promise<boolean> {
    const existing = await this.getCustomer(id);
    const result = await db
      .update(customers)
      .set({ deletedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    if (result.length > 0 && existing) {
      customerIdsCache.invalidateForCustomer(existing.primaryEmployeeId, existing.backupEmployeeId);
    }
    return result.length > 0;
  }
  
  async getCurrentlyAssignedCustomerIds(employeeId: number): Promise<number[]> {
    const result = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          isNull(customers.deletedAt),
          sqlBuilder`(${customers.primaryEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId} = ${employeeId})`
        )
      );
    return result.map(r => r.id);
  }

  async getAssignedCustomerIds(employeeId: number): Promise<number[]> {
    const cached = customerIdsCache.get(employeeId);
    if (cached !== undefined) {
      return cached;
    }
    
    const result = await db
      .selectDistinct({ id: customers.id })
      .from(customers)
      .where(
        and(
          isNull(customers.deletedAt),
          or(
            eq(customers.primaryEmployeeId, employeeId),
            eq(customers.backupEmployeeId, employeeId),
            inArray(customers.id,
              db.select({ id: appointments.customerId })
                .from(appointments)
                .where(
                  and(
                    or(
                      eq(appointments.assignedEmployeeId, employeeId),
                      eq(appointments.performedByEmployeeId, employeeId)
                    ),
                    isNull(appointments.deletedAt)
                  )
                )
            )
          )
        )
      );
    
    const ids = result.map(r => r.id);
    customerIdsCache.set(employeeId, ids);
    return ids;
  }

  async getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean })[]> {
    const assignedIds = await this.getAssignedCustomerIds(employeeId);
    if (assignedIds.length === 0) return [];

    const customerRows = await db
      .select()
      .from(customers)
      .where(and(inArray(customers.id, assignedIds), isNull(customers.deletedAt)))
      .orderBy(customers.nachname, customers.vorname);

    return customerRows.map(c => ({
      ...c,
      isCurrentlyAssigned: c.primaryEmployeeId === employeeId || c.backupEmployeeId === employeeId,
    })).sort((a, b) => {
      const aLegacy = a.isCurrentlyAssigned ? 0 : 1;
      const bLegacy = b.isCurrentlyAssigned ? 0 : 1;
      if (aLegacy !== bLegacy) return aLegacy - bLegacy;
      const nachnameCompare = (a.nachname ?? '').localeCompare(b.nachname ?? '', 'de');
      if (nachnameCompare !== 0) return nachnameCompare;
      return (a.vorname ?? '').localeCompare(b.vorname ?? '', 'de');
    });
  }

  async getCustomersByIds(ids: number[]): Promise<Customer[]> {
    if (ids.length === 0) return [];
    return await db.select().from(customers).where(inArray(customers.id, ids));
  }

  async getActiveEmployeesWithBirthday(): Promise<{ id: number; displayName: string; geburtsdatum: string | null }[]> {
    return await db
      .select({
        id: users.id,
        displayName: users.displayName,
        geburtsdatum: users.geburtsdatum,
      })
      .from(users)
      .where(and(
        eq(users.isActive, true),
        isNotNull(users.geburtsdatum)
      ));
  }

  async getActiveCustomersWithBirthday(): Promise<{ id: number; name: string; geburtsdatum: string | null }[]> {
    return await db
      .select({
        id: customers.id,
        name: customers.name,
        geburtsdatum: customers.geburtsdatum,
      })
      .from(customers)
      .where(isNotNull(customers.geburtsdatum));
  }

  async searchCustomers(options: SearchOptions): Promise<Customer[]> {
    const { query, assignedCustomerIds, limit = 5 } = options;
    if (assignedCustomerIds && assignedCustomerIds.length === 0) {
      return [];
    }
    const searchTerm = `%${query}%`;
    
    const conditions = [
      or(
        ilike(customers.name, searchTerm),
        ilike(customers.vorname, searchTerm),
        ilike(customers.nachname, searchTerm)
      )
    ];
    
    if (assignedCustomerIds) {
      conditions.push(inArray(customers.id, assignedCustomerIds));
    }
    
    return await db
      .select()
      .from(customers)
      .where(and(...conditions))
      .limit(limit);
  }

  async searchAppointmentsWithCustomers(options: SearchOptions): Promise<AppointmentWithCustomer[]> {
    const { query, assignedCustomerIds, limit = 5 } = options;
    if (assignedCustomerIds && assignedCustomerIds.length === 0) {
      return [];
    }
    const searchTerm = `%${query}%`;
    
    const conditions = [
      or(
        ilike(customers.name, searchTerm),
        ilike(customers.vorname, searchTerm),
        ilike(customers.nachname, searchTerm)
      )
    ];
    
    if (assignedCustomerIds) {
      conditions.push(inArray(appointments.customerId, assignedCustomerIds));
    }
    
    conditions.push(isNull(appointments.deletedAt));
    
    const results = await db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(...conditions))
      .limit(limit);
    
    return results.map(mapAppointmentRow);
  }

  // Appointments - Basic
  async getAppointments(): Promise<Appointment[]> {
    return await db.select().from(appointments).where(isNull(appointments.deletedAt));
  }

  async getAppointment(id: number): Promise<Appointment | undefined> {
    const result = await db.select().from(appointments).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));
    return result[0];
  }

  async getAppointmentIncludeDeleted(id: number): Promise<Appointment | undefined> {
    const result = await db.select().from(appointments).where(eq(appointments.id, id));
    return result[0];
  }

  async getAppointmentsByDate(date: string): Promise<Appointment[]> {
    return await db.select().from(appointments).where(and(eq(appointments.date, date), isNull(appointments.deletedAt)));
  }

  async getAppointmentCountsByDates(dates: string[], customerIds?: number[]): Promise<Record<string, number>> {
    if (dates.length === 0) return {};
    if (customerIds && customerIds.length === 0) return {};
    
    const conditions = [inArray(appointments.date, dates), isNull(appointments.deletedAt)];
    if (customerIds) {
      conditions.push(inArray(appointments.customerId, customerIds));
    }
    
    const results = await db
      .select({
        date: appointments.date,
        count: count(),
      })
      .from(appointments)
      .where(and(...conditions))
      .groupBy(appointments.date);
    
    const counts: Record<string, number> = {};
    for (const date of dates) {
      counts[date] = 0;
    }
    for (const row of results) {
      counts[row.date] = row.count;
    }
    return counts;
  }

  async createAppointment(appointment: InsertAppointment): Promise<Appointment> {
    const result = await db.insert(appointments).values(appointment).returning();
    if (appointment.assignedEmployeeId) {
      customerIdsCache.invalidateForEmployee(appointment.assignedEmployeeId);
    }
    return result[0];
  }

  async updateAppointment(id: number, appointment: UpdateAppointment): Promise<Appointment | undefined> {
    const result = await db.update(appointments)
      .set(appointment)
      .where(eq(appointments.id, id))
      .returning();
    return result[0];
  }

  async deleteAppointment(id: number): Promise<boolean> {
    const result = await db.update(appointments)
      .set({ deletedAt: new Date() })
      .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)))
      .returning();
    return result.length > 0;
  }

  // Appointments - With Customer (single query with LEFT JOIN for performance)
  async getAppointmentsWithCustomers(date?: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]> {
    if (customerIds && customerIds.length === 0) {
      return [];
    }
    const conditions = [isNull(appointments.deletedAt)];
    if (date) {
      conditions.push(eq(appointments.date, date));
    }
    if (customerIds) {
      conditions.push(inArray(appointments.customerId, customerIds));
    }
    
    const query = db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id));
    
    const results = conditions.length > 0 
      ? await query.where(and(...conditions))
      : await query;
    
    return results.map(mapAppointmentRow);
  }

  async getAppointmentsWithCustomersPaginated(
    date?: string,
    options?: PaginationOptions
  ): Promise<PaginatedResult<AppointmentWithCustomer>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const countResult = date
      ? await db.select({ count: count() }).from(appointments).where(and(eq(appointments.date, date), isNull(appointments.deletedAt)))
      : await db.select({ count: count() }).from(appointments).where(isNull(appointments.deletedAt));
    
    const total = Number(countResult[0]?.count ?? 0);

    let query = db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .limit(limit)
      .offset(offset);

    const results = date 
      ? await query.where(and(eq(appointments.date, date), isNull(appointments.deletedAt)))
      : await query.where(isNull(appointments.deletedAt));

    const data = results.map(mapAppointmentRow);

    return { data, total, limit, offset };
  }

  async getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined> {
    const results = await db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));
    
    if (results.length === 0) return undefined;
    
    return mapAppointmentRow(results[0]);
  }

  async getUndocumentedAppointments(beforeDate: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]> {
    if (customerIds && customerIds.length === 0) {
      return [];
    }
    const conditions = [
      lt(appointments.date, beforeDate),
      ne(appointments.status, "completed"),
      isNull(appointments.deletedAt)
    ];
    
    if (customerIds) {
      conditions.push(inArray(appointments.customerId, customerIds));
    }
    
    const results = await db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(...conditions));
    
    return results.map(mapAppointmentRow);
  }

  async createErstberatungWithCustomer(
    customerData: InsertCustomer,
    appointmentData: Omit<InsertAppointment, 'customerId'>
  ): Promise<{ customer: Customer; appointment: Appointment }> {
    return await db.transaction(async (tx) => {
      const customerResult = await tx.insert(customers).values(customerData).returning();
      const customer = customerResult[0];
      customerIdsCache.invalidateAll();

      const appointmentResult = await tx.insert(appointments).values({
        ...appointmentData,
        customerId: customer.id,
      }).returning();
      const appointment = appointmentResult[0];

      return { customer, appointment };
    });
  }

  async getAppointmentsForDay(employeeId: number, date: string): Promise<AppointmentWithCustomer[]> {
    // Get appointments where the employee is assigned OR created the appointment OR appointment is unassigned
    // This ensures overlap checking catches all relevant appointments for a user
    const rows = await db.select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(
        eq(appointments.date, date),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId),
          isNull(appointments.assignedEmployeeId)
        ),
        isNull(appointments.deletedAt)
      ))
      .orderBy(appointments.scheduledStart);
    
    return rows.map(mapAppointmentRow);
  }

  // Monthly Service Records (Leistungsnachweise)
  async getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number, customerId?: number): Promise<MonthlyServiceRecord[]> {
    let conditions = [eq(monthlyServiceRecords.employeeId, employeeId)];
    if (year !== undefined) {
      conditions.push(eq(monthlyServiceRecords.year, year));
    }
    if (month !== undefined) {
      conditions.push(eq(monthlyServiceRecords.month, month));
    }
    if (customerId !== undefined) {
      conditions.push(eq(monthlyServiceRecords.customerId, customerId));
    }
    return await db.select()
      .from(monthlyServiceRecords)
      .where(and(...conditions))
      .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
  }

  async getServiceRecordsForCustomer(customerId: number): Promise<MonthlyServiceRecord[]> {
    return await db.select()
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.customerId, customerId))
      .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
  }

  async getServiceRecord(id: number): Promise<MonthlyServiceRecord | undefined> {
    const result = await db.select()
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.id, id));
    return result[0];
  }

  async getServiceRecordByPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<MonthlyServiceRecord | undefined> {
    const result = await db.select()
      .from(monthlyServiceRecords)
      .where(and(
        eq(monthlyServiceRecords.customerId, customerId),
        eq(monthlyServiceRecords.employeeId, employeeId),
        eq(monthlyServiceRecords.year, year),
        eq(monthlyServiceRecords.month, month)
      ));
    return result[0];
  }

  async createServiceRecord(record: InsertServiceRecord): Promise<MonthlyServiceRecord> {
    const result = await db.insert(monthlyServiceRecords)
      .values({
        customerId: record.customerId,
        employeeId: record.employeeId,
        year: record.year,
        month: record.month,
        status: "pending",
      })
      .returning();
    return result[0];
  }

  async signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer', userId?: number): Promise<MonthlyServiceRecord | undefined> {
    const existing = await this.getServiceRecord(id);
    if (!existing) return undefined;

    const now = new Date();
    const hash = computeDataHash(signatureData);
    let updateData: Partial<MonthlyServiceRecord> = { updatedAt: now };

    if (signerType === 'employee') {
      if (existing.status !== 'pending') {
        throw new Error('Mitarbeiter kann nur bei Status "pending" unterschreiben');
      }
      updateData = {
        ...updateData,
        employeeSignatureData: signatureData,
        employeeSignatureHash: hash,
        employeeSignedAt: now,
        employeeSignedByUserId: userId ?? null,
        status: 'employee_signed' as ServiceRecordStatus,
      };
    } else if (signerType === 'customer') {
      if (existing.status !== 'employee_signed') {
        throw new Error('Kunde kann nur nach Mitarbeiter-Unterschrift unterschreiben');
      }
      updateData = {
        ...updateData,
        customerSignatureData: signatureData,
        customerSignatureHash: hash,
        customerSignedAt: now,
        customerSignedByUserId: userId ?? null,
        status: 'completed' as ServiceRecordStatus,
      };
    }

    const result = await db.update(monthlyServiceRecords)
      .set(updateData)
      .where(eq(monthlyServiceRecords.id, id))
      .returning();
    return result[0];
  }

  async updateServiceRecord(id: number, data: Record<string, unknown>): Promise<MonthlyServiceRecord | undefined> {
    const result = await db.update(monthlyServiceRecords)
      .set(data as any)
      .where(eq(monthlyServiceRecords.id, id))
      .returning();
    return result[0];
  }

  async getAppointmentsForServiceRecord(serviceRecordId: number): Promise<AppointmentWithCustomer[]> {
    const linkedAppointments = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, serviceRecordId));
    
    if (linkedAppointments.length === 0) return [];
    
    const appointmentIds = linkedAppointments.map(la => la.appointmentId);
    
    const rows = await db.select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(inArray(appointments.id, appointmentIds), isNull(appointments.deletedAt)))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(mapAppointmentRow);
  }

  async addAppointmentsToServiceRecord(serviceRecordId: number, appointmentIds: number[]): Promise<void> {
    if (appointmentIds.length === 0) return;
    
    const values = appointmentIds.map(appointmentId => ({
      serviceRecordId,
      appointmentId,
    }));
    
    await db.insert(serviceRecordAppointments)
      .values(values)
      .onConflictDoNothing();
  }

  async getDocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    
    const rows = await db.select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(
        eq(appointments.customerId, customerId),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        eq(appointments.status, 'completed'),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`,
        isNull(appointments.deletedAt)
      ))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(mapAppointmentRow);
  }

  async getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    
    const rows = await db.select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(
        eq(appointments.customerId, customerId),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        ne(appointments.status, 'completed'),
        ne(appointments.status, 'cancelled'),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`,
        isNull(appointments.deletedAt)
      ))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(mapAppointmentRow);
  }

  async getPendingServiceRecords(employeeId: number): Promise<MonthlyServiceRecord[]> {
    return await db.select()
      .from(monthlyServiceRecords)
      .where(and(
        eq(monthlyServiceRecords.employeeId, employeeId),
        ne(monthlyServiceRecords.status, 'completed')
      ))
      .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
  }

  async isAppointmentLocked(appointmentId: number): Promise<boolean> {
    const result = await db.select({ 
      serviceRecordId: serviceRecordAppointments.serviceRecordId,
      status: monthlyServiceRecords.status,
    })
      .from(serviceRecordAppointments)
      .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
      .where(and(
        eq(serviceRecordAppointments.appointmentId, appointmentId),
        or(
          eq(monthlyServiceRecords.status, 'employee_signed'),
          eq(monthlyServiceRecords.status, 'completed')
        )
      ))
      .limit(1);
    
    return result.length > 0;
  }

  async getServiceRecordsOverview(employeeId: number, year: number, month: number): Promise<ServiceRecordOverviewItem[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const assignedCustomerIds = await this.getAssignedCustomerIds(employeeId);
    if (assignedCustomerIds.length === 0) {
      return [];
    }

    const overviewData = await db.select({
      customerId: customers.id,
      vorname: customers.vorname,
      nachname: customers.nachname,
      documentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
      undocumentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} IN ('scheduled', 'in-progress', 'documenting') THEN 1 ELSE 0 END), 0)::int`,
      totalAppointments: sqlBuilder<number>`COUNT(${appointments.id})::int`,
    })
      .from(customers)
      .leftJoin(appointments, and(
        eq(appointments.customerId, customers.id),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`,
        ne(appointments.status, 'cancelled'),
        isNull(appointments.deletedAt)
      ))
      .where(and(
        inArray(customers.id, assignedCustomerIds),
        ne(customers.status, 'erstberatung')
      ))
      .groupBy(customers.id, customers.vorname, customers.nachname);

    const existingRecords = await db.select({
      customerId: monthlyServiceRecords.customerId,
      id: monthlyServiceRecords.id,
      status: monthlyServiceRecords.status,
    })
      .from(monthlyServiceRecords)
      .where(and(
        eq(monthlyServiceRecords.employeeId, employeeId),
        eq(monthlyServiceRecords.year, year),
        eq(monthlyServiceRecords.month, month),
        inArray(monthlyServiceRecords.customerId, assignedCustomerIds)
      ));

    const recordMap = new Map(existingRecords.map(r => [r.customerId, { id: r.id, status: r.status }]));

    return overviewData
      .filter(item => item.totalAppointments > 0 || recordMap.has(item.customerId))
      .map(item => {
        const record = recordMap.get(item.customerId);
        return {
          customerId: item.customerId,
          customerName: `${item.vorname} ${item.nachname}`,
          existingRecordId: record?.id ?? null,
          existingRecordStatus: record?.status ?? null,
          documentedCount: item.documentedCount,
          undocumentedCount: item.undocumentedCount,
          totalAppointments: item.totalAppointments,
        };
      });
  }

  async getAppointmentCountsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<{ documentedCount: number; undocumentedCount: number }> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const result = await db.select({
      documentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
      undocumentedCount: sqlBuilder<number>`COALESCE(SUM(CASE WHEN ${appointments.status} IN ('scheduled', 'in-progress', 'documenting') THEN 1 ELSE 0 END), 0)::int`,
    })
      .from(appointments)
      .where(and(
        eq(appointments.customerId, customerId),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        ne(appointments.status, 'cancelled'),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`,
        isNull(appointments.deletedAt)
      ));

    return {
      documentedCount: result[0]?.documentedCount ?? 0,
      undocumentedCount: result[0]?.undocumentedCount ?? 0,
    };
  }

  async getAppointmentServices(appointmentId: number): Promise<AppointmentServiceWithDetails[]> {
    const { appointmentServices, services: servicesTable } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    return await db.select({
      id: appointmentServices.id,
      serviceId: appointmentServices.serviceId,
      plannedDurationMinutes: appointmentServices.plannedDurationMinutes,
      actualDurationMinutes: appointmentServices.actualDurationMinutes,
      details: appointmentServices.details,
      serviceName: servicesTable.name,
      serviceCode: servicesTable.code,
      serviceUnitType: servicesTable.unitType,
    })
    .from(appointmentServices)
    .innerJoin(servicesTable, eq(appointmentServices.serviceId, servicesTable.id))
    .where(eq(appointmentServices.appointmentId, appointmentId));
  }

  async getBatchAppointmentServices(appointmentIds: number[]): Promise<Record<number, AppointmentServiceWithDetails[]>> {
    if (appointmentIds.length === 0) return {};
    const { appointmentServices, services: servicesTable } = await import("@shared/schema");
    const { eq, inArray } = await import("drizzle-orm");
    const result = await db.select({
      appointmentId: appointmentServices.appointmentId,
      id: appointmentServices.id,
      serviceId: appointmentServices.serviceId,
      plannedDurationMinutes: appointmentServices.plannedDurationMinutes,
      actualDurationMinutes: appointmentServices.actualDurationMinutes,
      details: appointmentServices.details,
      serviceName: servicesTable.name,
      serviceCode: servicesTable.code,
      serviceUnitType: servicesTable.unitType,
    })
    .from(appointmentServices)
    .innerJoin(servicesTable, eq(appointmentServices.serviceId, servicesTable.id))
    .where(inArray(appointmentServices.appointmentId, appointmentIds));

    const grouped: Record<number, typeof result> = {};
    for (const row of result) {
      if (!grouped[row.appointmentId]) grouped[row.appointmentId] = [];
      grouped[row.appointmentId].push(row);
    }
    return grouped;
  }

  async createAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void> {
    if (services.length === 0) return;
    const { appointmentServices } = await import("@shared/schema");
    await db.insert(appointmentServices).values(
      services.map(entry => ({
        appointmentId,
        serviceId: entry.serviceId,
        plannedDurationMinutes: entry.plannedDurationMinutes,
      }))
    );
  }

  async replaceAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void> {
    const { appointmentServices } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.transaction(async (tx) => {
      await tx.delete(appointmentServices).where(eq(appointmentServices.appointmentId, appointmentId));
      if (services.length > 0) {
        await tx.insert(appointmentServices).values(
          services.map(s => ({
            appointmentId,
            serviceId: s.serviceId,
            plannedDurationMinutes: s.plannedDurationMinutes,
          }))
        );
      }
    });
  }

  async updateAppointmentServiceDocumentation(appointmentId: number, serviceUpdates: { serviceId: number; actualDurationMinutes: number; details?: string | null }[]): Promise<void> {
    if (serviceUpdates.length === 0) return;
    const { appointmentServices } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");
    await db.transaction(async (tx) => {
      await Promise.all(serviceUpdates.map(su =>
        tx.update(appointmentServices)
          .set({
            actualDurationMinutes: su.actualDurationMinutes,
            details: su.details ?? null,
          })
          .where(
            and(
              eq(appointmentServices.appointmentId, appointmentId),
              eq(appointmentServices.serviceId, su.serviceId)
            )
          )
      ));
    });
  }

  async getServicesByIds(serviceIds: number[]): Promise<{ id: number; code: string }[]> {
    if (serviceIds.length === 0) return [];
    const { services: servicesTable } = await import("@shared/schema");
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select({ id: servicesTable.id, code: servicesTable.code }).from(servicesTable).where(inArray(servicesTable.id, serviceIds));
    return rows.filter((r): r is { id: number; code: string } => r.code !== null);
  }

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

  async getCompanySettings(): Promise<CompanySettings> {
    const { companySettings } = await import("@shared/schema");
    const existing = await db.select().from(companySettings).limit(1);
    if (existing.length > 0) return existing[0];
    const [created] = await db.insert(companySettings).values({}).returning();
    return created;
  }

  async updateCompanySettings(data: Partial<CompanySettings>, userId: number): Promise<CompanySettings> {
    const { companySettings } = await import("@shared/schema");
    const existing = await db.select().from(companySettings).limit(1);
    if (existing.length === 0) {
      const [created] = await db.insert(companySettings).values({ ...data, updatedByUserId: userId }).returning();
      return created;
    }
    const { eq } = await import("drizzle-orm");
    const [updated] = await db.update(companySettings)
      .set({ ...data, updatedAt: new Date(), updatedByUserId: userId })
      .where(eq(companySettings.id, existing[0].id))
      .returning();
    return updated;
  }

  async getInvoices(filters: { year?: number; month?: number; customerId?: number; status?: string }): Promise<InvoiceWithCustomer[]> {
    const { invoices, customers } = await import("@shared/schema");
    const { eq, and, asc, desc } = await import("drizzle-orm");
    const conditions: ReturnType<typeof eq>[] = [];
    if (filters.year) conditions.push(eq(invoices.billingYear, filters.year));
    if (filters.month) conditions.push(eq(invoices.billingMonth, filters.month));
    if (filters.customerId) conditions.push(eq(invoices.customerId, filters.customerId));
    if (filters.status) conditions.push(eq(invoices.status, filters.status as string));

    const results = await db.select({
      invoice: invoices,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(invoices.createdAt));

    return results.map(r => ({ ...r.invoice, customerName: r.customerName }));
  }

  async getInvoice(id: number): Promise<InvoiceWithCustomer | undefined> {
    const { invoices, customers } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const results = await db.select({
      invoice: invoices,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(eq(invoices.id, id));
    if (results.length === 0) return undefined;
    return { ...results[0].invoice, customerName: results[0].customerName };
  }

  async createInvoice(data: Record<string, unknown>, lineItems: Record<string, unknown>[], userId: number): Promise<Invoice> {
    const { invoices, invoiceLineItems } = await import("@shared/schema");
    return await db.transaction(async (tx) => {
      const invoiceValues = { ...data, createdByUserId: userId } as typeof invoices.$inferInsert;
      const [invoice] = await tx.insert(invoices).values(invoiceValues).returning();

      if (lineItems.length > 0) {
        await tx.insert(invoiceLineItems).values(
          lineItems.map((item, idx) => ({
            ...item,
            invoiceId: invoice.id,
            sortOrder: idx,
          } as typeof invoiceLineItems.$inferInsert))
        );
      }

      return invoice;
    });
  }

  async updateInvoiceStatus(id: number, status: string, userId: number): Promise<Invoice> {
    const { invoices } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const updateData: Partial<Invoice> = { status: status as Invoice["status"] };
    if (status === "versendet") updateData.sentAt = new Date();
    if (status === "bezahlt") updateData.paidAt = new Date();
    if (status === "storniert") updateData.storniertAt = new Date();
    const [updated] = await db.update(invoices).set(updateData).where(eq(invoices.id, id)).returning();
    return updated;
  }

  async getNextInvoiceNumber(year: number): Promise<string> {
    const { invoices } = await import("@shared/schema");
    const { eq, sql } = await import("drizzle-orm");
    const result = await db.select({
      maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0)`,
    })
    .from(invoices)
    .where(eq(invoices.billingYear, year));
    const next = (result[0]?.maxNum || 0) + 1;
    return `RE-${year}-${String(next).padStart(4, "0")}`;
  }

  async getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]> {
    const { invoiceLineItems } = await import("@shared/schema");
    const { eq, asc } = await import("drizzle-orm");
    return await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)).orderBy(asc(invoiceLineItems.sortOrder));
  }

  async getInvoicesForCustomerMonth(customerId: number, year: number, month: number): Promise<Invoice[]> {
    const { invoices } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");
    return await db.select().from(invoices).where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.billingYear, year),
        eq(invoices.billingMonth, month)
      )
    );
  }
}

export const storage = new DatabaseStorage();
