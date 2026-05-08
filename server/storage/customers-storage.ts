import {
  type Customer,
  type InsertCustomer,
  customers,
  customerInsuranceHistory,
  prospects,
  appointments,
  users,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { eq, count, sql as sqlBuilder, and, or, ilike, inArray, isNull, isNotNull, exists } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { db } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import type { SearchOptions } from "../storage";

export async function getCustomers(options?: { status?: string; search?: string }): Promise<(Customer & { versichertennummer: string | null })[]> {
  const conditions = [isNull(customers.deletedAt)];

  if (options?.status) {
    conditions.push(eq(customers.status, options.status));
  }

  if (options?.search) {
    const term = `%${options.search}%`;
    conditions.push(
      or(
        ilike(customers.name, term),
        ilike(customers.vorname, term),
        ilike(customers.nachname, term),
        ilike(customers.strasse, term),
        ilike(customers.stadt, term),
        // Versichertennummer (Task #403): nur aktuelle Versicherung
        // (validTo IS NULL) — historische VNRs dürfen die Trefferliste
        // nicht künstlich aufblähen.
        exists(
          db
            .select({ id: customerInsuranceHistory.id })
            .from(customerInsuranceHistory)
            .where(
              and(
                eq(customerInsuranceHistory.customerId, customers.id),
                isNull(customerInsuranceHistory.validTo),
                ilike(customerInsuranceHistory.versichertennummer, term),
              ),
            ),
        ),
      )!
    );
  }

  const rows = await db.select().from(customers).where(and(...conditions)).orderBy(customers.name);
  return await enrichWithCurrentVersichertennummer(rows);
}

async function enrichWithCurrentVersichertennummer<T extends { id: number }>(
  rows: T[],
): Promise<(T & { versichertennummer: string | null })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const vnrRows = await db
    .select({
      customerId: customerInsuranceHistory.customerId,
      versichertennummer: customerInsuranceHistory.versichertennummer,
    })
    .from(customerInsuranceHistory)
    .where(and(inArray(customerInsuranceHistory.customerId, ids), isNull(customerInsuranceHistory.validTo)));
  const vnrMap = new Map<number, string>();
  for (const r of vnrRows) vnrMap.set(r.customerId, r.versichertennummer);
  return rows.map(r => ({ ...r, versichertennummer: vnrMap.get(r.id) ?? null }));
}

export async function getCustomer(id: number): Promise<Customer | undefined> {
  const result = await db.select().from(customers).where(eq(customers.id, id));
  return result[0];
}

export async function createCustomer(customer: InsertCustomer): Promise<Customer> {
  const result = await db.insert(customers).values(customer).returning();
  const created = result[0];
  customerIdsCache.invalidateForCustomer(created.primaryEmployeeId, created.backupEmployeeId, created.backupEmployeeId2);
  return created;
}

export async function deleteCustomer(id: number): Promise<boolean> {
  const existing = await getCustomer(id);
  const result = await db
    .update(customers)
    .set({ deletedAt: new Date() })
    .where(eq(customers.id, id))
    .returning();
  if (result.length > 0 && existing) {
    customerIdsCache.invalidateForCustomer(existing.primaryEmployeeId, existing.backupEmployeeId, existing.backupEmployeeId2);
  }
  return result.length > 0;
}

export async function getCurrentlyAssignedCustomerIds(employeeId: number): Promise<number[]> {
  const result = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNull(customers.deletedAt),
        sqlBuilder`(${customers.primaryEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId} = ${employeeId} OR ${customers.backupEmployeeId2} = ${employeeId})`
      )
    );
  return result.map(r => r.id);
}

export async function getPrimaryCustomerIds(employeeId: number): Promise<number[]> {
  const cached = customerIdsCache.get(employeeId, "primary");
  if (cached !== undefined) {
    return cached;
  }

  const result = await db
    .selectDistinct({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNull(customers.deletedAt),
        eq(customers.primaryEmployeeId, employeeId),
      )
    );

  const ids = result.map(r => r.id);
  customerIdsCache.set(employeeId, ids, "primary");
  return ids;
}

export async function getAssignedCustomerIds(employeeId: number): Promise<number[]> {
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
          eq(customers.backupEmployeeId2, employeeId),
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

export async function getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean; versichertennummer: string | null })[]> {
  const assignedIds = await getAssignedCustomerIds(employeeId);
  if (assignedIds.length === 0) return [];

  const customerRows = await db
    .select()
    .from(customers)
    .where(and(inArray(customers.id, assignedIds), isNull(customers.deletedAt)))
    .orderBy(customers.nachname, customers.vorname);

  const enriched = await enrichWithCurrentVersichertennummer(customerRows);

  return enriched.map(c => ({
    ...c,
    isCurrentlyAssigned: c.primaryEmployeeId === employeeId || c.backupEmployeeId === employeeId || c.backupEmployeeId2 === employeeId,
  })).sort((a, b) => {
    const aLegacy = a.isCurrentlyAssigned ? 0 : 1;
    const bLegacy = b.isCurrentlyAssigned ? 0 : 1;
    if (aLegacy !== bLegacy) return aLegacy - bLegacy;
    const nachnameCompare = (a.nachname ?? '').localeCompare(b.nachname ?? '', 'de');
    if (nachnameCompare !== 0) return nachnameCompare;
    return (a.vorname ?? '').localeCompare(b.vorname ?? '', 'de');
  });
}

export async function getCustomersByIds(ids: number[]): Promise<Customer[]> {
  if (ids.length === 0) return [];
  return await db.select().from(customers).where(inArray(customers.id, ids));
}

export async function getActiveEmployeesWithBirthday(): Promise<{ id: number; displayName: string; geburtsdatum: string | null; strasse: string | null; hausnummer: string | null; plz: string | null; stadt: string | null }[]> {
  return await db
    .select({
      id: users.id,
      displayName: users.displayName,
      geburtsdatum: users.geburtsdatum,
      strasse: users.strasse,
      hausnummer: users.hausnummer,
      plz: users.plz,
      stadt: users.stadt,
    })
    .from(users)
    .where(and(
      eq(users.isActive, true),
      isNotNull(users.geburtsdatum)
    ));
}

export async function getActiveCustomersWithBirthday(): Promise<{ id: number; name: string; geburtsdatum: string | null; strasse: string | null; hausnummer: string | null; plz: string | null; stadt: string | null; primaryEmployeeId: number | null; backupEmployeeId: number | null; backupEmployeeId2: number | null }[]> {
  return await db
    .select({
      id: customers.id,
      name: customers.name,
      geburtsdatum: customers.geburtsdatum,
      strasse: customers.strasse,
      hausnummer: customers.nr,
      plz: customers.plz,
      stadt: customers.stadt,
      primaryEmployeeId: customers.primaryEmployeeId,
      backupEmployeeId: customers.backupEmployeeId,
      backupEmployeeId2: customers.backupEmployeeId2,
    })
    .from(customers)
    .where(and(isNotNull(customers.geburtsdatum), isNull(customers.deletedAt)));
}

export async function getAdminUserIds(): Promise<number[]> {
  const result = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
  return result.map(r => r.id);
}

export async function searchCustomers(options: SearchOptions): Promise<(Customer & { matchedVersichertennummer: string | null })[]> {
  const { query, assignedCustomerIds, limit = 5 } = options;
  if (assignedCustomerIds && assignedCustomerIds.length === 0) {
    return [];
  }
  const searchTerm = `%${query}%`;

  const conditions = [
    or(
      ilike(customers.name, searchTerm),
      ilike(customers.vorname, searchTerm),
      ilike(customers.nachname, searchTerm),
      // Versichertennummer (Task #403): nur aktuelle Versicherung
      // (validTo IS NULL) — historische VNRs dürfen die Trefferliste
      // nicht künstlich aufblähen.
      exists(
        db
          .select({ id: customerInsuranceHistory.id })
          .from(customerInsuranceHistory)
          .where(
            and(
              eq(customerInsuranceHistory.customerId, customers.id),
              isNull(customerInsuranceHistory.validTo),
              ilike(customerInsuranceHistory.versichertennummer, searchTerm),
            ),
          ),
      ),
    ),
  ];

  if (assignedCustomerIds) {
    conditions.push(inArray(customers.id, assignedCustomerIds));
  }

  conditions.push(isNull(customers.deletedAt));

  const rows = await db
    .select()
    .from(customers)
    .where(and(...conditions))
    .limit(limit);

  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const vnrRows = await db
    .select({
      customerId: customerInsuranceHistory.customerId,
      versichertennummer: customerInsuranceHistory.versichertennummer,
    })
    .from(customerInsuranceHistory)
    .where(
      and(
        inArray(customerInsuranceHistory.customerId, ids),
        isNull(customerInsuranceHistory.validTo),
        ilike(customerInsuranceHistory.versichertennummer, searchTerm),
      ),
    );
  const vnrMap = new Map<number, string>();
  for (const r of vnrRows) vnrMap.set(r.customerId, r.versichertennummer);

  return rows.map(r => ({ ...r, matchedVersichertennummer: vnrMap.get(r.id) ?? null }));
}

export async function searchAppointmentsWithCustomers(options: SearchOptions): Promise<AppointmentWithCustomer[]> {
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
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions))
    .limit(limit);

  return results.map(mapAppointmentRow);
}
