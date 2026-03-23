import {
  type Customer,
  type InsertCustomer,
  customers,
  prospects,
  appointments,
  users,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { eq, count, sql as sqlBuilder, and, or, ilike, inArray, isNull, isNotNull } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { db } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import type { SearchOptions } from "../storage";

export async function getCustomers(): Promise<Customer[]> {
  return await db.select().from(customers).where(isNull(customers.deletedAt));
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

export async function getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean })[]> {
  const assignedIds = await getAssignedCustomerIds(employeeId);
  if (assignedIds.length === 0) return [];

  const customerRows = await db
    .select()
    .from(customers)
    .where(and(inArray(customers.id, assignedIds), isNull(customers.deletedAt)))
    .orderBy(customers.nachname, customers.vorname);

  return customerRows.map(c => ({
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

export async function searchCustomers(options: SearchOptions): Promise<Customer[]> {
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
    ),
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
