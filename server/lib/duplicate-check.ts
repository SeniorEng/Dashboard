import { db } from "./db";
import { customers } from "@shared/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

export interface DuplicateCustomer {
  id: number;
  vorname: string;
  nachname: string;
  geburtsdatum: string | null;
  stadt: string | null;
  strasse: string | null;
  nr: string | null;
  status: string | null;
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
  })
    .from(customers)
    .where(and(...conditions))
    .limit(5);
}
