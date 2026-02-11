import { eq, asc, inArray } from "drizzle-orm";
import {
  services,
  serviceBudgetPots,
  SYSTEM_SERVICE_CODES,
  type Service,
  type InsertService,
  type ServiceBudgetPot,
} from "@shared/schema";
import { db } from "../lib/db";

interface SystemServiceDefinition {
  code: string;
  name: string;
  description: string;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  isBillable: boolean;
  employeeRateCents: number;
  sortOrder: number;
  budgetPots: string[];
}

const SYSTEM_SERVICE_DEFINITIONS: SystemServiceDefinition[] = [
  {
    code: "travel_km",
    name: "Anfahrtskilometer",
    description: "Kilometer für die Anfahrt zum Kunden",
    unitType: "kilometers",
    defaultPriceCents: 30,
    vatRate: 19,
    isBillable: true,
    employeeRateCents: 30,
    sortOrder: 90,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a"],
  },
  {
    code: "customer_km",
    name: "Kundenkilometer",
    description: "Kilometer mit/für den Kunden gefahren",
    unitType: "kilometers",
    defaultPriceCents: 30,
    vatRate: 19,
    isBillable: true,
    employeeRateCents: 30,
    sortOrder: 91,
    budgetPots: ["entlastungsbetrag_45b", "umwandlung_45a"],
  },
];

export interface IServiceCatalogStorage {
  getAllServices(includeInactive?: boolean): Promise<Service[]>;
  getServiceById(id: number): Promise<Service | null>;
  getServiceByCode(code: string): Promise<Service | null>;
  createService(data: InsertService): Promise<Service>;
  updateService(id: number, data: Partial<InsertService>): Promise<Service | null>;
  getServiceBudgetPots(serviceId: number): Promise<ServiceBudgetPot[]>;
  getAllServiceBudgetPots(): Promise<ServiceBudgetPot[]>;
  ensureSystemServices(): Promise<void>;
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
    const existing = await this.getServiceById(id);
    if (!existing) return null;

    const { budgetPots, ...rest } = data;
    const updateData: Record<string, unknown> = {};

    if (existing.isSystem) {
      if (rest.defaultPriceCents !== undefined) updateData.defaultPriceCents = rest.defaultPriceCents;
      if (rest.vatRate !== undefined) updateData.vatRate = rest.vatRate;
      if (rest.isBillable !== undefined) updateData.isBillable = rest.isBillable;
      if (rest.employeeRateCents !== undefined) updateData.employeeRateCents = rest.employeeRateCents;
      if (rest.description !== undefined) updateData.description = rest.description;
    } else {
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
    }

    let updated: Service | null = null;
    if (Object.keys(updateData).length > 0) {
      const [result] = await db.update(services).set(updateData).where(eq(services.id, id)).returning();
      updated = result || null;
    } else {
      updated = existing;
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

  async ensureSystemServices(): Promise<void> {
    for (const def of SYSTEM_SERVICE_DEFINITIONS) {
      const existing = await this.getServiceByCode(def.code);
      if (!existing) {
        const [service] = await db.insert(services).values({
          code: def.code,
          name: def.name,
          description: def.description,
          unitType: def.unitType,
          defaultPriceCents: def.defaultPriceCents,
          vatRate: def.vatRate,
          isActive: true,
          isSystem: true,
          isBillable: def.isBillable,
          employeeRateCents: def.employeeRateCents,
          sortOrder: def.sortOrder,
        }).returning();

        if (def.budgetPots.length > 0) {
          await db.insert(serviceBudgetPots).values(
            def.budgetPots.map(budgetType => ({
              serviceId: service.id,
              budgetType,
            }))
          );
        }
        console.log(`System-Service "${def.name}" (${def.code}) angelegt.`);
      } else if (!existing.isSystem) {
        await db.update(services).set({ isSystem: true }).where(eq(services.id, existing.id));
        console.log(`Service "${def.name}" (${def.code}) als System-Service markiert.`);
      }
    }
  }
}

export const serviceCatalogStorage = new ServiceCatalogStorage();
