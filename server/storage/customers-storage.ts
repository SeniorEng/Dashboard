import {
  type Customer,
  type InsertCustomer,
  customers,
  customerContracts,
  customerInsuranceHistory,
  prospects,
  appointments,
  users,
} from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { eq, count, sql as sqlBuilder, and, or, ilike, inArray, isNull, isNotNull, exists, desc } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { db } from "../lib/db";
import { appointmentWithCustomerSelectFields, mapAppointmentRow } from "./appointment-helpers";
import type { SearchOptions } from "../storage";
import { appointmentsRepo, customersRepo } from "../repos";

export async function getCustomers(options?: { status?: string; search?: string }): Promise<(Customer & { versichertennummer: string | null; contractEnd: string | null; contractStatus: string | null })[]> {
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

  const rows = await customersRepo.selectFrom(db).where(and(...conditions)).orderBy(customers.name);
  const withVnr = await enrichWithCurrentVersichertennummer(rows);
  return await enrichWithLatestContract(withVnr);
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

/**
 * Task #1194 — Reichert Kundenzeilen mit Vertragsende + Kündigungs-Status des
 * jüngsten Vertrags an (nach contractStart, dann id). Basis für die
 * Lebenszyklus-Klassifikation aktiver Kunden (laufend vs. gekündigt) in der
 * Mitarbeiter-/Admin-Listenansicht.
 */
async function enrichWithLatestContract<T extends { id: number }>(
  rows: T[],
): Promise<(T & { contractEnd: string | null; contractStatus: string | null })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const contractRows = await db
    .selectDistinctOn([customerContracts.customerId], {
      customerId: customerContracts.customerId,
      contractEnd: customerContracts.contractEnd,
      contractStatus: customerContracts.status,
    })
    .from(customerContracts)
    .where(inArray(customerContracts.customerId, ids))
    .orderBy(
      customerContracts.customerId,
      desc(customerContracts.contractStart),
      desc(customerContracts.id),
    );
  const map = new Map<number, { contractEnd: string | null; contractStatus: string }>();
  for (const r of contractRows) {
    map.set(r.customerId, { contractEnd: r.contractEnd ?? null, contractStatus: r.contractStatus });
  }
  // Vertragsstatus DURCHREICHEN statt auf ein Boolean verdichten.
  //
  // Vorher stand hier `contractTerminated: c?.contractStatus === "terminated"`.
  // Damit war die Information „paused" schon vor der Klassifikation weg — der
  // Lebenszyklus KONNTE einen pausierten Kunden gar nicht erkennen und wies ihn
  // als „laufend" aus. Die Verdichtung war die eigentliche Ursache, nicht die
  // Klassifikation.
  return rows.map(r => {
    const c = map.get(r.id);
    return {
      ...r,
      contractEnd: c?.contractEnd ?? null,
      contractStatus: c?.contractStatus ?? null,
    };
  });
}

export async function getCustomer(id: number): Promise<Customer | undefined> {
  const result = await customersRepo.selectFrom(db).where(eq(customers.id, id));
  return result[0];
}

export async function createCustomer(customer: InsertCustomer): Promise<Customer> {
  // Task #512: Defense-in-depth — gleiche Invariante wie in
  // customerManagementStorage.createCustomerDirect (Erstberatung-Kunden
  // brauchen Prospect-Link). Wir importieren den Helper inline statt
  // top-level, um Circular-Imports zwischen customers-storage und
  // customer-management zu vermeiden.
  const { assertErstberatungHasProspectLink } = await import("./customer-management");
  assertErstberatungHasProspectLink(customer.status, customer.convertedFromProspectId);
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
  const result = await customersRepo.selectColumnsFrom({ id: customers.id }, db)
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

  // customers.id ist Primary Key — `.select({id})` ist äquivalent zu `.selectDistinct({id})`.
  const result = await customersRepo.selectColumnsFrom({ id: customers.id })
    .where(
      and(
        customersRepo.activeOnly(),
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

  const result = await customersRepo.selectColumnsFrom({ id: customers.id })
    .where(
      and(
        isNull(customers.deletedAt),
        or(
          eq(customers.primaryEmployeeId, employeeId),
          eq(customers.backupEmployeeId, employeeId),
          eq(customers.backupEmployeeId2, employeeId),
          inArray(customers.id,
            appointmentsRepo.selectColumnsFrom({ id: appointments.customerId }, db)
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

export async function getCustomersForEmployee(employeeId: number): Promise<(Customer & { isCurrentlyAssigned: boolean; versichertennummer: string | null; contractEnd: string | null; contractStatus: string | null })[]> {
  const assignedIds = await getAssignedCustomerIds(employeeId);
  if (assignedIds.length === 0) return [];

  const customerRows = await customersRepo.selectFrom(db)
    .where(and(inArray(customers.id, assignedIds), isNull(customers.deletedAt)))
    .orderBy(customers.nachname, customers.vorname);

  const withVnr = await enrichWithCurrentVersichertennummer(customerRows);
  const enriched = await enrichWithLatestContract(withVnr);

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
  return await customersRepo.selectFrom(db).where(inArray(customers.id, ids));
}

export async function getActiveEmployeesWithBirthday(): Promise<{ id: number; displayName: string; geburtsdatum: string | null; strasse: string | null; hausnummer: string | null; plz: string | null; stadt: string | null; createdAt: Date }[]> {
  return await db
    .select({
      id: users.id,
      displayName: users.displayName,
      geburtsdatum: users.geburtsdatum,
      strasse: users.strasse,
      hausnummer: users.hausnummer,
      plz: users.plz,
      stadt: users.stadt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(
      eq(users.isActive, true),
      isNotNull(users.geburtsdatum)
    ));
}

/**
 * Kunden mit Geburtsdatum — samt der Eingaben für die Lebenszyklus-SSoT.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * `getActiveCustomersWithBirthday`. Der Name behauptete einen Aktiv-Filter, die
 * Bedingung war aber nur `deleted_at IS NULL` — gekündigte, pausierte und auf
 * `inaktiv` gesetzte Kunden waren allesamt enthalten. Wer den Namen las und ihm
 * glaubte, irrte; genau das ist in den Geburtstags-Ansichten passiert.
 *
 * Die Funktion filtert jetzt bewusst NICHT selbst, sondern liefert `status`,
 * `contractEnd` und `contractStatus`. Wer aktiv braucht, fragt die SSoT
 * (`isLaufenderAktiverKunde`) — eine Bedingung, an einer Stelle, für beide
 * Ansichten.
 */
export interface BirthdayCustomerRow {
  id: number;
  name: string;
  geburtsdatum: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  createdAt: Date;
  /** Zuweisungen — vom Benachrichtigungs-Dienst gebraucht, nicht von den Ansichten. */
  primaryEmployeeId: number | null;
  backupEmployeeId: number | null;
  backupEmployeeId2: number | null;
  /** Eingaben der Lebenszyklus-SSoT (`classifyActiveCustomerLifecycle`). */
  status: string | null;
  contractEnd: string | null;
  contractStatus: string | null;
}

async function selectBirthdayCustomers(
  zusatzBedingung?: ReturnType<typeof and>,
): Promise<BirthdayCustomerRow[]> {
  const rows = await customersRepo.selectColumnsFrom({
      id: customers.id,
      name: customers.name,
      geburtsdatum: customers.geburtsdatum,
      strasse: customers.strasse,
      hausnummer: customers.nr,
      plz: customers.plz,
      stadt: customers.stadt,
      createdAt: customers.createdAt,
      primaryEmployeeId: customers.primaryEmployeeId,
      backupEmployeeId: customers.backupEmployeeId,
      backupEmployeeId2: customers.backupEmployeeId2,
      status: customers.status,
    }, db)
    .where(and(isNotNull(customers.geburtsdatum), isNull(customers.deletedAt), zusatzBedingung));
  return await enrichWithLatestContract(rows);
}

/** Alle nicht gelöschten Kunden mit Geburtsdatum (Admin-Sicht). */
export async function getCustomersWithBirthday(): Promise<BirthdayCustomerRow[]> {
  return await selectBirthdayCustomers();
}

/**
 * Dieselbe Form, eingegrenzt auf eine ID-Menge (Mitarbeiter-Sicht).
 *
 * Die Eingrenzung ist AUSSCHLIESSLICH die übergebene ID-Menge — welche IDs das
 * sind, entscheidet weiterhin `getAssignedCustomerIds`. Diese Funktion weiß
 * nichts über Zuweisungen und darf es auch nicht: sonst wanderte das Scoping in
 * zwei Funktionen.
 */
export async function getCustomersWithBirthdayByIds(ids: number[]): Promise<BirthdayCustomerRow[]> {
  if (ids.length === 0) return [];
  return await selectBirthdayCustomers(and(inArray(customers.id, ids)));
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

  const rows = await customersRepo.selectFrom(db)
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

  const results = await appointmentsRepo.selectColumnsFrom(appointmentWithCustomerSelectFields, db)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .where(and(...conditions))
    .limit(limit);

  return results.map(mapAppointmentRow);
}
