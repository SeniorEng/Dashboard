import {
  type Invoice,
  type InvoiceLineItem,
} from "@shared/schema";
import { db, type DbOrTx } from "../lib/db";
import type { InvoiceWithCustomer } from "../storage";

export async function getInvoices(filters: { year?: number; month?: number; customerId?: number; status?: string }): Promise<InvoiceWithCustomer[]> {
  const { invoices, customers } = await import("@shared/schema");
  const { eq, and, asc, desc } = await import("drizzle-orm");
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters.year) conditions.push(eq(invoices.billingYear, filters.year));
  if (filters.month) conditions.push(eq(invoices.billingMonth, filters.month));
  if (filters.customerId) conditions.push(eq(invoices.customerId, filters.customerId));
  if (filters.status) conditions.push(eq(invoices.status, filters.status as string));

  const results = await db.select({
    invoice: invoices,
    customerName: customers.name,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(conditions.length > 0 ? and(...conditions) : undefined)
  .orderBy(desc(invoices.createdAt));

  return results.map(r => ({ ...r.invoice, customerName: r.customerName }));
}

export async function getInvoice(id: number): Promise<InvoiceWithCustomer | undefined> {
  const { invoices, customers } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const results = await db.select({
    invoice: invoices,
    customerName: customers.name,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(eq(invoices.id, id));
  if (results.length === 0) return undefined;
  return { ...results[0].invoice, customerName: results[0].customerName };
}

export async function createInvoiceTx(
  exec: DbOrTx,
  data: Record<string, unknown>,
  lineItems: Record<string, unknown>[],
  userId: number,
): Promise<Invoice> {
  const { invoices, invoiceLineItems } = await import("@shared/schema");
  const invoiceValues = { ...data, createdByUserId: userId } as typeof invoices.$inferInsert;
  const [invoice] = await exec.insert(invoices).values(invoiceValues).returning();

  if (lineItems.length > 0) {
    await exec.insert(invoiceLineItems).values(
      lineItems.map((item, idx) => ({
        ...item,
        invoiceId: invoice.id,
        sortOrder: idx,
      } as typeof invoiceLineItems.$inferInsert))
    );
  }

  return invoice;
}

export async function createInvoice(data: Record<string, unknown>, lineItems: Record<string, unknown>[], userId: number): Promise<Invoice> {
  return await db.transaction(async (tx) => createInvoiceTx(tx, data, lineItems, userId));
}

export async function updateInvoiceStatusTx(
  exec: DbOrTx,
  id: number,
  status: string,
  _userId: number,
): Promise<Invoice> {
  const { invoices } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const updateData: Partial<Invoice> = { status: status as Invoice["status"] };
  if (status === "versendet") updateData.sentAt = new Date();
  if (status === "bezahlt") updateData.paidAt = new Date();
  if (status === "storniert") updateData.storniertAt = new Date();
  const [updated] = await exec.update(invoices).set(updateData).where(eq(invoices.id, id)).returning();
  return updated;
}

export async function updateInvoiceStatus(id: number, status: string, userId: number): Promise<Invoice> {
  return updateInvoiceStatusTx(db, id, status, userId);
}

/**
 * Race-freie Vergabe der nächsten Rechnungsnummer pro `billingYear`.
 *
 * Die Funktion setzt einen PostgreSQL Transaction-Advisory-Lock pro Jahr
 * (`pg_advisory_xact_lock` über einen `hashtext`-basierten Schlüssel) BEVOR
 * sie die aktuelle Maximalnummer liest. Damit können konkurrierende Aufrufe
 * für dasselbe Jahr keine identische Nummer mehr ermitteln.
 *
 * WICHTIG: Der Lock ist Transaktions-scoped und wird beim Commit/Rollback
 * automatisch freigegeben. Damit der Lock auch das nachgelagerte
 * `INSERT INTO invoices` schützt, MUSS dieser Helper innerhalb derselben
 * Transaktion aufgerufen werden, in der die Rechnung später eingefügt wird.
 */
export async function getNextInvoiceNumberTx(exec: DbOrTx, year: number): Promise<string> {
  const { invoices } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");

  const lockKey = `invoice_number_${year}`;
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::int8)`);

  const result = await exec.select({
    maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0)`,
  })
  .from(invoices)
  .where(eq(invoices.billingYear, year));
  const next = (result[0]?.maxNum || 0) + 1;
  return `RE-${year}-${String(next).padStart(4, "0")}`;
}

/**
 * Backwards-kompatibler Wrapper. Standalone genutzt liefert die Funktion
 * eine zum Aufrufzeitpunkt freie Nummer; um Race-Conditions zu vermeiden,
 * sollte der Aufrufer den anschließenden Insert in DERSELBEN Transaktion
 * via `getNextInvoiceNumberTx` + `createInvoiceTx` durchführen.
 */
export async function getNextInvoiceNumber(year: number): Promise<string> {
  return await db.transaction(async (tx) => getNextInvoiceNumberTx(tx, year));
}

export async function getInvoiceLineItemsTx(exec: DbOrTx, invoiceId: number): Promise<InvoiceLineItem[]> {
  const { invoiceLineItems } = await import("@shared/schema");
  const { eq, asc } = await import("drizzle-orm");
  return await exec.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)).orderBy(asc(invoiceLineItems.sortOrder));
}

export async function getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]> {
  return getInvoiceLineItemsTx(db, invoiceId);
}

export async function getInvoicesForCustomerMonth(customerId: number, year: number, month: number): Promise<Invoice[]> {
  const { invoices } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");
  return await db.select().from(invoices).where(
    and(
      eq(invoices.customerId, customerId),
      eq(invoices.billingYear, year),
      eq(invoices.billingMonth, month)
    )
  );
}
