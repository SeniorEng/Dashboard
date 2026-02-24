import {
  type CustomerContract,
  type InsertCustomerContract,
  type CustomerContractRate,
  type InsertContractRate,
  type ServiceRate,
  type InsertServiceRate,
  customerContracts,
  customerContractRates,
  serviceRates,
} from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";

export async function getCustomerCurrentContract(customerId: number): Promise<(CustomerContract & { rates: CustomerContractRate[] }) | undefined> {
  const contractResult = await db
    .select()
    .from(customerContracts)
    .where(and(
      eq(customerContracts.customerId, customerId),
      eq(customerContracts.status, "active")
    ))
    .limit(1);
  
  if (contractResult.length === 0) return undefined;
  
  const contract = contractResult[0];
  const rates = await db
    .select()
    .from(customerContractRates)
    .where(and(
      eq(customerContractRates.contractId, contract.id),
      isNull(customerContractRates.validTo)
    ));
  
  return { ...contract, rates };
}

export async function createCustomerContract(data: InsertCustomerContract, userId?: number): Promise<CustomerContract> {
  const result = await db.insert(customerContracts).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function addContractRate(data: InsertContractRate, userId?: number): Promise<CustomerContractRate> {
  const today = todayISO();
  
  await db
    .update(customerContractRates)
    .set({ validTo: today })
    .where(and(
      eq(customerContractRates.contractId, data.contractId),
      eq(customerContractRates.serviceCategory, data.serviceCategory),
      isNull(customerContractRates.validTo)
    ));
  
  const result = await db.insert(customerContractRates).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  
  return result[0];
}

export async function updateCustomerContract(contractId: number, data: Partial<{
  vereinbarteLeistungen: string | null;
  contractDate: string | null;
  contractStart: string;
  contractEnd: string | null;
  hoursPerPeriod: number;
  periodType: string;
}>): Promise<CustomerContract | undefined> {
  const result = await db.update(customerContracts)
    .set(data)
    .where(eq(customerContracts.id, contractId))
    .returning();
  return result[0];
}

export async function getCurrentServiceRates(): Promise<ServiceRate[]> {
  return await db
    .select()
    .from(serviceRates)
    .where(isNull(serviceRates.validTo));
}

export async function addServiceRate(data: InsertServiceRate, userId?: number): Promise<ServiceRate> {
  const today = todayISO();
  
  await db
    .update(serviceRates)
    .set({ validTo: today })
    .where(and(
      eq(serviceRates.serviceCategory, data.serviceCategory),
      isNull(serviceRates.validTo)
    ));
  
  const result = await db.insert(serviceRates).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  
  return result[0];
}
