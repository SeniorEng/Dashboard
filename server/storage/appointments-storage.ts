import {
  type Appointment,
  type InsertAppointment,
  type UpdateAppointment,
  customers,
  appointments,
  prospects,
} from "@shared/schema";
import type { AppointmentWithCustomer, PaginatedResult } from "@shared/types";
import { eq, count, sql as sqlBuilder, lt, gte, ne, and, or, inArray, isNull, asc } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { db, type DbOrTx } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import type { PaginationOptions } from "../storage";
import { badRequest } from "../lib/errors";
import { appointmentsRepo } from "../repos";

const APPOINTMENT_PERSON_REQUIRED_MESSAGE =
  "Ein Termin muss entweder mit einem Kunden oder einem Interessenten verknüpft sein.";

export async function getAppointments(): Promise<Appointment[]> {
  return await appointmentsRepo.selectFrom(db).where(isNull(appointments.deletedAt));
}

export async function getAppointment(id: number): Promise<Appointment | undefined> {
  const result = await appointmentsRepo.selectFrom(db).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));
  return result[0];
}

export async function getAppointmentIncludeDeleted(id: number): Promise<Appointment | undefined> {
  const result = await appointmentsRepo.selectFrom(db).where(eq(appointments.id, id));
  return result[0];
}

export async function getAppointmentsByDate(date: string): Promise<Appointment[]> {
  return await appointmentsRepo.selectFrom(db).where(and(eq(appointments.date, date), isNull(appointments.deletedAt), ne(appointments.status, "cancelled")));
}

function buildEmployeeCondition(employeeId: number | number[] | undefined, assignedOnly?: boolean) {
  if (employeeId === undefined) return undefined;
  const ids = Array.isArray(employeeId) ? employeeId : [employeeId];
  if (ids.length === 0) return undefined;

  const assignedExpr = ids.length === 1
    ? eq(appointments.assignedEmployeeId, ids[0])
    : inArray(appointments.assignedEmployeeId, ids);

  if (assignedOnly) return assignedExpr;

  const performedExpr = ids.length === 1
    ? eq(appointments.performedByEmployeeId, ids[0])
    : inArray(appointments.performedByEmployeeId, ids);

  return or(assignedExpr, performedExpr)!;
}

function applyVisibilityFilters(conditions: ReturnType<typeof and>[], customerIds?: number[], employeeId?: number | number[], assignedOnly?: boolean) {
  const employeeCondition = buildEmployeeCondition(employeeId, assignedOnly);

  if (assignedOnly) {
    // Strikte UND-Verknüpfung: nur Termine, die sowohl im Mitarbeiter-Scope
    // liegen als auch (falls gefiltert) zu den erlaubten Kunden gehören.
    if (employeeCondition) conditions.push(employeeCondition);
    if (customerIds && customerIds.length > 0) {
      conditions.push(inArray(appointments.customerId, customerIds));
    }
  } else if (customerIds && customerIds.length > 0 && employeeCondition) {
    conditions.push(or(inArray(appointments.customerId, customerIds), employeeCondition)!);
  } else if (customerIds && customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, customerIds));
  } else if (employeeCondition) {
    conditions.push(employeeCondition);
  }
}

export async function getAppointmentCountsByDates(dates: string[], customerIds?: number[], employeeId?: number | number[], assignedOnly?: boolean): Promise<Record<string, number>> {
  if (dates.length === 0) return {};

  const conditions = [inArray(appointments.date, dates), isNull(appointments.deletedAt), ne(appointments.status, "cancelled")];
  applyVisibilityFilters(conditions, customerIds, employeeId, assignedOnly);

  const results = await appointmentsRepo.selectColumnsFrom({
      date: appointments.date,
      count: count(),
    }, db)
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

export async function createAppointment(appointment: InsertAppointment, tx?: DbOrTx): Promise<Appointment> {
  if (appointment.customerId == null && appointment.prospectId == null) {
    throw badRequest(APPOINTMENT_PERSON_REQUIRED_MESSAGE);
  }
  const client = tx || db;
  const result = await client.insert(appointments).values(appointment).returning();
  if (appointment.assignedEmployeeId) {
    customerIdsCache.invalidateForEmployee(appointment.assignedEmployeeId);
  }
  return result[0];
}

export async function updateAppointment(id: number, appointment: UpdateAppointment, tx?: DbOrTx): Promise<Appointment | undefined> {
  const client = tx || db;

  const customerKey = "customerId" in appointment;
  const prospectKey = "prospectId" in appointment;
  const nullsCustomer = customerKey && appointment.customerId == null;
  const nullsProspect = prospectKey && appointment.prospectId == null;

  if (nullsCustomer || nullsProspect) {
    const existing = await appointmentsRepo.selectColumnsFrom({ customerId: appointments.customerId, prospectId: appointments.prospectId }, client)
      .where(eq(appointments.id, id));
    if (existing.length > 0) {
      const finalCustomerId = customerKey ? appointment.customerId : existing[0].customerId;
      const finalProspectId = prospectKey ? appointment.prospectId : existing[0].prospectId;
      if (finalCustomerId == null && finalProspectId == null) {
        throw badRequest(APPOINTMENT_PERSON_REQUIRED_MESSAGE);
      }
    }
  }

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

export async function getAppointmentsWithCustomers(date?: string, customerIds?: number[], employeeId?: number | number[], assignedOnly?: boolean): Promise<AppointmentWithCustomer[]> {
  const conditions = [isNull(appointments.deletedAt), ne(appointments.status, "cancelled")];
  if (date) {
    conditions.push(eq(appointments.date, date));
  }

  applyVisibilityFilters(conditions, customerIds, employeeId, assignedOnly);

  const query = appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
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
    ? await appointmentsRepo.selectColumnsFrom({ count: count() }, db).where(and(eq(appointments.date, date), isNull(appointments.deletedAt), ne(appointments.status, "cancelled")))
    : await appointmentsRepo.selectColumnsFrom({ count: count() }, db).where(and(isNull(appointments.deletedAt), ne(appointments.status, "cancelled")));

  const total = Number(countResult[0]?.count ?? 0);

  let query = appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .limit(limit)
    .offset(offset);

  const results = date
    ? await query.where(and(eq(appointments.date, date), isNull(appointments.deletedAt), ne(appointments.status, "cancelled")))
    : await query.where(and(isNull(appointments.deletedAt), ne(appointments.status, "cancelled")));

  const data = results.map(mapAppointmentRow);

  return { data, total, limit, offset };
}

export async function getAppointmentWithCustomer(id: number): Promise<AppointmentWithCustomer | undefined> {
  const results = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));

  if (results.length === 0) return undefined;

  return mapAppointmentRow(results[0]);
}

export async function getUndocumentedAppointments(beforeDate: string, customerIds?: number[], employeeId?: number | number[], assignedOnly?: boolean): Promise<AppointmentWithCustomer[]> {
  const conditions = [
    lt(appointments.date, beforeDate),
    ne(appointments.status, "completed"),
    isNull(appointments.deletedAt)
  ];

  const employeeCondition = buildEmployeeCondition(employeeId, assignedOnly);
  if (employeeCondition) {
    conditions.push(employeeCondition);
  } else if (customerIds && customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, customerIds));
  }

  const results = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions));

  return results.map(mapAppointmentRow);
}

export async function getPlannedConsultations(filter: "overdue" | "upcoming" | "all", today: string): Promise<AppointmentWithCustomer[]> {
  const conditions = [
    isNull(appointments.deletedAt),
    eq(appointments.appointmentType, "Erstberatung"),
    eq(appointments.status, "scheduled"),
  ];

  if (filter === "overdue") {
    conditions.push(lt(appointments.date, today));
  } else if (filter === "upcoming") {
    conditions.push(gte(appointments.date, today));
  }

  const results = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions))
    .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

  return results.map(mapAppointmentRow);
}

export async function getAppointmentsForDay(employeeId: number, date: string): Promise<AppointmentWithCustomer[]> {
  const rows = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(
      eq(appointments.date, date),
      or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.performedByEmployeeId, employeeId),
      ),
      isNull(appointments.deletedAt),
      ne(appointments.status, "cancelled")
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

export async function createAppointmentServices(
  appointmentId: number,
  services: { serviceId: number; plannedDurationMinutes: number }[],
  tx?: DbOrTx,
): Promise<void> {
  if (services.length === 0) return;
  const { appointmentServices } = await import("@shared/schema");
  const client = tx || db;
  await client.insert(appointmentServices).values(
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
  const { eq, and, notInArray } = await import("drizzle-orm");

  const runUpdates = async (client: DbOrTx) => {
    // Bestehende Service-Zeilen laden, um zwischen Update und Insert zu
    // unterscheiden. Hintergrund: Bei der Korrektur eines bereits
    // dokumentierten Termins (über „Dokumentation korrigieren") kann der
    // Admin einen Service durch einen anderen ersetzen
    // (z. B. Hauswirtschaft → Alltagsbegleitung). Ein reines UPDATE per
    // (appointmentId, serviceId) würde dann 0 Zeilen treffen, der alte
    // Service bliebe unverändert stehen und der neue Service würde nie
    // gespeichert. Deshalb diff-basiert: Vorhandene Zeilen aktualisieren,
    // neue Services einfügen, weggefallene Services entfernen.
    const existing = await client
      .select({ serviceId: appointmentServices.serviceId })
      .from(appointmentServices)
      .where(eq(appointmentServices.appointmentId, appointmentId));
    const existingServiceIds = new Set(existing.map(e => e.serviceId));
    const submittedServiceIds = serviceUpdates.map(su => su.serviceId);

    const toInsert = serviceUpdates.filter(su => !existingServiceIds.has(su.serviceId));
    const toUpdate = serviceUpdates.filter(su => existingServiceIds.has(su.serviceId));

    await Promise.all(toUpdate.map(su =>
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

    if (toInsert.length > 0) {
      // Neu eingefügte Service-Zeilen entstehen ausschließlich bei
      // Korrekturen. Da das Frontend keinen separaten geplanten Wert
      // mitschickt, übernehmen wir die tatsächliche Dauer auch als
      // geplante Dauer, damit `appointment_services.planned_duration_minutes`
      // (NOT NULL) konsistent bleibt und die Summe der Planminuten zum
      // neuen `appointments.duration_promised` passt.
      await client.insert(appointmentServices).values(toInsert.map(su => ({
        appointmentId,
        serviceId: su.serviceId,
        plannedDurationMinutes: su.actualDurationMinutes,
        actualDurationMinutes: su.actualDurationMinutes,
        details: su.details ?? null,
      })));
    }

    // Service-Zeilen entfernen, die in der Korrektur nicht mehr enthalten
    // sind (z. B. Hauswirtschaft wurde komplett durch Alltagsbegleitung
    // ersetzt). Cascade-Effekte gibt es hier nicht, weil
    // `appointment_services` keine abgeleiteten Buchungen hält — die
    // Budget-Reverse-Logik läuft separat im Reopen-Endpoint.
    await client.delete(appointmentServices).where(
      and(
        eq(appointmentServices.appointmentId, appointmentId),
        notInArray(appointmentServices.serviceId, submittedServiceIds),
      )
    );

    // `appointments.duration_promised` an die neue Service-Konstellation
    // angleichen, damit Planungs-Sicht (Summe Planminuten) und
    // Termin-Header konsistent bleiben. Bei Korrekturen, die keinen Service
    // austauschen, ändert sich der Wert in der Praxis nicht.
    const rows = await client
      .select({ planned: appointmentServices.plannedDurationMinutes })
      .from(appointmentServices)
      .where(eq(appointmentServices.appointmentId, appointmentId));
    const newPlannedTotal = rows.reduce((sum, r) => sum + (r.planned ?? 0), 0);
    if (newPlannedTotal > 0) {
      await client.update(appointments)
        .set({ durationPromised: newPlannedTotal })
        .where(eq(appointments.id, appointmentId));
    }
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
