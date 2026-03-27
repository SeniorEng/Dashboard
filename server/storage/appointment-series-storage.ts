import {
  type AppointmentSeries,
  type InsertAppointmentSeries,
  appointmentSeries,
  appointments,
  customers,
} from "@shared/schema";
import { eq, and, isNull, gte, ne, inArray, desc } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";

export async function createSeries(data: InsertAppointmentSeries, tx?: DbOrTx): Promise<AppointmentSeries> {
  const client = tx || db;
  const [result] = await client.insert(appointmentSeries).values(data).returning();
  return result;
}

export async function getSeries(id: number): Promise<AppointmentSeries | undefined> {
  const [result] = await db.select().from(appointmentSeries).where(eq(appointmentSeries.id, id));
  return result;
}

export interface SeriesWithCustomerName extends AppointmentSeries {
  customerName: string;
}

export async function getSeriesWithCustomer(id: number): Promise<SeriesWithCustomerName | undefined> {
  const rows = await db.select({
    series: appointmentSeries,
    customerName: customers.name,
  })
    .from(appointmentSeries)
    .innerJoin(customers, eq(appointmentSeries.customerId, customers.id))
    .where(eq(appointmentSeries.id, id));

  if (rows.length === 0) return undefined;
  return { ...rows[0].series, customerName: rows[0].customerName };
}

export async function getActiveSeriesForCustomer(customerId: number): Promise<AppointmentSeries[]> {
  return db.select().from(appointmentSeries)
    .where(and(
      eq(appointmentSeries.customerId, customerId),
      eq(appointmentSeries.status, "active"),
    ))
    .orderBy(desc(appointmentSeries.createdAt));
}

export async function getAllActiveSeries(): Promise<SeriesWithCustomerName[]> {
  const rows = await db.select({
    series: appointmentSeries,
    customerName: customers.name,
  })
    .from(appointmentSeries)
    .innerJoin(customers, eq(appointmentSeries.customerId, customers.id))
    .where(ne(appointmentSeries.status, "ended"))
    .orderBy(customers.name, appointmentSeries.startDate);

  return rows.map(r => ({ ...r.series, customerName: r.customerName }));
}

export async function updateSeries(
  id: number,
  data: Partial<InsertAppointmentSeries>,
  tx?: DbOrTx,
): Promise<AppointmentSeries | undefined> {
  const client = tx || db;
  const [result] = await client.update(appointmentSeries)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(appointmentSeries.id, id))
    .returning();
  return result;
}

export async function getSeriesAppointments(seriesId: number) {
  return db.select().from(appointments)
    .where(and(
      eq(appointments.seriesId, seriesId),
      isNull(appointments.deletedAt),
    ))
    .orderBy(appointments.date, appointments.scheduledStart);
}

export async function getFutureSeriesAppointments(
  seriesId: number,
  fromDate: string,
  options?: { includeExceptions?: boolean },
) {
  const conditions = [
    eq(appointments.seriesId, seriesId),
    gte(appointments.date, fromDate),
    isNull(appointments.deletedAt),
    ne(appointments.status, "completed"),
    ne(appointments.status, "cancelled"),
  ];

  if (!options?.includeExceptions) {
    conditions.push(eq(appointments.isSeriesException, false));
  }

  return db.select().from(appointments)
    .where(and(...conditions))
    .orderBy(appointments.date);
}

export async function bulkUpdateSeriesAppointments(
  appointmentIds: number[],
  data: Record<string, unknown>,
  tx?: DbOrTx,
): Promise<number> {
  if (appointmentIds.length === 0) return 0;
  const client = tx || db;
  const result = await client.update(appointments)
    .set(data)
    .where(inArray(appointments.id, appointmentIds))
    .returning();
  return result.length;
}

export async function bulkCancelSeriesAppointments(
  appointmentIds: number[],
  tx?: DbOrTx,
): Promise<number> {
  return bulkUpdateSeriesAppointments(appointmentIds, { status: "cancelled" }, tx);
}

export async function bulkDeleteSeriesAppointments(
  appointmentIds: number[],
  tx?: DbOrTx,
): Promise<number> {
  if (appointmentIds.length === 0) return 0;
  const client = tx || db;
  const result = await client.update(appointments)
    .set({ deletedAt: new Date() })
    .where(inArray(appointments.id, appointmentIds))
    .returning();
  return result.length;
}

export async function countSeriesAppointments(seriesId: number): Promise<{ total: number; future: number; completed: number }> {
  const all = await db.select({ id: appointments.id, status: appointments.status, date: appointments.date })
    .from(appointments)
    .where(and(
      eq(appointments.seriesId, seriesId),
      isNull(appointments.deletedAt),
      ne(appointments.status, "cancelled"),
    ));

  const today = new Date().toISOString().split("T")[0];
  return {
    total: all.length,
    future: all.filter(a => a.date >= today).length,
    completed: all.filter(a => a.status === "completed").length,
  };
}
