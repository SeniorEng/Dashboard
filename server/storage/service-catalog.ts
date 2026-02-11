import { eq, asc } from "drizzle-orm";
import {
  services,
  serviceBudgetPots,
  type Service,
  type InsertService,
  type ServiceBudgetPot,
} from "@shared/schema";
import { db } from "../lib/db";

export interface IServiceCatalogStorage {
  getAllServices(includeInactive?: boolean): Promise<Service[]>;
  getServiceById(id: number): Promise<Service | null>;
  getServiceByCode(code: string): Promise<Service | null>;
  createService(data: InsertService): Promise<Service>;
  updateService(id: number, data: Partial<InsertService>): Promise<Service | null>;
  getServiceBudgetPots(serviceId: number): Promise<ServiceBudgetPot[]>;
  getAllServiceBudgetPots(): Promise<ServiceBudgetPot[]>;
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
    const { budgetPots, ...serviceData } = data;
    const [service] = await db.insert(services).values({
      code: serviceData.code ?? null,
      name: serviceData.name,
      description: serviceData.description ?? null,
      unitType: serviceData.unitType,
      defaultPriceCents: serviceData.defaultPriceCents,
      vatRate: serviceData.vatRate ?? 19,
      minDurationMinutes: serviceData.minDurationMinutes ?? null,
      isActive: serviceData.isActive ?? true,
      isBillable: serviceData.isBillable ?? true,
      employeeRateCents: serviceData.employeeRateCents ?? 0,
      sortOrder: serviceData.sortOrder ?? 0,
    }).returning();

    if (budgetPots && budgetPots.length > 0) {
      await db.insert(serviceBudgetPots).values(
        budgetPots.map(budgetType => ({
          serviceId: service.id,
          budgetType,
        }))
      );
    }

    return service;
  }

  async updateService(id: number, data: Partial<InsertService>): Promise<Service | null> {
    const { budgetPots, ...rest } = data;
    const updateData: Record<string, unknown> = {};
    if (rest.name !== undefined) updateData.name = rest.name;
    if (rest.description !== undefined) updateData.description = rest.description;
    if (rest.unitType !== undefined) updateData.unitType = rest.unitType;
    if (rest.defaultPriceCents !== undefined) updateData.defaultPriceCents = rest.defaultPriceCents;
    if (rest.vatRate !== undefined) updateData.vatRate = rest.vatRate;
    if (rest.minDurationMinutes !== undefined) updateData.minDurationMinutes = rest.minDurationMinutes;
    if (rest.isActive !== undefined) updateData.isActive = rest.isActive;
    if (rest.isBillable !== undefined) updateData.isBillable = rest.isBillable;
    if (rest.employeeRateCents !== undefined) updateData.employeeRateCents = rest.employeeRateCents;
    if (rest.sortOrder !== undefined) updateData.sortOrder = rest.sortOrder;
    if (rest.code !== undefined) updateData.code = rest.code;

    let updated: Service | null = null;
    if (Object.keys(updateData).length > 0) {
      const [result] = await db.update(services).set(updateData).where(eq(services.id, id)).returning();
      updated = result || null;
    } else {
      updated = await this.getServiceById(id);
    }

    if (budgetPots !== undefined && updated) {
      await db.delete(serviceBudgetPots).where(eq(serviceBudgetPots.serviceId, id));
      if (budgetPots.length > 0) {
        await db.insert(serviceBudgetPots).values(
          budgetPots.map(budgetType => ({
            serviceId: id,
            budgetType,
          }))
        );
      }
    }

    return updated;
  }

  async getServiceBudgetPots(serviceId: number): Promise<ServiceBudgetPot[]> {
    return db.select().from(serviceBudgetPots).where(eq(serviceBudgetPots.serviceId, serviceId));
  }

  async getAllServiceBudgetPots(): Promise<ServiceBudgetPot[]> {
    return db.select().from(serviceBudgetPots);
  }
}

export const serviceCatalogStorage = new ServiceCatalogStorage();
