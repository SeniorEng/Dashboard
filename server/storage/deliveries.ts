import { db } from "../lib/db";
import { documentDeliveries } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import type { DocumentDelivery, InsertDocumentDelivery } from "@shared/schema";

class DeliveryStorage {
  async createDelivery(data: InsertDocumentDelivery): Promise<DocumentDelivery> {
    const [result] = await db.insert(documentDeliveries).values(data).returning();
    return result;
  }

  async updateDeliveryStatus(
    id: number,
    updates: { status: string; errorMessage?: string | null; sentAt?: Date | null; deliveredAt?: Date | null; epostLetterId?: string | null }
  ): Promise<DocumentDelivery | null> {
    const [result] = await db
      .update(documentDeliveries)
      .set(updates)
      .where(eq(documentDeliveries.id, id))
      .returning();
    return result || null;
  }

  async getDeliveriesByCustomer(customerId: number): Promise<DocumentDelivery[]> {
    return db
      .select()
      .from(documentDeliveries)
      .where(eq(documentDeliveries.customerId, customerId))
      .orderBy(desc(documentDeliveries.createdAt));
  }

  async getDeliveryById(id: number): Promise<DocumentDelivery | null> {
    const [result] = await db
      .select()
      .from(documentDeliveries)
      .where(eq(documentDeliveries.id, id));
    return result || null;
  }

  async getRecentDeliveries(limit = 50): Promise<DocumentDelivery[]> {
    return db
      .select()
      .from(documentDeliveries)
      .orderBy(desc(documentDeliveries.createdAt))
      .limit(limit);
  }
}

export const deliveryStorage = new DeliveryStorage();
