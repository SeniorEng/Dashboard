import { eq, and, gte, lte, inArray, isNull, or, asc, ne, sql as sqlBuilder, getTableColumns } from "drizzle-orm";
import {
  appointments,
  customers,
  prospects,
} from "@shared/schema";
import { appointmentServices as appointmentServicesTable } from "@shared/schema/appointments";
import { services as servicesTable } from "@shared/schema/services";
import type { AppointmentWithCustomerName } from "@shared/api";
import { db } from "../../lib/db";
import { employeeVisibleAppointmentsFilter } from "../appointment-helpers";

export async function getEmployeeAppointments(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<AppointmentWithCustomerName[]> {
  const results = await db
    .select({
      ...getTableColumns(appointments),
      customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name}, ${prospects.vorname} || ' ' || ${prospects.nachname}, '')`.as('customer_name'),
    })
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(
      and(
        or(
          and(
            eq(appointments.status, 'completed'),
            eq(appointments.performedByEmployeeId, userId),
          ),
          and(
            ne(appointments.status, 'completed'),
            employeeVisibleAppointmentsFilter(userId),
          ),
        ),
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
      ),
    )
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  return results.map(r => ({
    ...r,
    customerName: String(r.customerName),
  }));
}

export async function getAllAppointmentsInRange(
  startDate: string,
  endDate: string,
): Promise<AppointmentWithCustomerName[]> {
  const results = await db
    .select({
      ...getTableColumns(appointments),
      customerName: sqlBuilder`COALESCE(${customers.vorname} || ' ' || ${customers.nachname}, ${customers.name}, ${prospects.vorname} || ' ' || ${prospects.nachname}, '')`.as('customer_name'),
    })
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(
      and(
        gte(appointments.date, startDate),
        lte(appointments.date, endDate),
        isNull(appointments.deletedAt),
      ),
    )
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  return results.map(r => ({
    ...r,
    customerName: String(r.customerName),
  }));
}

export interface AppointmentServiceDetail {
  serviceCode: string | null;
  serviceName: string;
  actualMinutes: number | null;
  plannedMinutes: number;
}

/**
 * Lädt für eine Liste von Termin-IDs die zugeordneten Services
 * (geplant/tatsächlich Minuten + Service-Code/Name) und gruppiert
 * sie pro Termin. Wird vom Admin-Termine-Endpoint verwendet, um
 * direkten DB-Zugriff aus dem Route-Handler zu vermeiden.
 */
export async function getAppointmentServiceDetailsByAppointmentIds(
  appointmentIds: number[],
): Promise<Map<number, AppointmentServiceDetail[]>> {
  const grouped = new Map<number, AppointmentServiceDetail[]>();
  if (appointmentIds.length === 0) return grouped;

  const rows = await db.select({
    appointmentId: appointmentServicesTable.appointmentId,
    serviceCode: servicesTable.code,
    serviceName: servicesTable.name,
    plannedMinutes: appointmentServicesTable.plannedDurationMinutes,
    actualMinutes: appointmentServicesTable.actualDurationMinutes,
  })
    .from(appointmentServicesTable)
    .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
    .where(inArray(appointmentServicesTable.appointmentId, appointmentIds));

  for (const row of rows) {
    if (!grouped.has(row.appointmentId)) grouped.set(row.appointmentId, []);
    grouped.get(row.appointmentId)!.push({
      serviceCode: row.serviceCode,
      serviceName: row.serviceName,
      actualMinutes: row.actualMinutes,
      plannedMinutes: row.plannedMinutes,
    });
  }

  return grouped;
}
