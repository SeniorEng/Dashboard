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
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, count, sql as sqlBuilder, lt, ne, and, or, ilike, inArray, isNull } from "drizzle-orm";
import { customerIdsCache } from "./services/cache";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

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
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  deleteCustomer(id: number): Promise<boolean>;
  getAssignedCustomerIds(employeeId: number): Promise<number[]>;
  
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
  getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number): Promise<MonthlyServiceRecord[]>;
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
  
  async getAssignedCustomerIds(employeeId: number): Promise<number[]> {
    const cached = customerIdsCache.get(employeeId);
    if (cached !== undefined) {
      return cached;
    }
    
    const result = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sqlBuilder`${customers.primaryEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId} = ${employeeId}`
      );
    const ids = result.map(r => r.id);
    customerIdsCache.set(employeeId, ids);
    return ids;
  }

  async getCustomersByIds(ids: number[]): Promise<Customer[]> {
    if (ids.length === 0) return [];
    return await db.select().from(customers).where(inArray(customers.id, ids));
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
      .select({
        id: appointments.id,
        customerId: appointments.customerId,
        createdByUserId: appointments.createdByUserId,
        assignedEmployeeId: appointments.assignedEmployeeId,
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        hauswirtschaftDauer: appointments.hauswirtschaftDauer,
        alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
        erstberatungDauer: appointments.erstberatungDauer,
        hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
        hauswirtschaftDetails: appointments.hauswirtschaftDetails,
        alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
        alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
        erstberatungActualDauer: appointments.erstberatungActualDauer,
        erstberatungDetails: appointments.erstberatungDetails,
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
        kilometers: appointments.kilometers,
        notes: appointments.notes,
        servicesDone: appointments.servicesDone,
        signatureData: appointments.signatureData,
        createdAt: appointments.createdAt,
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
          avatar: customers.avatar,
          needs: customers.needs,
          createdAt: customers.createdAt,
          updatedAt: customers.updatedAt,
          createdByUserId: customers.createdByUserId,
        }
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(...conditions))
      .limit(limit);
    
    return results.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    }));
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

  async createAppointment(appointment: InsertAppointment): Promise<Appointment> {
    const result = await db.insert(appointments).values(appointment).returning();
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
    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
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
        avatar: customers.avatar,
        needs: customers.needs,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
        createdByUserId: customers.createdByUserId,
      }
    };
    
    const conditions = [];
    if (date) {
      conditions.push(eq(appointments.date, date));
    }
    if (customerIds && customerIds.length > 0) {
      conditions.push(inArray(appointments.customerId, customerIds));
    }
    
    const query = db
      .select(selectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id));
    
    const results = conditions.length > 0 
      ? await query.where(and(...conditions))
      : await query;
    
    return results.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    }));
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

    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
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
        avatar: customers.avatar,
        needs: customers.needs,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
        createdByUserId: customers.createdByUserId,
      }
    };

    let query = db
      .select(selectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .limit(limit)
      .offset(offset);

    const results = date 
      ? await query.where(eq(appointments.date, date))
      : await query;

    const data = results.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    }));

    return { data, total, limit, offset };
  }

  async getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined> {
    const results = await db
      .select({
        id: appointments.id,
        customerId: appointments.customerId,
        createdByUserId: appointments.createdByUserId,
        assignedEmployeeId: appointments.assignedEmployeeId,
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        hauswirtschaftDauer: appointments.hauswirtschaftDauer,
        alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
        erstberatungDauer: appointments.erstberatungDauer,
        hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
        hauswirtschaftDetails: appointments.hauswirtschaftDetails,
        alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
        alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
        erstberatungActualDauer: appointments.erstberatungActualDauer,
        erstberatungDetails: appointments.erstberatungDetails,
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
        kilometers: appointments.kilometers,
        notes: appointments.notes,
        servicesDone: appointments.servicesDone,
        signatureData: appointments.signatureData,
        createdAt: appointments.createdAt,
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
          avatar: customers.avatar,
          needs: customers.needs,
          createdAt: customers.createdAt,
          updatedAt: customers.updatedAt,
          createdByUserId: customers.createdByUserId,
        }
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(eq(appointments.id, id));
    
    if (results.length === 0) return undefined;
    
    const row = results[0];
    return {
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    };
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
      .select({
        id: appointments.id,
        customerId: appointments.customerId,
        createdByUserId: appointments.createdByUserId,
        assignedEmployeeId: appointments.assignedEmployeeId,
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        hauswirtschaftDauer: appointments.hauswirtschaftDauer,
        alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
        erstberatungDauer: appointments.erstberatungDauer,
        hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
        hauswirtschaftDetails: appointments.hauswirtschaftDetails,
        alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
        alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
        erstberatungActualDauer: appointments.erstberatungActualDauer,
        erstberatungDetails: appointments.erstberatungDetails,
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
        kilometers: appointments.kilometers,
        notes: appointments.notes,
        servicesDone: appointments.servicesDone,
        signatureData: appointments.signatureData,
        createdAt: appointments.createdAt,
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
          avatar: customers.avatar,
          needs: customers.needs,
          createdAt: customers.createdAt,
          updatedAt: customers.updatedAt,
          createdByUserId: customers.createdByUserId,
        }
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(...conditions));
    
    return results.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    }));
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
    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
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
        avatar: customers.avatar,
        needs: customers.needs,
        createdAt: customers.createdAt,
        updatedAt: customers.updatedAt,
        createdByUserId: customers.createdByUserId,
      }
    };
    
    // Get appointments where the employee is assigned OR created the appointment OR appointment is unassigned
    // This ensures overlap checking catches all relevant appointments for a user
    const rows = await db.select(selectFields)
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
    
    return rows.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null,
      customerFirstName: row.customer?.vorname || null,
      customerLastName: row.customer?.nachname || null,
    }));
  }

  // Monthly Service Records (Leistungsnachweise)
  async getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number): Promise<MonthlyServiceRecord[]> {
    let conditions = [eq(monthlyServiceRecords.employeeId, employeeId)];
    if (year !== undefined) {
      conditions.push(eq(monthlyServiceRecords.year, year));
    }
    if (month !== undefined) {
      conditions.push(eq(monthlyServiceRecords.month, month));
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
    
    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
      customer: customers,
    };

    const rows = await db.select(selectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(inArray(appointments.id, appointmentIds))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null,
      customerFirstName: row.customer?.vorname || null,
      customerLastName: row.customer?.nachname || null,
    }));
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
    
    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
      customer: customers,
    };

    const rows = await db.select(selectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(
        eq(appointments.customerId, customerId),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        eq(appointments.status, 'documented'),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`
      ))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null,
      customerFirstName: row.customer?.vorname || null,
      customerLastName: row.customer?.nachname || null,
    }));
  }

  async getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    
    const selectFields = {
      id: appointments.id,
      customerId: appointments.customerId,
      createdByUserId: appointments.createdByUserId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      erstberatungDauer: appointments.erstberatungDauer,
      hauswirtschaftActualDauer: appointments.hauswirtschaftActualDauer,
      hauswirtschaftDetails: appointments.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: appointments.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: appointments.alltagsbegleitungDetails,
      erstberatungActualDauer: appointments.erstberatungActualDauer,
      erstberatungDetails: appointments.erstberatungDetails,
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
      kilometers: appointments.kilometers,
      notes: appointments.notes,
      servicesDone: appointments.servicesDone,
      signatureData: appointments.signatureData,
      createdAt: appointments.createdAt,
      customer: customers,
    };

    const rows = await db.select(selectFields)
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(and(
        eq(appointments.customerId, customerId),
        or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.createdByUserId, employeeId)
        ),
        ne(appointments.status, 'documented'),
        ne(appointments.status, 'cancelled'),
        sqlBuilder`${appointments.date} >= ${startDate}`,
        sqlBuilder`${appointments.date} < ${endDate}`
      ))
      .orderBy(appointments.date, appointments.scheduledStart);
    
    return rows.map(row => ({
      id: row.id,
      customerId: row.customerId,
      createdByUserId: row.createdByUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      erstberatungDauer: row.erstberatungDauer,
      hauswirtschaftActualDauer: row.hauswirtschaftActualDauer,
      hauswirtschaftDetails: row.hauswirtschaftDetails,
      alltagsbegleitungActualDauer: row.alltagsbegleitungActualDauer,
      alltagsbegleitungDetails: row.alltagsbegleitungDetails,
      erstberatungActualDauer: row.erstberatungActualDauer,
      erstberatungDetails: row.erstberatungDetails,
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
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null,
      customerFirstName: row.customer?.vorname || null,
      customerLastName: row.customer?.nachname || null,
    }));
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
}

export const storage = new DatabaseStorage();
