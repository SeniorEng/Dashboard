import {
  type MonthlyServiceRecord,
  type InsertServiceRecord,
  type ServiceRecordStatus,
  customers,
  appointments,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { computeDataHash } from "../services/signature-integrity";
import { eq, sql as sqlBuilder, ne, and, or, inArray, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import { getAssignedCustomerIds } from "./customers-storage";
import type { ServiceRecordOverviewItem } from "../storage";

export async function getServiceRecordsForEmployee(employeeId: number, year?: number, month?: number, customerId?: number): Promise<MonthlyServiceRecord[]> {
  let conditions = [eq(monthlyServiceRecords.employeeId, employeeId), isNull(monthlyServiceRecords.deletedAt)];
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

export async function getServiceRecordsForCustomer(customerId: number): Promise<MonthlyServiceRecord[]> {
  return await db.select()
    .from(monthlyServiceRecords)
    .where(and(eq(monthlyServiceRecords.customerId, customerId), isNull(monthlyServiceRecords.deletedAt)))
    .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
}

export async function getServiceRecord(id: number): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.select()
    .from(monthlyServiceRecords)
    .where(and(eq(monthlyServiceRecords.id, id), isNull(monthlyServiceRecords.deletedAt)));
  return result[0];
}

export async function getServiceRecordByPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.select()
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.customerId, customerId),
      eq(monthlyServiceRecords.employeeId, employeeId),
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
      eq(monthlyServiceRecords.recordType, "monthly"),
      isNull(monthlyServiceRecords.deletedAt)
    ));
  return result[0];
}

export async function createServiceRecord(record: InsertServiceRecord): Promise<MonthlyServiceRecord> {
  const result = await db.insert(monthlyServiceRecords)
    .values({
      customerId: record.customerId,
      employeeId: record.employeeId,
      year: record.year,
      month: record.month,
      recordType: record.recordType ?? "monthly",
      status: "pending",
    })
    .returning();
  return result[0];
}

export async function signServiceRecord(id: number, signatureData: string, signerType: 'employee' | 'customer', userId?: number, signingIp?: string | null, signingLocation?: string | null): Promise<MonthlyServiceRecord | undefined> {
  const existing = await getServiceRecord(id);
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
      employeeSigningIp: signingIp ?? null,
      employeeSigningLocation: signingLocation ?? null,
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
      customerSigningIp: signingIp ?? null,
      customerSigningLocation: signingLocation ?? null,
      status: 'completed' as ServiceRecordStatus,
    };
  }

  const result = await db.update(monthlyServiceRecords)
    .set(updateData)
    .where(eq(monthlyServiceRecords.id, id))
    .returning();
  return result[0];
}

export async function updateServiceRecord(id: number, data: Record<string, unknown>): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.update(monthlyServiceRecords)
    .set(data as any)
    .where(eq(monthlyServiceRecords.id, id))
    .returning();
  return result[0];
}

export async function getAppointmentsForServiceRecord(serviceRecordId: number): Promise<AppointmentWithCustomer[]> {
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

export async function addAppointmentsToServiceRecord(serviceRecordId: number, appointmentIds: number[]): Promise<void> {
  if (appointmentIds.length === 0) return;

  const values = appointmentIds.map(appointmentId => ({
    serviceRecordId,
    appointmentId,
  }));

  await db.insert(serviceRecordAppointments)
    .values(values)
    .onConflictDoNothing();
}

export async function getDocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]> {
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

export async function getUndocumentedAppointmentsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<AppointmentWithCustomer[]> {
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

export async function getPendingServiceRecords(employeeId: number): Promise<MonthlyServiceRecord[]> {
  return await db.select()
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.employeeId, employeeId),
      ne(monthlyServiceRecords.status, 'completed'),
      isNull(monthlyServiceRecords.deletedAt)
    ))
    .orderBy(monthlyServiceRecords.year, monthlyServiceRecords.month);
}

export async function getAppointmentIdsInServiceRecords(appointmentIds: number[]): Promise<number[]> {
  if (appointmentIds.length === 0) return [];
  const rows = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      inArray(serviceRecordAppointments.appointmentId, appointmentIds),
      isNull(monthlyServiceRecords.deletedAt)
    ));
  return rows.map(r => r.appointmentId);
}

export async function getServiceRecordForAppointment(appointmentId: number): Promise<MonthlyServiceRecord | undefined> {
  const result = await db.select({ record: monthlyServiceRecords })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt)
    ))
    .limit(1);
  return result[0]?.record;
}

export async function isAppointmentLocked(appointmentId: number): Promise<boolean> {
  const result = await db.select({
    serviceRecordId: serviceRecordAppointments.serviceRecordId,
    status: monthlyServiceRecords.status,
  })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .where(and(
      eq(serviceRecordAppointments.appointmentId, appointmentId),
      isNull(monthlyServiceRecords.deletedAt),
      or(
        eq(monthlyServiceRecords.status, 'employee_signed'),
        eq(monthlyServiceRecords.status, 'completed')
      )
    ))
    .limit(1);

  return result.length > 0;
}

export async function getServiceRecordsOverview(employeeId: number, year: number, month: number): Promise<ServiceRecordOverviewItem[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const assignedCustomerIds = await getAssignedCustomerIds(employeeId);
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
      inArray(customers.id, assignedCustomerIds)
    ))
    .groupBy(customers.id, customers.vorname, customers.nachname);

  const existingRecords = await db.select({
    customerId: monthlyServiceRecords.customerId,
    id: monthlyServiceRecords.id,
    status: monthlyServiceRecords.status,
    recordType: monthlyServiceRecords.recordType,
  })
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.employeeId, employeeId),
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
      inArray(monthlyServiceRecords.customerId, assignedCustomerIds),
      isNull(monthlyServiceRecords.deletedAt)
    ));

  const monthlyRecordMap = new Map<number, { id: number; status: string }>();
  const singleRecordsMap = new Map<number, { id: number; status: string; recordType: string }[]>();

  for (const r of existingRecords) {
    if (r.recordType === "monthly") {
      monthlyRecordMap.set(r.customerId, { id: r.id, status: r.status });
    } else {
      const existing = singleRecordsMap.get(r.customerId) ?? [];
      existing.push({ id: r.id, status: r.status, recordType: r.recordType });
      singleRecordsMap.set(r.customerId, existing);
    }
  }

  const customerHasAnyRecord = new Set(existingRecords.map(r => r.customerId));

  const allRecordIds = existingRecords.map(r => r.id);

  let coveredBySingleByCustomer = new Map<number, number>();
  let coveredByMonthlyByCustomer = new Map<number, number>();

  if (allRecordIds.length > 0) {
    const coveredRows = await db.select({
      customerId: appointments.customerId,
      recordType: monthlyServiceRecords.recordType,
      count: sqlBuilder<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
    })
      .from(serviceRecordAppointments)
      .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
      .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
      .where(inArray(serviceRecordAppointments.serviceRecordId, allRecordIds))
      .groupBy(appointments.customerId, monthlyServiceRecords.recordType);

    for (const row of coveredRows) {
      if (row.recordType === "single") {
        coveredBySingleByCustomer.set(row.customerId!, row.count);
      } else {
        coveredByMonthlyByCustomer.set(row.customerId!, row.count);
      }
    }
  }

  return overviewData
    .filter(item => item.totalAppointments > 0 || customerHasAnyRecord.has(item.customerId))
    .map(item => {
      const monthlyRecord = monthlyRecordMap.get(item.customerId);
      const singleRecords = singleRecordsMap.get(item.customerId) ?? [];
      const coveredBySingleCount = coveredBySingleByCustomer.get(item.customerId) ?? 0;
      const coveredByMonthlyCount = coveredByMonthlyByCustomer.get(item.customerId) ?? 0;
      return {
        customerId: item.customerId,
        customerName: `${item.vorname} ${item.nachname}`,
        existingRecordId: monthlyRecord?.id ?? null,
        existingRecordStatus: monthlyRecord?.status ?? null,
        singleRecords,
        documentedCount: item.documentedCount,
        undocumentedCount: item.undocumentedCount,
        totalAppointments: item.totalAppointments,
        coveredBySingleCount,
        coveredByMonthlyCount,
      };
    });
}

export async function getAppointmentCountsForPeriod(customerId: number, employeeId: number, year: number, month: number): Promise<{ documentedCount: number; undocumentedCount: number }> {
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

export async function getCoveredBySingleCount(customerId: number, employeeId: number, year: number, month: number): Promise<number> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const result = await db.select({
    count: sqlBuilder<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
  })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
    .where(and(
      eq(monthlyServiceRecords.recordType, "single"),
      eq(appointments.customerId, customerId),
      or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.createdByUserId, employeeId)
      ),
      sqlBuilder`${appointments.date} >= ${startDate}`,
      sqlBuilder`${appointments.date} < ${endDate}`,
      isNull(monthlyServiceRecords.deletedAt),
      isNull(appointments.deletedAt)
    ));

  return result[0]?.count ?? 0;
}

export async function getCoveredByMonthlyCount(customerId: number, employeeId: number, year: number, month: number): Promise<number> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const result = await db.select({
    count: sqlBuilder<number>`COUNT(DISTINCT ${serviceRecordAppointments.appointmentId})::int`,
  })
    .from(serviceRecordAppointments)
    .innerJoin(monthlyServiceRecords, eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id))
    .innerJoin(appointments, eq(serviceRecordAppointments.appointmentId, appointments.id))
    .where(and(
      eq(monthlyServiceRecords.recordType, "monthly"),
      eq(appointments.customerId, customerId),
      or(
        eq(appointments.assignedEmployeeId, employeeId),
        eq(appointments.createdByUserId, employeeId)
      ),
      sqlBuilder`${appointments.date} >= ${startDate}`,
      sqlBuilder`${appointments.date} < ${endDate}`,
      isNull(monthlyServiceRecords.deletedAt),
      isNull(appointments.deletedAt)
    ));

  return result[0]?.count ?? 0;
}
