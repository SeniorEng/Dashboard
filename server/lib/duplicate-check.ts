import { db } from "./db";
import { customers, customerInsuranceHistory } from "@shared/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

interface DuplicateCustomer {
  id: number;
  vorname: string | null;
  nachname: string | null;
  geburtsdatum: string | null;
  stadt: string | null;
  strasse: string | null;
  nr: string | null;
  status: string;
  createdAt: Date;
}

export interface VersichertennummerDuplicateCustomer {
  id: number;
  vorname: string | null;
  nachname: string | null;
  geburtsdatum: string | null;
  stadt: string | null;
  status: string;
  versichertennummer: string;
}

export async function findCustomerByVersichertennummer(
  versichertennummer: string,
  excludeId?: number,
): Promise<VersichertennummerDuplicateCustomer[]> {
  const v = versichertennummer.trim();
  if (!v) return [];

  const conditions = [
    sql`UPPER(${customerInsuranceHistory.versichertennummer}) = UPPER(${v})`,
    isNull(customerInsuranceHistory.validTo),
    isNull(customers.deletedAt),
  ];
  if (excludeId !== undefined) {
    conditions.push(ne(customers.id, excludeId));
  }

  return db
    .select({
      id: customers.id,
      vorname: customers.vorname,
      nachname: customers.nachname,
      geburtsdatum: customers.geburtsdatum,
      stadt: customers.stadt,
      status: customers.status,
      versichertennummer: customerInsuranceHistory.versichertennummer,
    })
    .from(customerInsuranceHistory)
    .innerJoin(customers, eq(customers.id, customerInsuranceHistory.customerId))
    .where(and(...conditions))
    .limit(5);
}

export async function findCustomerDuplicates(
  vorname: string,
  nachname: string,
  geburtsdatum?: string | null,
  excludeId?: number,
): Promise<DuplicateCustomer[]> {
  const v = vorname.trim();
  const n = nachname.trim();
  if (!v || !n) return [];

  const conditions = [
    sql`LOWER(${customers.vorname}) = LOWER(${v})`,
    sql`LOWER(${customers.nachname}) = LOWER(${n})`,
    isNull(customers.deletedAt),
  ];
  if (geburtsdatum) {
    conditions.push(eq(customers.geburtsdatum, geburtsdatum));
  }
  if (excludeId !== undefined) {
    conditions.push(ne(customers.id, excludeId));
  }

  return db.select({
    id: customers.id,
    vorname: customers.vorname,
    nachname: customers.nachname,
    geburtsdatum: customers.geburtsdatum,
    stadt: customers.stadt,
    strasse: customers.strasse,
    nr: customers.nr,
    status: customers.status,
    createdAt: customers.createdAt,
  })
    .from(customers)
    .where(and(...conditions))
    .limit(5);
}
