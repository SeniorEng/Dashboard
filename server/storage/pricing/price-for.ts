/**
 * Task #1291 (Phase 3.3) — Server-Lader für die `priceFor`-SSoT.
 *
 * Lädt einmal pro Kunde alle aktiven Kunden-Preiszeilen + den Service-Katalog
 * und stellt die reine Auflösung aus `shared/domain/pricing/price-for.ts` als
 * batched Lookup bereit. ALLE Live-Preis-Lookups (Termin-Kostenrechner,
 * Rechnungs-/LN-Line-Items, Budget-Vorschau) gehen hierdurch — keine eigenen
 * `customer_service_prices`-Reads mehr.
 *
 * Standard-Scope ist aktuell leer (Schattenmodus): bis die konsolidierte
 * `prices`-Tabelle freigegeben ist, fällt die Auflösung wertneutral vom
 * Kunden-Preis direkt auf den Katalog-Default — exakt das heutige Verhalten.
 */
import { and, eq, isNull } from "drizzle-orm";
import { customerServicePrices, prices, services as servicesTable } from "@shared/schema";
import { db, type DbOrTx } from "../../lib/db";
import { customerServicePricesRepo } from "../../repos";
import {
  resolvePriceFor,
  type PriceResolution,
  type PriceCatalogEntry,
  type VersionedPriceRow,
} from "@shared/domain/pricing/price-for";

export type { PriceResolution };

export interface CustomerPriceContext {
  /** Auflösung per Service-Code (z. B. "hauswirtschaft", "travel_km"). */
  resolveByCode(serviceCode: string, date: string): PriceResolution | null;
  /** Auflösung per Service-ID. */
  resolveById(serviceId: number, date: string): PriceResolution | null;
}

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).substring(0, 10);
}

/**
 * Task #1301 — Default-OFF-Schalter für den Standard-Scope aus der konsolidierten
 * `prices`-Tabelle. AUS (Default) ⇒ `standardRows` bleibt leer und die Auflösung
 * fällt wertneutral vom Kunden-Preis direkt auf den Katalog-Default (= heutiges
 * Live-Verhalten). EIN ⇒ der firmenweite Standard wird aus `prices`
 * (scope="standard") gelesen. Muster identisch zu `BUDGET_HARD_HOLDS`; der
 * Cutover (Task #1303) wird durch Alrik freigegeben.
 */
export function pricesStandardScopeEnabled(): boolean {
  const v = (process.env.PRICES_STANDARD_SCOPE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Baut den Preis-Kontext für einen Kunden. `customerId == null` ⇒ keine
 * Kunden-Zeilen (Auflösung fällt direkt auf Standard/Default).
 */
export async function loadCustomerPriceContext(
  customerId: number | null | undefined,
  tx: DbOrTx = db,
): Promise<CustomerPriceContext> {
  // Katalog (id + code + default + billable) — eine Quelle für beide Lookups.
  // Bewusst UNGEFILTERT (kein getAllServices-Katalogfilter): `resolveById` wird
  // mit beliebigen `appointment_services.serviceId` aufgerufen, inkl. legacy/
  // deaktivierter Services. Der Katalogfilter würde solche IDs ausblenden ⇒
  // null ⇒ fälschliches „Kein Preis hinterlegt"-throw beim Rechnungslauf.
  // Konvention: ID-basierte Service-Lookups bleiben FK-sicher ungefiltert.
  const services = await tx
    .select({
      id: servicesTable.id,
      code: servicesTable.code,
      defaultPriceCents: servicesTable.defaultPriceCents,
      isBillable: servicesTable.isBillable,
    })
    .from(servicesTable);
  const catalogByCode = new Map<string, PriceCatalogEntry & { id: number }>();
  const catalogById = new Map<number, PriceCatalogEntry & { id: number }>();
  for (const s of services) {
    const entry = {
      id: s.id,
      defaultPriceCents: s.defaultPriceCents ?? 0,
      isBillable: s.isBillable !== false,
    };
    if (s.code) catalogByCode.set(s.code, entry);
    catalogById.set(s.id, entry);
  }

  // Aktive Kunden-Preiszeilen (zeitversioniert), gruppiert nach Service.
  const customerByServiceId = new Map<number, VersionedPriceRow[]>();
  if (customerId != null) {
    const rows = await customerServicePricesRepo
      .selectColumnsFrom(
        {
          id: customerServicePrices.id,
          serviceId: customerServicePrices.serviceId,
          priceCents: customerServicePrices.priceCents,
          validFrom: customerServicePrices.validFrom,
          validTo: customerServicePrices.validTo,
        },
        tx,
      )
      .where(
        and(
          eq(customerServicePrices.customerId, customerId),
          customerServicePricesRepo.activeOnly(),
        ),
      );
    for (const raw of rows) {
      const list = customerByServiceId.get(raw.serviceId) ?? [];
      list.push({
        id: Number(raw.id),
        priceCents: Number(raw.priceCents),
        validFrom: toDateStr(raw.validFrom),
        validTo: toDateStr(raw.validTo),
      });
      customerByServiceId.set(raw.serviceId, list);
    }
  }

  // Standard-Scope (firmenweit, zeitversioniert) — NUR wenn das Default-OFF-Flag
  // aktiv ist; sonst leer (= heutiges Live-Verhalten). Quelle: konsolidierte
  // `prices`-Tabelle (scope="standard"), gruppiert nach Service.
  const standardByServiceId = new Map<number, VersionedPriceRow[]>();
  if (pricesStandardScopeEnabled()) {
    const stdRows = await tx
      .select({
        id: prices.id,
        serviceId: prices.serviceId,
        cents: prices.cents,
        validFrom: prices.validFrom,
        validTo: prices.validTo,
      })
      .from(prices)
      .where(and(eq(prices.scope, "standard"), isNull(prices.deletedAt)));
    for (const raw of stdRows) {
      const list = standardByServiceId.get(raw.serviceId) ?? [];
      list.push({
        id: Number(raw.id),
        priceCents: Number(raw.cents),
        validFrom: toDateStr(raw.validFrom),
        validTo: toDateStr(raw.validTo),
      });
      standardByServiceId.set(raw.serviceId, list);
    }
  }

  function resolveForServiceId(serviceId: number | undefined, catalog: PriceCatalogEntry | undefined, date: string): PriceResolution | null {
    const customerRows = serviceId != null ? (customerByServiceId.get(serviceId) ?? []) : [];
    const standardRows = serviceId != null ? (standardByServiceId.get(serviceId) ?? []) : [];
    return resolvePriceFor({ date, customerRows, standardRows, catalog });
  }

  return {
    resolveByCode(serviceCode: string, date: string): PriceResolution | null {
      const entry = catalogByCode.get(serviceCode);
      return resolveForServiceId(entry?.id, entry, date);
    },
    resolveById(serviceId: number, date: string): PriceResolution | null {
      const entry = catalogById.get(serviceId);
      return resolveForServiceId(serviceId, entry, date);
    },
  };
}
