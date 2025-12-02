import { 
  type Customer, 
  type InsertCustomer, 
  type Appointment, 
  type InsertAppointment,
  type UpdateAppointment,
  customers, 
  appointments 
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, count, sql as sqlBuilder } from "drizzle-orm";

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

export interface IStorage {
  // Customers
  getCustomers(): Promise<Customer[]>;
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  deleteCustomer(id: number): Promise<boolean>;
  
  // Appointments - Basic
  getAppointments(): Promise<Appointment[]>;
  getAppointment(id: number): Promise<Appointment | undefined>;
  createAppointment(appointment: InsertAppointment): Promise<Appointment>;
  updateAppointment(id: number, appointment: UpdateAppointment): Promise<Appointment | undefined>;
  deleteAppointment(id: number): Promise<boolean>;
  getAppointmentsByDate(date: string): Promise<Appointment[]>;
  
  // Appointments - With Customer (optimized)
  getAppointmentsWithCustomers(date?: string): Promise<AppointmentWithCustomer[]>;
  getAppointmentsWithCustomersPaginated(
    date?: string, 
    options?: PaginationOptions
  ): Promise<PaginatedResult<AppointmentWithCustomer>>;
  getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined>;
  
  // Atomic operations (with application-level rollback)
  createErstberatungWithCustomer(
    customer: InsertCustomer,
    appointment: Omit<InsertAppointment, 'customerId'>
  ): Promise<{ customer: Customer; appointment: Appointment }>;
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
    return result[0];
  }

  async deleteCustomer(id: number): Promise<boolean> {
    const result = await db.delete(customers).where(eq(customers.id, id)).returning();
    return result.length > 0;
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
  async getAppointmentsWithCustomers(date?: string): Promise<AppointmentWithCustomer[]> {
    let query = db
      .select({
        id: appointments.id,
        customerId: appointments.customerId,
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        hauswirtschaftDauer: appointments.hauswirtschaftDauer,
        alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        scheduledEnd: appointments.scheduledEnd,
        durationPromised: appointments.durationPromised,
        status: appointments.status,
        actualStart: appointments.actualStart,
        actualEnd: appointments.actualEnd,
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
          telefon: customers.telefon,
          address: customers.address,
          strasse: customers.strasse,
          nr: customers.nr,
          plz: customers.plz,
          stadt: customers.stadt,
          pflegegrad: customers.pflegegrad,
          avatar: customers.avatar,
          needs: customers.needs,
        }
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id));
    
    // Apply date filter if provided
    const results = date 
      ? await query.where(eq(appointments.date, date))
      : await query;
    
    return results.map(row => ({
      id: row.id,
      customerId: row.customerId,
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      date: row.date,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      durationPromised: row.durationPromised,
      status: row.status,
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
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
      appointmentType: appointments.appointmentType,
      serviceType: appointments.serviceType,
      hauswirtschaftDauer: appointments.hauswirtschaftDauer,
      alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
      date: appointments.date,
      scheduledStart: appointments.scheduledStart,
      scheduledEnd: appointments.scheduledEnd,
      durationPromised: appointments.durationPromised,
      status: appointments.status,
      actualStart: appointments.actualStart,
      actualEnd: appointments.actualEnd,
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
        telefon: customers.telefon,
        address: customers.address,
        strasse: customers.strasse,
        nr: customers.nr,
        plz: customers.plz,
        stadt: customers.stadt,
        pflegegrad: customers.pflegegrad,
        avatar: customers.avatar,
        needs: customers.needs,
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
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      date: row.date,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      durationPromised: row.durationPromised,
      status: row.status,
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
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
        appointmentType: appointments.appointmentType,
        serviceType: appointments.serviceType,
        hauswirtschaftDauer: appointments.hauswirtschaftDauer,
        alltagsbegleitungDauer: appointments.alltagsbegleitungDauer,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        scheduledEnd: appointments.scheduledEnd,
        durationPromised: appointments.durationPromised,
        status: appointments.status,
        actualStart: appointments.actualStart,
        actualEnd: appointments.actualEnd,
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
          telefon: customers.telefon,
          address: customers.address,
          strasse: customers.strasse,
          nr: customers.nr,
          plz: customers.plz,
          stadt: customers.stadt,
          pflegegrad: customers.pflegegrad,
          avatar: customers.avatar,
          needs: customers.needs,
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
      appointmentType: row.appointmentType,
      serviceType: row.serviceType,
      hauswirtschaftDauer: row.hauswirtschaftDauer,
      alltagsbegleitungDauer: row.alltagsbegleitungDauer,
      date: row.date,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      durationPromised: row.durationPromised,
      status: row.status,
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
      kilometers: row.kilometers,
      notes: row.notes,
      servicesDone: row.servicesDone,
      signatureData: row.signatureData,
      createdAt: row.createdAt,
      customer: row.customer?.id ? row.customer : null
    };
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
}

export const storage = new DatabaseStorage();
