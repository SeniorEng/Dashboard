import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, isNull, desc, lte, or, gte } from "drizzle-orm";
import { 
  customerPricingHistory,
  type CustomerPricing,
  type InsertCustomerPricing,
} from "@shared/schema";
import { todayISO, formatDateISO, parseLocalDate } from "@shared/utils/datetime";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

export interface ICustomerPricingStorage {
  getCurrentPricing(customerId: number): Promise<CustomerPricing | null>;
  getPricingHistory(customerId: number): Promise<CustomerPricing[]>;
  addPricing(data: InsertCustomerPricing, createdByUserId: number): Promise<CustomerPricing>;
}

export class CustomerPricingStorage implements ICustomerPricingStorage {
  async getCurrentPricing(customerId: number): Promise<CustomerPricing | null> {
    const today = todayISO();
    
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
    const dayBeforeNew = parseLocalDate(newValidFrom);
    dayBeforeNew.setDate(dayBeforeNew.getDate() - 1);
    const validToForOld = formatDateISO(dayBeforeNew);
    
    // Close any currently active record that overlaps with new entry
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
    
    // Find if there are any future records and get the first one to determine validTo
    const futureRecords = await db
      .select()
      .from(customerPricingHistory)
      .where(
        and(
          eq(customerPricingHistory.customerId, customerId),
          gte(customerPricingHistory.validFrom, newValidFrom)
        )
      )
      .orderBy(customerPricingHistory.validFrom)
      .limit(1);
    
    // If there's a future record, set validTo to day before it starts
    let newValidTo: string | null = null;
    if (futureRecords.length > 0) {
      const futureStart = parseLocalDate(futureRecords[0].validFrom);
      futureStart.setDate(futureStart.getDate() - 1);
      newValidTo = formatDateISO(futureStart);
    }
    
    const [newRecord] = await db
      .insert(customerPricingHistory)
      .values({
        customerId,
        validFrom: newValidFrom,
        validTo: newValidTo,
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
