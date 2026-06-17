import {
  type CustomerContract,
  type InsertCustomerContract,
  type CustomerContractRate,
  type InsertContractRate,
  type ServiceRate,
  type InsertServiceRate,
  SERVICE_CATEGORIES,
  customerContracts,
  prices,
  services,
} from "@shared/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../../lib/db";

/**
 * Task #1301 — Vertragssätze (früher `customer_contract_rates`) leben jetzt in der
 * konsolidierten `prices`-Tabelle (scope="customer"). Service-KATEGORIE ↔
 * Katalog-Service-ID wird über `services.code` aufgelöst (Code == Kategorie für
 * hauswirtschaft/alltagsbegleitung/erstberatung) — identisches Mapping wie im
 * Konsolidierungs-Report.
 */
async function rateCategoryServiceMaps(
  executor: DbOrTx,
): Promise<{ serviceIdByCategory: Map<string, number>; categoryByServiceId: Map<number, string> }> {
  const rows = await executor.select({ id: services.id, code: services.code }).from(services);
  const serviceIdByCategory = new Map<string, number>();
  const categoryByServiceId = new Map<number, string>();
  const categorySet = new Set<string>(SERVICE_CATEGORIES as readonly string[]);
  for (const s of rows) {
    if (s.code && categorySet.has(s.code)) {
      serviceIdByCategory.set(s.code, s.id);
      categoryByServiceId.set(s.id, s.code);
    }
  }
  return { serviceIdByCategory, categoryByServiceId };
}

async function fetchContractWithRates(contractResult: CustomerContract[]): Promise<(CustomerContract & { rates: CustomerContractRate[] }) | undefined> {
  if (contractResult.length === 0) return undefined;
  const contract = contractResult[0];
  const { categoryByServiceId } = await rateCategoryServiceMaps(db);
  const rateServiceIds = [...categoryByServiceId.keys()];
  let rates: CustomerContractRate[] = [];
  if (rateServiceIds.length > 0) {
    const rows = await db
      .select()
      .from(prices)
      .where(and(
        eq(prices.scope, "customer"),
        eq(prices.origin, "customer_contract_rates"),
        eq(prices.customerId, contract.customerId),
        isNull(prices.validTo),
        isNull(prices.deletedAt),
        inArray(prices.serviceId, rateServiceIds),
      ));
    // Pro Service genau EINE Zeile rekonstruieren (jüngstes validFrom, dann höchste
    // id — Resolver-Tie-Breaker). Provenienz-Filter oben stellt sicher, dass NUR
    // Vertragssatz-Herkunft (nicht customer_service_prices) als Vertragssatz erscheint.
    const latestByServiceId = new Map<number, typeof rows[number]>();
    for (const r of rows) {
      const prev = latestByServiceId.get(r.serviceId);
      if (
        !prev ||
        (r.validFrom ?? "") > (prev.validFrom ?? "") ||
        ((r.validFrom ?? "") === (prev.validFrom ?? "") && r.id > prev.id)
      ) {
        latestByServiceId.set(r.serviceId, r);
      }
    }
    rates = [...latestByServiceId.values()].map((r) => ({
      id: r.id,
      contractId: contract.id,
      serviceCategory: categoryByServiceId.get(r.serviceId)!,
      hourlyRateCents: r.cents,
      validFrom: r.validFrom,
      validTo: r.validTo,
      createdAt: r.createdAt,
      createdByUserId: r.createdByUserId,
    }));
  }
  return { ...contract, rates };
}

export async function getCustomerCurrentContract(customerId: number): Promise<(CustomerContract & { rates: CustomerContractRate[] }) | undefined> {
  const contractResult = await db
    .select()
    .from(customerContracts)
    .where(and(
      eq(customerContracts.customerId, customerId),
      eq(customerContracts.status, "active")
    ))
    .limit(1);
  return fetchContractWithRates(contractResult);
}

export async function getCustomerLatestContract(customerId: number): Promise<(CustomerContract & { rates: CustomerContractRate[] }) | undefined> {
  const contractResult = await db
    .select()
    .from(customerContracts)
    .where(eq(customerContracts.customerId, customerId))
    .orderBy(customerContracts.id)
    .limit(1);
  return fetchContractWithRates(contractResult);
}

export async function createCustomerContract(data: InsertCustomerContract, userId?: number, tx?: DbOrTx): Promise<CustomerContract> {
  const executor = tx ?? db;
  const result = await executor.insert(customerContracts).values({
    ...data,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function addContractRate(data: InsertContractRate, userId?: number, tx?: DbOrTx): Promise<CustomerContractRate> {
  const executor = tx ?? db;
  const today = todayISO();

  // contractId → customerId (Vertrag wird i. d. R. innerhalb derselben Anlage-Tx
  // erzeugt; `prices` ist kunden-, nicht vertragsgebunden).
  const [contract] = await executor
    .select({ id: customerContracts.id, customerId: customerContracts.customerId })
    .from(customerContracts)
    .where(eq(customerContracts.id, data.contractId))
    .limit(1);
  if (!contract) {
    throw new Error(`Vertrag #${data.contractId} nicht gefunden — Vertragssatz kann nicht gespeichert werden.`);
  }

  // serviceCategory → Katalog-Service-ID.
  const { serviceIdByCategory } = await rateCategoryServiceMaps(executor);
  const serviceId = serviceIdByCategory.get(data.serviceCategory);
  if (serviceId === undefined) {
    throw new Error(
      `Service-Kategorie '${data.serviceCategory}' hat keinen Katalog-Service — Vertragssatz kann nicht gespeichert werden.`,
    );
  }

  // Vorherige offene Kunden-Zeile dieses Service schließen (Zeitversionierung).
  // NUR Vertragssatz-Herkunft (origin) anfassen — in der Parallel-Phase liegen
  // auch customer_service_prices-Zeilen desselben (Kunde, Service) in `prices`,
  // die der Vertragssatz-Schreiber NICHT mitschließen darf.
  await executor
    .update(prices)
    .set({ validTo: today })
    .where(and(
      eq(prices.scope, "customer"),
      eq(prices.origin, "customer_contract_rates"),
      eq(prices.customerId, contract.customerId),
      eq(prices.serviceId, serviceId),
      isNull(prices.validTo),
      isNull(prices.deletedAt),
    ));

  const [inserted] = await executor.insert(prices).values({
    scope: "customer",
    origin: "customer_contract_rates",
    customerId: contract.customerId,
    serviceId,
    cents: data.hourlyRateCents,
    validFrom: data.validFrom,
    validTo: data.validTo ?? null,
    createdByUserId: userId,
  }).returning();

  return {
    id: inserted.id,
    contractId: data.contractId,
    serviceCategory: data.serviceCategory,
    hourlyRateCents: inserted.cents,
    validFrom: inserted.validFrom,
    validTo: inserted.validTo,
    createdAt: inserted.createdAt,
    createdByUserId: inserted.createdByUserId,
  };
}

export async function updateCustomerContract(contractId: number, data: Partial<{
  vereinbarteLeistungen: string | null;
  contractDate: string | null;
  contractStart: string;
  contractEnd: string | null;
  hoursPerPeriod: number;
  periodType: string;
  status: string;
}>, tx?: Pick<typeof db, 'update'>): Promise<CustomerContract | undefined> {
  const executor = tx ?? db;
  const result = await executor.update(customerContracts)
    .set(data)
    .where(eq(customerContracts.id, contractId))
    .returning();
  return result[0];
}

export async function getCurrentServiceRates(): Promise<ServiceRate[]> {
  // Task #1325 — firmenweite Standardsätze leben in der `prices`-SSoT
  // (scope="standard", origin="service_rates"). Service-KATEGORIE ↔ Katalog-
  // Service-ID über `services.code` (Code == Kategorie).
  const { categoryByServiceId } = await rateCategoryServiceMaps(db);
  const rows = await db
    .select()
    .from(prices)
    .where(and(
      eq(prices.scope, "standard"),
      eq(prices.origin, "service_rates"),
      isNull(prices.validTo),
      isNull(prices.deletedAt),
    ));
  return rows
    .filter((r) => categoryByServiceId.has(r.serviceId))
    .map((r) => ({
      id: r.id,
      serviceCategory: categoryByServiceId.get(r.serviceId)!,
      hourlyRateCents: r.cents,
      validFrom: r.validFrom,
      validTo: r.validTo,
      createdAt: r.createdAt,
      createdByUserId: r.createdByUserId,
    }));
}

export async function addServiceRate(data: InsertServiceRate, userId?: number): Promise<ServiceRate> {
  const today = todayISO();

  // serviceCategory → Katalog-Service-ID.
  const { serviceIdByCategory } = await rateCategoryServiceMaps(db);
  const serviceId = serviceIdByCategory.get(data.serviceCategory);
  if (serviceId === undefined) {
    throw new Error(
      `Service-Kategorie '${data.serviceCategory}' hat keinen Katalog-Service — Standardsatz kann nicht gespeichert werden.`,
    );
  }

  // Vorherige offene Standard-Zeile dieses Service schließen (Zeitversionierung).
  await db
    .update(prices)
    .set({ validTo: today })
    .where(and(
      eq(prices.scope, "standard"),
      eq(prices.origin, "service_rates"),
      eq(prices.serviceId, serviceId),
      isNull(prices.validTo),
      isNull(prices.deletedAt),
    ));

  const [inserted] = await db.insert(prices).values({
    scope: "standard",
    origin: "service_rates",
    customerId: null,
    serviceId,
    cents: data.hourlyRateCents,
    validFrom: data.validFrom,
    validTo: data.validTo ?? null,
    createdByUserId: userId,
  }).returning();

  return {
    id: inserted.id,
    serviceCategory: data.serviceCategory,
    hourlyRateCents: inserted.cents,
    validFrom: inserted.validFrom,
    validTo: inserted.validTo,
    createdAt: inserted.createdAt,
    createdByUserId: inserted.createdByUserId,
  };
}
