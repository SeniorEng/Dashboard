import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, isNull, desc, lte, or, gte } from "drizzle-orm";
import { 
  customerPricingHistory,
  type CustomerPricing,
  type InsertCustomerPricing,
} from "@shared/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

export interface ICustomerPricingStorage {
  getCurrentPricing(customerId: number): Promise<CustomerPricing | null>;
  getPricingHistory(customerId: number): Promise<CustomerPricing[]>;
  addPricing(data: InsertCustomerPricing, createdByUserId: number): Promise<CustomerPricing>;
}

export class CustomerPricingStorage implements ICustomerPricingStorage {
  async getCurrentPricing(customerId: number): Promise<CustomerPricing | null> {
    const today = new Date().toISOString().split('T')[0];
    
    const result = await db
      .select()
      .from(customerPricingHistory)
      .where(
        and(
          eq(customerPricingHistory.customerId, customerId),
          lte(customerPricingHistory.validFrom, today),
          or(
            isNull(customerPricingHistory.validTo),
            gte(customerPricingHistory.validTo, today)
          )
        )
      )
      .orderBy(desc(customerPricingHistory.validFrom))
      .limit(1);
    
    return result[0] || null;
  }

  async getPricingHistory(customerId: number): Promise<CustomerPricing[]> {
    return await db
      .select()
      .from(customerPricingHistory)
      .where(eq(customerPricingHistory.customerId, customerId))
      .orderBy(desc(customerPricingHistory.validFrom));
  }

  async addPricing(
    data: InsertCustomerPricing, 
    createdByUserId: number
  ): Promise<CustomerPricing> {
    const { customerId, validFrom, ...rest } = data;
    const newValidFrom = validFrom;
    const dayBeforeNew = new Date(newValidFrom);
    dayBeforeNew.setDate(dayBeforeNew.getDate() - 1);
    const validToForOld = dayBeforeNew.toISOString().split('T')[0];
    
    const currentRecord = await db
      .select()
      .from(customerPricingHistory)
      .where(
        and(
          eq(customerPricingHistory.customerId, customerId),
          lte(customerPricingHistory.validFrom, newValidFrom),
          or(
            isNull(customerPricingHistory.validTo),
            gte(customerPricingHistory.validTo, newValidFrom)
          )
        )
      )
      .orderBy(desc(customerPricingHistory.validFrom))
      .limit(1);
    
    if (currentRecord.length > 0) {
      await db
        .update(customerPricingHistory)
        .set({ validTo: validToForOld })
        .where(eq(customerPricingHistory.id, currentRecord[0].id));
    }
    
    const [newRecord] = await db
      .insert(customerPricingHistory)
      .values({
        customerId,
        validFrom: newValidFrom,
        validTo: null,
        hauswirtschaftRateCents: rest.hauswirtschaftRateCents ?? null,
        alltagsbegleitungRateCents: rest.alltagsbegleitungRateCents ?? null,
        kilometerRateCents: rest.kilometerRateCents ?? null,
        createdByUserId,
      })
      .returning();
    
    return newRecord;
  }
}

export const customerPricingStorage = new CustomerPricingStorage();
