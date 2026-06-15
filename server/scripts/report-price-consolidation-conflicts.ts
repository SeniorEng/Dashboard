/**
 * Task #1291 (Phase 3.3) — Konflikt-/Verlustfreiheits-Report für die
 * Preis-Konsolidierung (READ-ONLY, kein --apply).
 *
 * Hintergrund:
 *   Drei Preis-Tabellen sollen in EINE konsolidierte `prices`-Tabelle zusammen-
 *   geführt werden, die hinter der `priceFor`-SSoT
 *   (`shared/domain/pricing/price-for.ts`) liegt:
 *     1. customer_service_prices  — Kunden-Override pro Service (Integer-Cents,
 *                                   zeitversioniert). HEUTIGE Live-Quelle.
 *     2. customer_contract_rates  — Kunden-Override pro Vertrag + Service-
 *                                   KATEGORIE (Stunden-Satz in Cents).
 *     3. service_rates            — firmenweiter Standard pro Service-Kategorie
 *                                   (Stunden-Satz in Cents).
 *
 *   Alrik-Constraint #2: BEIDE Kundenquellen (customer_service_prices UND
 *   customer_contract_rates) müssen VERLUSTFREI migriert werden — inklusive
 *   0-/Gratis-Einträge. Dieser Report ist die Entscheidungsvorlage VOR der
 *   (menschlich freigegebenen) destruktiven Konsolidierung. Er schreibt nichts.
 *
 * Was der Report liefert:
 *   - Pro Quelle: Zeilenzahl, davon 0-Cent-/Gratis-Zeilen (müssen erhalten
 *     bleiben — werden explizit aufgelistet, nicht verschluckt).
 *   - KONFLIKTE: gleicher Kunde + gleicher Service mit einer am gleichen Stichtag
 *     aktiven Zeile aus BEIDEN Kundenquellen mit ABWEICHENDEM Cent-Betrag.
 *   - NICHT-ABBILDBARE Zeilen (z. B. Kategorie ohne passenden Katalog-Service)
 *     — Verlust-Risiko, das vor der Migration geklärt werden muss.
 *
 * Aufruf:
 *   tsx server/scripts/report-price-consolidation-conflicts.ts
 *   tsx server/scripts/report-price-consolidation-conflicts.ts --csv=conflicts.csv
 *   tsx server/scripts/report-price-consolidation-conflicts.ts --asof=2026-06-15
 */

import { writeFileSync } from "node:fs";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customerServicePrices,
  customerContracts,
  customerContractRates,
  serviceRates,
  services,
} from "@shared/schema";

type SourceTable = "customer_service_prices" | "customer_contract_rates" | "service_rates";

interface UnifiedPriceRow {
  source: SourceTable;
  sourceRowId: number;
  customerId: number | null; // null = firmenweiter Standard (service_rates)
  serviceId: number | null; // null = keine Katalog-Zuordnung (Verlust-Risiko)
  serviceLabel: string; // Service-Code oder "category:<…>"
  priceCents: number;
  validFrom: string | null;
  validTo: string | null;
}

function toDateStr(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).substring(0, 10);
}

function activeAt(row: { validFrom: string | null; validTo: string | null }, asOf: string): boolean {
  const from = row.validFrom ?? "0000-01-01";
  const to = row.validTo ?? "9999-12-31";
  return asOf >= from && asOf <= to;
}

export interface ConsolidationReport {
  asOf: string;
  rows: UnifiedPriceRow[];
  perSource: Record<SourceTable, { total: number; free: number }>;
  unmapped: UnifiedPriceRow[];
  conflicts: Array<{
    customerId: number;
    serviceLabel: string;
    serviceId: number | null;
    fromCustomerServicePrices: number;
    fromCustomerContractRates: number;
  }>;
  freeRows: UnifiedPriceRow[];
}

/**
 * Liest alle drei Quellen READ-ONLY und baut die Migrations-Vorschau + Konflikt-
 * /Verlust-Analyse. Keine Schreibzugriffe.
 */
export async function buildConsolidationReport(asOf: string): Promise<ConsolidationReport> {
  // Katalog: Service-Code ↔ Service-ID. Die Kategorie-Quellen (contract/service
  // rates) referenzieren `service_category`, das per Code auf den Katalog-Service
  // gemappt wird (hauswirtschaft/alltagsbegleitung/erstberatung).
  const catalog = await db.select({ id: services.id, code: services.code }).from(services);
  const serviceIdByCode = new Map<string, number>();
  const codeByServiceId = new Map<number, string>();
  for (const s of catalog) {
    if (s.code) {
      serviceIdByCode.set(s.code, s.id);
      codeByServiceId.set(s.id, s.code);
    }
  }

  const rows: UnifiedPriceRow[] = [];

  // 1. customer_service_prices (nicht soft-deleted).
  const csp = await db
    .select({
      id: customerServicePrices.id,
      customerId: customerServicePrices.customerId,
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
    })
    .from(customerServicePrices)
    .where(isNull(customerServicePrices.deletedAt));
  for (const r of csp) {
    rows.push({
      source: "customer_service_prices",
      sourceRowId: r.id,
      customerId: r.customerId,
      serviceId: r.serviceId,
      serviceLabel: codeByServiceId.get(r.serviceId) ?? `service#${r.serviceId}`,
      priceCents: r.priceCents,
      validFrom: toDateStr(r.validFrom),
      validTo: toDateStr(r.validTo),
    });
  }

  // 2. customer_contract_rates → customerId über customer_contracts.
  const ccr = await db
    .select({
      id: customerContractRates.id,
      customerId: customerContracts.customerId,
      serviceCategory: customerContractRates.serviceCategory,
      hourlyRateCents: customerContractRates.hourlyRateCents,
      validFrom: customerContractRates.validFrom,
      validTo: customerContractRates.validTo,
    })
    .from(customerContractRates)
    .innerJoin(customerContracts, eq(customerContractRates.contractId, customerContracts.id));
  for (const r of ccr) {
    const serviceId = serviceIdByCode.get(r.serviceCategory) ?? null;
    rows.push({
      source: "customer_contract_rates",
      sourceRowId: r.id,
      customerId: r.customerId,
      serviceId,
      serviceLabel: serviceId != null ? r.serviceCategory : `category:${r.serviceCategory}`,
      priceCents: r.hourlyRateCents,
      validFrom: toDateStr(r.validFrom),
      validTo: toDateStr(r.validTo),
    });
  }

  // 3. service_rates (firmenweiter Standard, kein Kunde).
  const sr = await db
    .select({
      id: serviceRates.id,
      serviceCategory: serviceRates.serviceCategory,
      hourlyRateCents: serviceRates.hourlyRateCents,
      validFrom: serviceRates.validFrom,
      validTo: serviceRates.validTo,
    })
    .from(serviceRates);
  for (const r of sr) {
    const serviceId = serviceIdByCode.get(r.serviceCategory) ?? null;
    rows.push({
      source: "service_rates",
      sourceRowId: r.id,
      customerId: null,
      serviceId,
      serviceLabel: serviceId != null ? r.serviceCategory : `category:${r.serviceCategory}`,
      priceCents: r.hourlyRateCents,
      validFrom: toDateStr(r.validFrom),
      validTo: toDateStr(r.validTo),
    });
  }

  // Aggregate.
  const perSource: ConsolidationReport["perSource"] = {
    customer_service_prices: { total: 0, free: 0 },
    customer_contract_rates: { total: 0, free: 0 },
    service_rates: { total: 0, free: 0 },
  };
  for (const r of rows) {
    perSource[r.source].total++;
    if (r.priceCents === 0) perSource[r.source].free++;
  }

  const unmapped = rows.filter((r) => r.serviceId == null);
  const freeRows = rows.filter((r) => r.priceCents === 0);

  // Konflikte: pro (customerId, serviceId) eine am asOf aktive Zeile aus BEIDEN
  // Kundenquellen mit abweichendem Cent-Betrag.
  const conflicts: ConsolidationReport["conflicts"] = [];
  const customerRows = rows.filter((r) => r.customerId != null && r.serviceId != null);
  const byKey = new Map<string, UnifiedPriceRow[]>();
  for (const r of customerRows) {
    const key = `${r.customerId}:${r.serviceId}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  // Deterministischer „aktiver Gewinner" je Quelle: jüngstes validFrom, bei
  // Gleichstand höchste sourceRowId — identisch zur Resolver-Tie-Breaker-Logik
  // in shared/domain/pricing/price-for.ts. Sonst wäre die Konflikt-Ausgabe bei
  // mehreren überlappenden aktiven Zeilen einer Quelle nicht reproduzierbar.
  const pickWinner = (candidates: UnifiedPriceRow[]) =>
    [...candidates].sort((a, b) =>
      (b.validFrom ?? "").localeCompare(a.validFrom ?? "") || b.sourceRowId - a.sourceRowId,
    )[0];
  for (const [key, list] of byKey) {
    const cspActive = list.filter((r) => r.source === "customer_service_prices" && activeAt(r, asOf));
    const ccrActive = list.filter((r) => r.source === "customer_contract_rates" && activeAt(r, asOf));
    if (cspActive.length === 0 || ccrActive.length === 0) continue;
    const cspWinner = pickWinner(cspActive);
    const ccrWinner = pickWinner(ccrActive);
    const cspCents = cspWinner.priceCents;
    const ccrCents = ccrWinner.priceCents;
    if (cspCents !== ccrCents) {
      const [customerId, serviceId] = key.split(":").map((n) => parseInt(n, 10));
      conflicts.push({
        customerId,
        serviceLabel: cspWinner.serviceLabel,
        serviceId,
        fromCustomerServicePrices: cspCents,
        fromCustomerContractRates: ccrCents,
      });
    }
  }

  return { asOf, rows, perSource, unmapped, conflicts, freeRows };
}

function toCsv(report: ConsolidationReport): string {
  const header = ["source", "sourceRowId", "customerId", "serviceId", "serviceLabel", "priceCents", "validFrom", "validTo"];
  const lines = [header.join(",")];
  for (const r of report.rows) {
    lines.push([
      r.source, r.sourceRowId, r.customerId ?? "", r.serviceId ?? "", r.serviceLabel,
      r.priceCents, r.validFrom ?? "", r.validTo ?? "",
    ].join(","));
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asofArg = args.find((a) => a.startsWith("--asof="));
  const csvArg = args.find((a) => a.startsWith("--csv="));
  const asOf = asofArg ? asofArg.split("=")[1] : toDateStr(new Date())!;
  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  console.log(`=== Preis-Konsolidierungs-Report (READ-ONLY) ===`);
  console.log(`Stichtag (asOf): ${asOf}\n`);

  const report = await buildConsolidationReport(asOf);

  console.log(`Zeilen pro Quelle (gesamt / davon 0-Cent-Gratis):`);
  for (const src of ["customer_service_prices", "customer_contract_rates", "service_rates"] as const) {
    const s = report.perSource[src];
    console.log(`  ${src.padEnd(26)} ${String(s.total).padStart(5)} / ${s.free} gratis`);
  }

  console.log(`\nNicht abbildbare Zeilen (keine Katalog-Zuordnung, VERLUST-RISIKO): ${report.unmapped.length}`);
  for (const r of report.unmapped) {
    console.log(`  [${r.source}] #${r.sourceRowId} ${r.serviceLabel} (${r.priceCents} ct) — Kunde ${r.customerId ?? "—"}`);
  }

  console.log(`\nGratis-/0-Cent-Zeilen (müssen verlustfrei erhalten bleiben): ${report.freeRows.length}`);
  for (const r of report.freeRows) {
    console.log(`  [${r.source}] #${r.sourceRowId} Kunde ${r.customerId ?? "—"} ${r.serviceLabel} validFrom=${r.validFrom ?? "—"} validTo=${r.validTo ?? "offen"}`);
  }

  console.log(`\nKonflikte (beide Kundenquellen aktiv am ${asOf}, abweichender Betrag): ${report.conflicts.length}`);
  for (const c of report.conflicts) {
    console.log(
      `  Kunde #${c.customerId} ${c.serviceLabel}: customer_service_prices=${c.fromCustomerServicePrices} ct ` +
        `vs customer_contract_rates=${c.fromCustomerContractRates} ct`,
    );
  }

  if (csvPath) {
    writeFileSync(csvPath, toCsv(report), "utf8");
    console.log(`\nCSV (vollständige Migrations-Vorschau) geschrieben: ${csvPath}`);
  }

  const blocking = report.unmapped.length + report.conflicts.length;
  console.log(`\n=== Fazit ===`);
  console.log(blocking === 0
    ? "Keine Konflikte, keine unzuordenbaren Zeilen — Konsolidierung wäre verlustfrei abbildbar."
    : `${blocking} klärungsbedürftige(r) Punkt(e) VOR der Konsolidierung — Freigabe durch Alrik erforderlich.`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
