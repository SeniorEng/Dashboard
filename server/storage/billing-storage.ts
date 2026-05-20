import {
  type Invoice,
  type InvoiceLineItem,
} from "@shared/schema";
import { db, type DbOrTx, type Tx } from "../lib/db";
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
    customerVorname: customers.vorname,
    customerNachname: customers.nachname,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(conditions.length > 0 ? and(...conditions) : undefined)
  .orderBy(desc(invoices.createdAt));

  return results.map(r => ({
    ...r.invoice,
    customerName: r.customerName,
    customerVorname: r.customerVorname,
    customerNachname: r.customerNachname,
  }));
}

export async function getInvoice(id: number): Promise<InvoiceWithCustomer | undefined> {
  const { invoices, customers } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const results = await db.select({
    invoice: invoices,
    customerName: customers.name,
    customerVorname: customers.vorname,
    customerNachname: customers.nachname,
  })
  .from(invoices)
  .innerJoin(customers, eq(invoices.customerId, customers.id))
  .where(eq(invoices.id, id));
  if (results.length === 0) return undefined;
  return {
    ...results[0].invoice,
    customerName: results[0].customerName,
    customerVorname: results[0].customerVorname,
    customerNachname: results[0].customerNachname,
  };
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

// Tx-only: pg_advisory_xact_lock wird beim Commit/Rollback freigegeben.
// Erzwingt den Tx-Typ damit niemand versehentlich `db` übergibt — sonst wäre
// der Lock am Statement-Ende weg und MAX/Insert wieder race-anfällig.
export async function getNextInvoiceNumberTx(tx: Tx, year: number): Promise<string> {
  const { invoices } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");

  const lockKey = `invoice_number_${year}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::int8)`);

  const result = await tx.select({
    maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0)`,
  })
  .from(invoices)
  .where(eq(invoices.billingYear, year));
  const next = (result[0]?.maxNum || 0) + 1;
  return `RE-${year}-${String(next).padStart(4, "0")}`;
}

export async function getInvoiceLineItemsTx(exec: DbOrTx, invoiceId: number): Promise<InvoiceLineItem[]> {
  const { invoiceLineItems } = await import("@shared/schema");
  const { eq, asc } = await import("drizzle-orm");
  return await exec.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)).orderBy(asc(invoiceLineItems.sortOrder));
}

// Sperrt die Originalrechnung bis Commit/Rollback. Schützt vor Doppel-Storno
// derselben Rechnung in parallelen Tx (zwei PATCHs würden sonst beide den
// alten Status sehen und je eine Stornorechnung erzeugen).
export async function getInvoiceForUpdateTx(exec: DbOrTx, id: number): Promise<Invoice | undefined> {
  const { invoices } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await exec.select().from(invoices).where(eq(invoices.id, id)).for("update");
  return rows[0];
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
