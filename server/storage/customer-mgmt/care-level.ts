import {
  type CustomerCareLevelHistory,
  type InsertCareLevelHistory,
  type CustomerNeedsAssessment,
  type InsertNeedsAssessment,
  customerCareLevelHistory,
  customerNeedsAssessments,
  customers,
} from "@shared/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { parseLocalDate, formatDateISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";

export async function getCustomerCareLevelHistory(customerId: number): Promise<CustomerCareLevelHistory[]> {
  return await db
    .select()
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId))
    .orderBy(desc(customerCareLevelHistory.validFrom));
}

export async function getCustomerCurrentCareLevel(customerId: number): Promise<CustomerCareLevelHistory | undefined> {
  const result = await db
    .select()
    .from(customerCareLevelHistory)
    .where(and(
      eq(customerCareLevelHistory.customerId, customerId),
      isNull(customerCareLevelHistory.validTo)
    ))
    .limit(1);
  return result[0];
}

export async function addCareLevelHistory(data: InsertCareLevelHistory, userId?: number): Promise<CustomerCareLevelHistory> {
  const validFromDate = parseLocalDate(data.validFrom);
  validFromDate.setDate(validFromDate.getDate() - 1);
  const dayBeforeValidFrom = formatDateISO(validFromDate);
  
  await db
    .update(customerCareLevelHistory)
    .set({ validTo: dayBeforeValidFrom })
    .where(and(
      eq(customerCareLevelHistory.customerId, data.customerId),
      isNull(customerCareLevelHistory.validTo)
    ));
  
  const result = await db.insert(customerCareLevelHistory).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  
  await db
    .update(customers)
    .set({ pflegegrad: data.pflegegrad, updatedAt: new Date() })
    .where(eq(customers.id, data.customerId));
  
  return result[0];
}

export async function getCustomerNeedsAssessment(customerId: number): Promise<CustomerNeedsAssessment | undefined> {
  const result = await db
    .select()
    .from(customerNeedsAssessments)
    .where(eq(customerNeedsAssessments.customerId, customerId))
    .orderBy(desc(customerNeedsAssessments.assessmentDate))
    .limit(1);
  return result[0];
}

export async function createNeedsAssessment(data: InsertNeedsAssessment, userId?: number): Promise<CustomerNeedsAssessment> {
  const result = await db.insert(customerNeedsAssessments).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  return result[0];
}
