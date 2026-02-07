import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, isNull, desc, lte, or, gte } from "drizzle-orm";
import { 
  employeeCompensationHistory,
  type EmployeeCompensation,
  type InsertEmployeeCompensation,
} from "@shared/schema";
import { todayISO, formatDateISO } from "@shared/utils/datetime";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

export interface ICompensationStorage {
  getCurrentCompensation(userId: number): Promise<EmployeeCompensation | null>;
  getCompensationHistory(userId: number): Promise<EmployeeCompensation[]>;
  addCompensation(data: InsertEmployeeCompensation, createdByUserId: number): Promise<EmployeeCompensation>;
}

export class CompensationStorage implements ICompensationStorage {
  async getCurrentCompensation(userId: number): Promise<EmployeeCompensation | null> {
    const today = todayISO();
    
    const result = await db
      .select()
      .from(employeeCompensationHistory)
      .where(
        and(
          eq(employeeCompensationHistory.userId, userId),
          lte(employeeCompensationHistory.validFrom, today),
          or(
            isNull(employeeCompensationHistory.validTo),
            gte(employeeCompensationHistory.validTo, today)
          )
        )
      )
      .orderBy(desc(employeeCompensationHistory.validFrom))
      .limit(1);
    
    return result[0] || null;
  }

  async getCompensationHistory(userId: number): Promise<EmployeeCompensation[]> {
    return await db
      .select()
      .from(employeeCompensationHistory)
      .where(eq(employeeCompensationHistory.userId, userId))
      .orderBy(desc(employeeCompensationHistory.validFrom));
  }

  async addCompensation(
    data: InsertEmployeeCompensation, 
    createdByUserId: number
  ): Promise<EmployeeCompensation> {
    const { userId, validFrom, ...rest } = data;
    const newValidFrom = validFrom;
    const dayBeforeNew = new Date(newValidFrom);
    dayBeforeNew.setDate(dayBeforeNew.getDate() - 1);
    const validToForOld = formatDateISO(dayBeforeNew);
    
    const currentRecord = await db
      .select()
      .from(employeeCompensationHistory)
      .where(
        and(
          eq(employeeCompensationHistory.userId, userId),
          lte(employeeCompensationHistory.validFrom, newValidFrom),
          or(
            isNull(employeeCompensationHistory.validTo),
            gte(employeeCompensationHistory.validTo, newValidFrom)
          )
        )
      )
      .orderBy(desc(employeeCompensationHistory.validFrom))
      .limit(1);
    
    if (currentRecord.length > 0) {
      await db
        .update(employeeCompensationHistory)
        .set({ validTo: validToForOld })
        .where(eq(employeeCompensationHistory.id, currentRecord[0].id));
    }
    
    const [newRecord] = await db
      .insert(employeeCompensationHistory)
      .values({
        userId,
        validFrom: newValidFrom,
        validTo: null,
        hourlyRateHauswirtschaftCents: rest.hourlyRateHauswirtschaftCents ?? null,
        hourlyRateAlltagsbegleitungCents: rest.hourlyRateAlltagsbegleitungCents ?? null,
        travelCostType: rest.travelCostType || null,
        kilometerRateCents: rest.kilometerRateCents ?? null,
        monthlyTravelAllowanceCents: rest.monthlyTravelAllowanceCents ?? null,
        createdByUserId,
      })
      .returning();
    
    return newRecord;
  }
}

export const compensationStorage = new CompensationStorage();
