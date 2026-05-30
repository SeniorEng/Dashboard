import {
  type CustomerContact,
  type InsertCustomerContact,
  customerContacts,
} from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { db, type DbOrTx } from "../../lib/db";

export async function getCustomerContact(id: number, tx?: DbOrTx): Promise<CustomerContact | undefined> {
  const executor = tx ?? db;
  const result = await executor.select().from(customerContacts).where(eq(customerContacts.id, id));
  return result[0];
}

export async function getCustomerContacts(customerId: number, activeOnly = true): Promise<CustomerContact[]> {
  const conditions = [eq(customerContacts.customerId, customerId)];
  if (activeOnly) {
    conditions.push(eq(customerContacts.isActive, true));
  }
  
  return await db
    .select()
    .from(customerContacts)
    .where(and(...conditions))
    .orderBy(desc(customerContacts.isPrimary), customerContacts.sortOrder);
}

export async function addCustomerContact(data: InsertCustomerContact, tx?: DbOrTx): Promise<CustomerContact> {
  const executor = tx ?? db;
  if (data.isPrimary) {
    await executor
      .update(customerContacts)
      .set({ isPrimary: false })
      .where(eq(customerContacts.customerId, data.customerId));
  }

  const result = await executor.insert(customerContacts).values(data).returning();
  return result[0];
}

export async function updateCustomerContact(id: number, data: Partial<InsertCustomerContact>, tx?: DbOrTx): Promise<CustomerContact | undefined> {
  const executor = tx ?? db;
  if (data.isPrimary) {
    const existing = await executor.select().from(customerContacts).where(eq(customerContacts.id, id));
    if (existing.length > 0) {
      await executor
        .update(customerContacts)
        .set({ isPrimary: false })
        .where(eq(customerContacts.customerId, existing[0].customerId));
    }
  }
  
  const result = await executor
    .update(customerContacts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(customerContacts.id, id))
    .returning();
  return result[0];
}

export async function deleteCustomerContact(id: number, tx?: DbOrTx): Promise<boolean> {
  const executor = tx ?? db;
  const result = await executor
    .update(customerContacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(customerContacts.id, id))
    .returning();
  return result.length > 0;
}
