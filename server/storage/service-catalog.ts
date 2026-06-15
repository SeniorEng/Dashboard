import { eq, asc, inArray } from "drizzle-orm";
import { log } from "../lib/log";
import {
  services,
  serviceBudgetPots,
  type Service,
  type ServiceBudgetPot,
} from "@shared/schema";
import {
  SERVICE_CATALOG,
  SERVICE_CATALOG_CODES,
} from "@shared/config/services";
import { db } from "../lib/db";

interface IServiceCatalogStorage {
  getAllServices(includeInactive?: boolean): Promise<Service[]>;
  getServiceById(id: number): Promise<Service | null>;
  getServicesByIds(ids: number[]): Promise<Service[]>;
  getServiceByCode(code: string): Promise<Service | null>;
  getServiceBudgetPots(serviceId: number): Promise<ServiceBudgetPot[]>;
  getAllServiceBudgetPots(): Promise<ServiceBudgetPot[]>;
  syncServiceCatalog(): Promise<void>;
}

class ServiceCatalogStorage implements IServiceCatalogStorage {
  async getAllServices(includeInactive = false): Promise<Service[]> {
    const rows = includeInactive
      ? await db.select().from(services).orderBy(asc(services.name))
      : await db.select().from(services)
          .where(eq(services.isActive, true))
          .orderBy(asc(services.name));
    // Die Konfig (`shared/config/services.ts`) ist die EINZIGE Quelle. DB-Extras
    // (etwa FK-referenzierte Alt-Datensätze, die der Startup-Sync nicht löschen
    // darf, sondern als "Startfehler" loggt) werden hier NIE ausgeliefert —
    // Katalog-Listen enthalten by construction ausschließlich Konfig-Services.
    // `getServiceById/byIds/byCode` bleiben bewusst ungefiltert, damit
    // bestehende Appointment-/Preis-FKs auf solche Alt-Datensätze intakt bleiben.
    const allowed = new Set<string>(SERVICE_CATALOG_CODES);
    return rows.filter((s) => s.code !== null && allowed.has(s.code));
  }

  async getServiceById(id: number): Promise<Service | null> {
    const result = await db.select().from(services).where(eq(services.id, id)).limit(1);
    return result[0] || null;
  }

  async getServicesByIds(ids: number[]): Promise<Service[]> {
    if (ids.length === 0) return [];
    return db.select().from(services).where(inArray(services.id, ids));
  }

  async getServiceByCode(code: string): Promise<Service | null> {
    const result = await db.select().from(services).where(eq(services.code, code)).limit(1);
    return result[0] || null;
  }

  async getServiceBudgetPots(serviceId: number): Promise<ServiceBudgetPot[]> {
    return db.select().from(serviceBudgetPots).where(eq(serviceBudgetPots.serviceId, serviceId));
  }

  async getAllServiceBudgetPots(): Promise<ServiceBudgetPot[]> {
    return db.select().from(serviceBudgetPots);
  }

  /**
   * Gleicht die `services`-Tabelle gegen die EINZIGE Quelle
   * (`shared/config/services.ts`) ab: fehlende Katalog-Services werden angelegt,
   * vorhandene werden auf die Konfig-Attribute (inkl. Budget-Töpfe) gehoben — die
   * Konfig ist autoritativ. Anschließend wird auf Abweichungen geprüft: jeder
   * DB-Service, der NICHT in der Konfig steht (oder ohne Code), ist ein
   * Startfehler — neue Services entstehen nur per Code-Änderung mit Review.
   */
  async syncServiceCatalog(): Promise<void> {
    for (const def of SERVICE_CATALOG) {
      const existing = await this.getServiceByCode(def.code);
      const values = {
        code: def.code,
        name: def.name,
        description: def.description,
        unitType: def.unitType,
        defaultPriceCents: def.defaultPriceCents,
        vatRate: def.vatRate,
        minDurationMinutes: def.minDurationMinutes,
        isActive: true,
        isDefault: def.isDefault,
        isSystem: def.isSystem,
        isBillable: def.isBillable,
        employeeRateCents: def.employeeRateCents,
        lohnartKategorie: def.lohnartKategorie,
        sortOrder: def.sortOrder,
      };

      let serviceId: number;
      if (!existing) {
        const [created] = await db.insert(services).values(values).returning();
        serviceId = created.id;
        log(`Katalog-Service "${def.name}" (${def.code}) angelegt.`, "startup");
      } else {
        serviceId = existing.id;
        await db.update(services).set(values).where(eq(services.id, existing.id));
      }
      await this.reconcileBudgetPots(serviceId, def.budgetPots);
    }

    const all = await db.select({
      id: services.id,
      code: services.code,
      name: services.name,
    }).from(services);
    const extras = all.filter((s) => !s.code || !SERVICE_CATALOG_CODES.includes(s.code));
    if (extras.length > 0) {
      const details = extras
        .map((e) => `#${e.id} "${e.name}" (${e.code ?? "ohne Code"})`)
        .join(", ");
      throw new Error(
        `Service-Katalog-Abweichung: ${extras.length} Service(s) in der DB sind nicht in ` +
          `shared/config/services.ts definiert: ${details}. Neue Services entstehen nur durch ` +
          `eine Code-Änderung mit Review — bitte die Konfiguration ergänzen oder die DB bereinigen.`,
      );
    }
  }

  private async reconcileBudgetPots(serviceId: number, desired: readonly string[]): Promise<void> {
    const existing = await db.select().from(serviceBudgetPots)
      .where(eq(serviceBudgetPots.serviceId, serviceId));
    const existingTypes = new Set(existing.map((p) => p.budgetType));
    const desiredSet = new Set(desired);

    const toAdd = desired.filter((d) => !existingTypes.has(d));
    if (toAdd.length > 0) {
      await db.insert(serviceBudgetPots).values(
        toAdd.map((budgetType) => ({ serviceId, budgetType })),
      );
    }

    for (const p of existing) {
      if (!desiredSet.has(p.budgetType)) {
        await db.delete(serviceBudgetPots).where(eq(serviceBudgetPots.id, p.id));
      }
    }
  }
}

export const serviceCatalogStorage = new ServiceCatalogStorage();
