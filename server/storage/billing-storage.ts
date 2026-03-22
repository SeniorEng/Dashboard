import {
  type Invoice,
  type InvoiceLineItem,
} from "@shared/schema";
import { db } from "../lib/db";
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

export async function createInvoice(data: Record<string, unknown>, lineItems: Record<string, unknown>[], userId: number): Promise<Invoice> {
  const { invoices, invoiceLineItems } = await import("@shared/schema");
  return await db.transaction(async (tx) => {
    const invoiceValues = { ...data, createdByUserId: userId } as typeof invoices.$inferInsert;
    const [invoice] = await tx.insert(invoices).values(invoiceValues).returning();

    if (lineItems.length > 0) {
      await tx.insert(invoiceLineItems).values(
        lineItems.map((item, idx) => ({
          ...item,
          invoiceId: invoice.id,
          sortOrder: idx,
        } as typeof invoiceLineItems.$inferInsert))
      );
    }

    return invoice;
  });
}

export async function updateInvoiceStatus(id: number, status: string, userId: number): Promise<Invoice> {
  const { invoices } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const updateData: Partial<Invoice> = { status: status as Invoice["status"] };
  if (status === "versendet") updateData.sentAt = new Date();
  if (status === "bezahlt") updateData.paidAt = new Date();
  if (status === "storniert") updateData.storniertAt = new Date();
  const [updated] = await db.update(invoices).set(updateData).where(eq(invoices.id, id)).returning();
  return updated;
}

export async function getNextInvoiceNumber(year: number): Promise<string> {
  const { invoices } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");
  const result = await db.select({
    maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM 'RE-\\d{4}-(\\d+)') AS INTEGER)), 0)`,
  })
  .from(invoices)
  .where(eq(invoices.billingYear, year));
  const next = (result[0]?.maxNum || 0) + 1;
  return `RE-${year}-${String(next).padStart(4, "0")}`;
}

export async function getInvoiceLineItems(invoiceId: number): Promise<InvoiceLineItem[]> {
  const { invoiceLineItems } = await import("@shared/schema");
  const { eq, asc } = await import("drizzle-orm");
  return await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)).orderBy(asc(invoiceLineItems.sortOrder));
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
