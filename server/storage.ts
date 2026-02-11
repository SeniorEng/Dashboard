import { 
  type Customer, 
  type InsertCustomer, 
  type Appointment, 
  type InsertAppointment,
  type UpdateAppointment,
  type MonthlyServiceRecord,
  type InsertServiceRecord,
  type ServiceRecordStatus,
  customers, 
  appointments,
  monthlyServiceRecords,
  serviceRecordAppointments,
  users,
} from "@shared/schema";
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
  signatureData: appointments.signatureData,
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
    signatureData: row.signatureData,
    createdAt: row.createdAt,
    performedByEmployeeId: row.performedByEmployeeId,
    customer: row.customer?.id ? row.customer : null,
  };
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
  signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer'): Promise<MonthlyServiceRecord | undefined>;
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
    return await db.select().from(customers);
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
    const result = await db.delete(customers).where(eq(customers.id, id)).returning();
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
        sqlBuilder`${customers.primaryEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId} = ${employeeId}`
      );
    return result.map(r => r.id);
  }

  async getAssignedCustomerIds(employeeId: number): Promise<number[]> {
    const cached = customerIdsCache.get(employeeId);
    if (cached !== undefined) {
      return cached;
    }
    
    const currentlyAssigned = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sqlBuilder`${customers.primaryEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId} = ${employeeId}`
      );
    
    const fromAppointments = await db
      .select({ customerId: appointments.customerId })
      .from(appointments)
      .where(
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.performedByEmployeeId, employeeId)
        )
      )
      .groupBy(appointments.customerId);
    
    const idSet = new Set<number>();
    for (const r of currentlyAssigned) idSet.add(r.id);
    for (const r of fromAppointments) idSet.add(r.customerId);
    
    const ids = Array.from(idSet);
    customerIdsCache.set(employeeId, ids);
    return ids;
  }

  async getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean })[]> {
    const assignedIds = await this.getAssignedCustomerIds(employeeId);
    if (assignedIds.length === 0) return [];

    const customerRows = await db
      .select()
      .from(customers)
      .where(inArray(customers.id, assignedIds))
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
    const searchTerm = `%${query}%`;
    
    const conditions = [
      or(
        ilike(customers.name, searchTerm),
        ilike(customers.vorname, searchTerm),
        ilike(customers.nachname, searchTerm)
      )
    ];
    
    if (assignedCustomerIds && assignedCustomerIds.length > 0) {
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
    const searchTerm = `%${query}%`;
    
    const conditions = [
      or(
        ilike(customers.name, searchTerm),
        ilike(customers.vorname, searchTerm),
        ilike(customers.nachname, searchTerm)
      )
    ];
    
    if (assignedCustomerIds && assignedCustomerIds.length > 0) {
      conditions.push(inArray(appointments.customerId, assignedCustomerIds));
    }
    
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
    return await db.select().from(appointments);
  }

  async getAppointment(id: number): Promise<Appointment | undefined> {
    const result = await db.select().from(appointments).where(eq(appointments.id, id));
    return result[0];
  }

  async getAppointmentsByDate(date: string): Promise<Appointment[]> {
    return await db.select().from(appointments).where(eq(appointments.date, date));
  }

  async getAppointmentCountsByDates(dates: string[], customerIds?: number[]): Promise<Record<string, number>> {
    if (dates.length === 0) return {};
    
    const conditions = [inArray(appointments.date, dates)];
    if (customerIds && customerIds.length > 0) {
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
    const result = await db.delete(appointments).where(eq(appointments.id, id)).returning();
    return result.length > 0;
  }

  // Appointments - With Customer (single query with LEFT JOIN for performance)
  async getAppointmentsWithCustomers(date?: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]> {
    const conditions = [];
    if (date) {
      conditions.push(eq(appointments.date, date));
    }
    if (customerIds && customerIds.length > 0) {
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
      ? await db.select({ count: count() }).from(appointments).where(eq(appointments.date, date))
      : await db.select({ count: count() }).from(appointments);
    
    const total = Number(countResult[0]?.count ?? 0);

    let query = db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .limit(limit)
      .offset(offset);

    const results = date 
      ? await query.where(eq(appointments.date, date))
      : await query;

    const data = results.map(mapAppointmentRow);

    return { data, total, limit, offset };
  }

  async getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined> {
    const results = await db
      .select(appointmentWithCustomerSelectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(eq(appointments.id, id));
    
    if (results.length === 0) return undefined;
    
    return mapAppointmentRow(results[0]);
  }

  async getUndocumentedAppointments(beforeDate: string, customerIds?: number[]): Promise<AppointmentWithCustomer[]> {
    const conditions = [
      lt(appointments.date, beforeDate),
      ne(appointments.status, "completed")
    ];
    
    if (customerIds && customerIds.length > 0) {
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
    let customer: Customer | null = null;
    
    try {
      customer = await this.createCustomer(customerData);
      
      const appointment = await this.createAppointment({
        ...appointmentData,
        customerId: customer.id,
      });
      
      return { customer, appointment };
    } catch (error) {
      if (customer) {
        await this.deleteCustomer(customer.id).catch(console.error);
      }
      throw error;
    }
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
        )
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

  async signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer'): Promise<MonthlyServiceRecord | undefined> {
    const existing = await this.getServiceRecord(id);
    if (!existing) return undefined;

    const now = new Date();
    let updateData: Partial<MonthlyServiceRecord> = { updatedAt: now };

    if (signerType === 'employee') {
      if (existing.status !== 'pending') {
        throw new Error('Mitarbeiter kann nur bei Status "pending" unterschreiben');
      }
      updateData = {
        ...updateData,
        employeeSignatureData: signatureData,
        employeeSignedAt: now,
        status: 'employee_signed' as ServiceRecordStatus,
      };
    } else if (signerType === 'customer') {
      if (existing.status !== 'employee_signed') {
        throw new Error('Kunde kann nur nach Mitarbeiter-Unterschrift unterschreiben');
      }
      updateData = {
        ...updateData,
        customerSignatureData: signatureData,
        customerSignedAt: now,
        status: 'completed' as ServiceRecordStatus,
      };
    }

    const result = await db.update(monthlyServiceRecords)
      .set(updateData)
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
      .where(inArray(appointments.id, appointmentIds))
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
        sqlBuilder`${appointments.date} < ${endDate}`
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
        sqlBuilder`${appointments.date} < ${endDate}`
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
        ne(appointments.status, 'cancelled')
      ))
      .where(inArray(customers.id, assignedCustomerIds))
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
        sqlBuilder`${appointments.date} < ${endDate}`
      ));

    return {
      documentedCount: result[0]?.documentedCount ?? 0,
      undocumentedCount: result[0]?.undocumentedCount ?? 0,
    };
  }
}

export const storage = new DatabaseStorage();
