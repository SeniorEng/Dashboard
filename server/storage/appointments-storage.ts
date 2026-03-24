import {
  type Appointment,
  type InsertAppointment,
  type UpdateAppointment,
  customers,
  appointments,
  prospects,
} from "@shared/schema";
import type { AppointmentWithCustomer, PaginatedResult } from "@shared/types";
import { eq, count, sql as sqlBuilder, lt, ne, and, or, inArray, isNull } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { db, type DbOrTx } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import type { PaginationOptions } from "../storage";

export async function getAppointments(): Promise<Appointment[]> {
  return await db.select().from(appointments).where(isNull(appointments.deletedAt));
}

export async function getAppointment(id: number): Promise<Appointment | undefined> {
  const result = await db.select().from(appointments).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));
  return result[0];
}

export async function getAppointmentIncludeDeleted(id: number): Promise<Appointment | undefined> {
  const result = await db.select().from(appointments).where(eq(appointments.id, id));
  return result[0];
}

export async function getAppointmentsByDate(date: string): Promise<Appointment[]> {
  return await db.select().from(appointments).where(and(eq(appointments.date, date), isNull(appointments.deletedAt)));
}

export async function getAppointmentCountsByDates(dates: string[], customerIds?: number[], employeeId?: number): Promise<Record<string, number>> {
  if (dates.length === 0) return {};

  const conditions = [inArray(appointments.date, dates), isNull(appointments.deletedAt)];

  const employeeCondition = employeeId
    ? or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.performedByEmployeeId, employeeId)
      )!
    : undefined;

  if (customerIds && customerIds.length > 0 && employeeCondition) {
    conditions.push(or(inArray(appointments.customerId, customerIds), employeeCondition)!);
  } else if (customerIds && customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, customerIds));
  } else if (employeeCondition) {
    conditions.push(employeeCondition);
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

export async function createAppointment(appointment: InsertAppointment): Promise<Appointment> {
  const result = await db.insert(appointments).values(appointment).returning();
  if (appointment.assignedEmployeeId) {
    customerIdsCache.invalidateForEmployee(appointment.assignedEmployeeId);
  }
  return result[0];
}

export async function updateAppointment(id: number, appointment: UpdateAppointment, tx?: DbOrTx): Promise<Appointment | undefined> {
  const client = tx || db;
  const result = await client.update(appointments)
    .set(appointment)
    .where(eq(appointments.id, id))
    .returning();
  return result[0];
}

export async function deleteAppointment(id: number, tx?: DbOrTx): Promise<boolean> {
  const client = tx || db;
  const result = await client.update(appointments)
    .set({ deletedAt: new Date() })
    .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)))
    .returning();
  return result.length > 0;
}

export async function getAppointmentsWithCustomers(date?: string, customerIds?: number[], employeeId?: number): Promise<AppointmentWithCustomer[]> {
  const conditions = [isNull(appointments.deletedAt)];
  if (date) {
    conditions.push(eq(appointments.date, date));
  }

  const employeeCondition = employeeId
    ? or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.performedByEmployeeId, employeeId)
      )!
    : undefined;

  if (customerIds && customerIds.length > 0 && employeeCondition) {
    conditions.push(or(inArray(appointments.customerId, customerIds), employeeCondition)!);
  } else if (customerIds && customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, customerIds));
  } else if (employeeCondition) {
    conditions.push(employeeCondition);
  }

  const query = db
    .select(appointmentWithCustomerSelectFields)
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id));

  const results = conditions.length > 0
    ? await query.where(and(...conditions))
    : await query;

  return results.map(mapAppointmentRow);
}

export async function getAppointmentsWithCustomersPaginated(
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
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .limit(limit)
    .offset(offset);

  const results = date
    ? await query.where(and(eq(appointments.date, date), isNull(appointments.deletedAt)))
    : await query.where(isNull(appointments.deletedAt));

  const data = results.map(mapAppointmentRow);

  return { data, total, limit, offset };
}

export async function getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined> {
  const results = await db
    .select(appointmentWithCustomerSelectFields)
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));

  if (results.length === 0) return undefined;

  return mapAppointmentRow(results[0]);
}

export async function getUndocumentedAppointments(beforeDate: string, customerIds?: number[], employeeId?: number): Promise<AppointmentWithCustomer[]> {
  const conditions = [
    lt(appointments.date, beforeDate),
    ne(appointments.status, "completed"),
    isNull(appointments.deletedAt)
  ];

  if (employeeId) {
    conditions.push(
      or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.performedByEmployeeId, employeeId)
      )!
    );
  } else if (customerIds && customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, customerIds));
  }

  const results = await db
    .select(appointmentWithCustomerSelectFields)
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions));

  return results.map(mapAppointmentRow);
}

export async function getAppointmentsForDay(employeeId: number, date: string): Promise<AppointmentWithCustomer[]> {
  const rows = await db.select(appointmentWithCustomerSelectFields)
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
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

export async function getAppointmentServices(appointmentId: number): Promise<import("../storage").AppointmentServiceWithDetails[]> {
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

export async function getBatchAppointmentServices(appointmentIds: number[]): Promise<Record<number, import("../storage").AppointmentServiceWithDetails[]>> {
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

export async function createAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void> {
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

export async function replaceAppointmentServices(appointmentId: number, services: { serviceId: number; plannedDurationMinutes: number }[]): Promise<void> {
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

export async function updateAppointmentServiceDocumentation(appointmentId: number, serviceUpdates: { serviceId: number; actualDurationMinutes: number; details?: string | null }[], tx?: DbOrTx): Promise<void> {
  if (serviceUpdates.length === 0) return;
  const { appointmentServices } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const runUpdates = async (client: DbOrTx) => {
    await Promise.all(serviceUpdates.map(su =>
      client.update(appointmentServices)
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
  };
  if (tx) {
    await runUpdates(tx);
  } else {
    await db.transaction(async (innerTx) => runUpdates(innerTx));
  }
}

export async function getServicesByIds(serviceIds: number[]): Promise<{ id: number; code: string }[]> {
  if (serviceIds.length === 0) return [];
  const { services: servicesTable } = await import("@shared/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select({ id: servicesTable.id, code: servicesTable.code }).from(servicesTable).where(inArray(servicesTable.id, serviceIds));
  return rows.filter((r): r is { id: number; code: string } => r.code !== null);
}
