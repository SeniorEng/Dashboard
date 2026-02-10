import { eq, and, isNull, desc, lte, or, gte, asc } from "drizzle-orm";
import {
  services,
  customerServicePrices,
  type Service,
  type InsertService,
  type CustomerServicePrice,
  type InsertCustomerServicePrice,
} from "@shared/schema";
import { todayISO, formatDateISO, parseLocalDate } from "@shared/utils/datetime";
import { db } from "../lib/db";

export interface IServiceCatalogStorage {
  getAllServices(includeInactive?: boolean): Promise<Service[]>;
  getServiceById(id: number): Promise<Service | null>;
  getServiceByCode(code: string): Promise<Service | null>;
  createService(data: InsertService): Promise<Service>;
  updateService(id: number, data: Partial<InsertService>): Promise<Service | null>;
  
  getCustomerServicePrices(customerId: number): Promise<(CustomerServicePrice & { service: Service })[]>;
  upsertCustomerServicePrice(data: InsertCustomerServicePrice, createdByUserId: number): Promise<CustomerServicePrice>;
  deleteCustomerServicePrice(id: number): Promise<void>;
  
  resolvePrice(serviceId: number, customerId: number, date?: string): Promise<{ priceCents: number; isOverride: boolean }>;
  resolveAllPrices(customerId: number, date?: string): Promise<Array<{ service: Service; priceCents: number; isOverride: boolean }>>;
}

export class ServiceCatalogStorage implements IServiceCatalogStorage {
  async getAllServices(includeInactive = false): Promise<Service[]> {
    if (includeInactive) {
      return db.select().from(services).orderBy(asc(services.sortOrder), asc(services.name));
    }
    return db.select().from(services)
      .where(eq(services.isActive, true))
      .orderBy(asc(services.sortOrder), asc(services.name));
  }

  async getServiceById(id: number): Promise<Service | null> {
    const result = await db.select().from(services).where(eq(services.id, id)).limit(1);
    return result[0] || null;
  }

  async getServiceByCode(code: string): Promise<Service | null> {
    const result = await db.select().from(services).where(eq(services.code, code)).limit(1);
    return result[0] || null;
  }

  async createService(data: InsertService): Promise<Service> {
    const [service] = await db.insert(services).values({
      code: data.code ?? null,
      name: data.name,
      description: data.description ?? null,
      unitType: data.unitType,
      defaultPriceCents: data.defaultPriceCents,
      vatRate: data.vatRate ?? 19,
      minDurationMinutes: data.minDurationMinutes ?? null,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    }).returning();
    return service;
  }

  async updateService(id: number, data: Partial<InsertService>): Promise<Service | null> {
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.unitType !== undefined) updateData.unitType = data.unitType;
    if (data.defaultPriceCents !== undefined) updateData.defaultPriceCents = data.defaultPriceCents;
    if (data.vatRate !== undefined) updateData.vatRate = data.vatRate;
    if (data.minDurationMinutes !== undefined) updateData.minDurationMinutes = data.minDurationMinutes;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.code !== undefined) updateData.code = data.code;

    if (Object.keys(updateData).length === 0) return this.getServiceById(id);

    const [updated] = await db.update(services).set(updateData).where(eq(services.id, id)).returning();
    return updated || null;
  }

  async getCustomerServicePrices(customerId: number): Promise<(CustomerServicePrice & { service: Service })[]> {
    const results = await db
      .select({
        price: customerServicePrices,
        service: services,
      })
      .from(customerServicePrices)
      .innerJoin(services, eq(customerServicePrices.serviceId, services.id))
      .where(eq(customerServicePrices.customerId, customerId))
      .orderBy(asc(services.sortOrder));

    return results.map(r => ({ ...r.price, service: r.service }));
  }

  async upsertCustomerServicePrice(data: InsertCustomerServicePrice, createdByUserId: number): Promise<CustomerServicePrice> {
    const { customerId, serviceId, validFrom, ...rest } = data;
    const newValidFrom = validFrom;
    const dayBeforeNew = parseLocalDate(newValidFrom);
    dayBeforeNew.setDate(dayBeforeNew.getDate() - 1);
    const validToForOld = formatDateISO(dayBeforeNew);

    const currentRecord = await db
      .select()
      .from(customerServicePrices)
      .where(
        and(
          eq(customerServicePrices.customerId, customerId),
          eq(customerServicePrices.serviceId, serviceId),
          lte(customerServicePrices.validFrom, newValidFrom),
          or(
            isNull(customerServicePrices.validTo),
            gte(customerServicePrices.validTo, newValidFrom)
          )
        )
      )
      .orderBy(desc(customerServicePrices.validFrom))
      .limit(1);

    if (currentRecord.length > 0) {
      await db
        .update(customerServicePrices)
        .set({ validTo: validToForOld })
        .where(eq(customerServicePrices.id, currentRecord[0].id));
    }

    const [newRecord] = await db
      .insert(customerServicePrices)
      .values({
        customerId,
        serviceId,
        priceCents: rest.priceCents,
        validFrom: newValidFrom,
        validTo: rest.validTo ?? null,
        createdByUserId,
      })
      .returning();

    return newRecord;
  }

  async deleteCustomerServicePrice(id: number): Promise<void> {
    await db.delete(customerServicePrices).where(eq(customerServicePrices.id, id));
  }

  async resolvePrice(serviceId: number, customerId: number, date?: string): Promise<{ priceCents: number; isOverride: boolean }> {
    const targetDate = date || todayISO();

    const override = await db
      .select()
      .from(customerServicePrices)
      .where(
        and(
          eq(customerServicePrices.customerId, customerId),
          eq(customerServicePrices.serviceId, serviceId),
          lte(customerServicePrices.validFrom, targetDate),
          or(
            isNull(customerServicePrices.validTo),
            gte(customerServicePrices.validTo, targetDate)
          )
        )
      )
      .orderBy(desc(customerServicePrices.validFrom))
      .limit(1);

    if (override.length > 0) {
      return { priceCents: override[0].priceCents, isOverride: true };
    }

    const service = await this.getServiceById(serviceId);
    if (!service) {
      throw new Error(`Dienstleistung mit ID ${serviceId} nicht gefunden`);
    }
    return { priceCents: service.defaultPriceCents, isOverride: false };
  }

  async resolveAllPrices(customerId: number, date?: string): Promise<Array<{ service: Service; priceCents: number; isOverride: boolean }>> {
    const targetDate = date || todayISO();
    const activeServices = await this.getAllServices(false);

    const results: Array<{ service: Service; priceCents: number; isOverride: boolean }> = [];

    for (const service of activeServices) {
      const override = await db
        .select()
        .from(customerServicePrices)
        .where(
          and(
            eq(customerServicePrices.customerId, customerId),
            eq(customerServicePrices.serviceId, service.id),
            lte(customerServicePrices.validFrom, targetDate),
            or(
              isNull(customerServicePrices.validTo),
              gte(customerServicePrices.validTo, targetDate)
            )
          )
        )
        .orderBy(desc(customerServicePrices.validFrom))
        .limit(1);

      if (override.length > 0) {
        results.push({ service, priceCents: override[0].priceCents, isOverride: true });
      } else {
        results.push({ service, priceCents: service.defaultPriceCents, isOverride: false });
      }
    }

    return results;
  }
}

export const serviceCatalogStorage = new ServiceCatalogStorage();
