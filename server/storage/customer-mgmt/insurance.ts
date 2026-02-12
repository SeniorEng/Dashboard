import {
  type InsuranceProvider,
  type InsertInsuranceProvider,
  type CustomerInsuranceHistory,
  type InsertCustomerInsurance,
  insuranceProviders,
  customerInsuranceHistory,
} from "@shared/schema";
import { eq, and, isNull, desc, count } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";

export async function getInsuranceProviders(activeOnly = true): Promise<InsuranceProvider[]> {
  if (activeOnly) {
    return await db.select().from(insuranceProviders).where(eq(insuranceProviders.isActive, true));
  }
  return await db.select().from(insuranceProviders);
}

export async function getInsuranceProvider(id: number): Promise<InsuranceProvider | undefined> {
  const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.id, id));
  return result[0];
}

export async function getInsuranceProviderByIK(ikNummer: string): Promise<InsuranceProvider | undefined> {
  const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.ikNummer, ikNummer));
  return result[0];
}

export async function createInsuranceProvider(data: InsertInsuranceProvider): Promise<InsuranceProvider> {
  const result = await db.insert(insuranceProviders).values(data).returning();
  return result[0];
}

export async function updateInsuranceProvider(id: number, data: Partial<InsertInsuranceProvider>): Promise<InsuranceProvider | undefined> {
  const result = await db.update(insuranceProviders).set(data).where(eq(insuranceProviders.id, id)).returning();
  return result[0];
}

export async function getActiveCustomerCountForProvider(providerId: number): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(customerInsuranceHistory)
    .where(and(
      eq(customerInsuranceHistory.insuranceProviderId, providerId),
      isNull(customerInsuranceHistory.validTo)
    ));
  return Number(result[0]?.count ?? 0);
}

export async function getCustomerCurrentInsurance(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider }) | undefined> {
  const result = await db
    .select({
      id: customerInsuranceHistory.id,
      customerId: customerInsuranceHistory.customerId,
      insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
      versichertennummer: customerInsuranceHistory.versichertennummer,
      validFrom: customerInsuranceHistory.validFrom,
      validTo: customerInsuranceHistory.validTo,
      notes: customerInsuranceHistory.notes,
      createdAt: customerInsuranceHistory.createdAt,
      createdByUserId: customerInsuranceHistory.createdByUserId,
      provider: {
        id: insuranceProviders.id,
        name: insuranceProviders.name,
        ikNummer: insuranceProviders.ikNummer,
        strasse: insuranceProviders.strasse,
        hausnummer: insuranceProviders.hausnummer,
        plz: insuranceProviders.plz,
        stadt: insuranceProviders.stadt,
        telefon: insuranceProviders.telefon,
        email: insuranceProviders.email,
        empfaenger: insuranceProviders.empfaenger,
        empfaengerZeile2: insuranceProviders.empfaengerZeile2,
        emailInvoiceEnabled: insuranceProviders.emailInvoiceEnabled,
        zahlungsbedingungen: insuranceProviders.zahlungsbedingungen,
        zahlungsart: insuranceProviders.zahlungsart,
        isActive: insuranceProviders.isActive,
        anschrift: insuranceProviders.anschrift,
        plzOrt: insuranceProviders.plzOrt,
        createdAt: insuranceProviders.createdAt,
      },
    })
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(and(
      eq(customerInsuranceHistory.customerId, customerId),
      isNull(customerInsuranceHistory.validTo)
    ))
    .limit(1);
  
  if (result.length === 0) return undefined;
  return { ...result[0], provider: result[0].provider };
}

export async function getCustomerInsuranceHistory(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider })[]> {
  const result = await db
    .select({
      id: customerInsuranceHistory.id,
      customerId: customerInsuranceHistory.customerId,
      insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
      versichertennummer: customerInsuranceHistory.versichertennummer,
      validFrom: customerInsuranceHistory.validFrom,
      validTo: customerInsuranceHistory.validTo,
      notes: customerInsuranceHistory.notes,
      createdAt: customerInsuranceHistory.createdAt,
      createdByUserId: customerInsuranceHistory.createdByUserId,
      provider: {
        id: insuranceProviders.id,
        name: insuranceProviders.name,
        ikNummer: insuranceProviders.ikNummer,
        strasse: insuranceProviders.strasse,
        hausnummer: insuranceProviders.hausnummer,
        plz: insuranceProviders.plz,
        stadt: insuranceProviders.stadt,
        telefon: insuranceProviders.telefon,
        email: insuranceProviders.email,
        empfaenger: insuranceProviders.empfaenger,
        empfaengerZeile2: insuranceProviders.empfaengerZeile2,
        emailInvoiceEnabled: insuranceProviders.emailInvoiceEnabled,
        zahlungsbedingungen: insuranceProviders.zahlungsbedingungen,
        zahlungsart: insuranceProviders.zahlungsart,
        isActive: insuranceProviders.isActive,
        anschrift: insuranceProviders.anschrift,
        plzOrt: insuranceProviders.plzOrt,
        createdAt: insuranceProviders.createdAt,
      },
    })
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(eq(customerInsuranceHistory.customerId, customerId))
    .orderBy(desc(customerInsuranceHistory.validFrom));
  
  return result.map(r => ({ ...r, provider: r.provider }));
}

export async function addCustomerInsurance(data: InsertCustomerInsurance, userId?: number): Promise<CustomerInsuranceHistory> {
  const today = todayISO();
  
  await db
    .update(customerInsuranceHistory)
    .set({ validTo: today })
    .where(and(
      eq(customerInsuranceHistory.customerId, data.customerId),
      isNull(customerInsuranceHistory.validTo)
    ));
  
  const result = await db.insert(customerInsuranceHistory).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  
  return result[0];
}
