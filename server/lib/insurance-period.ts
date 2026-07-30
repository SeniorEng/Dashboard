/**
 * Task #1893 — SQL-Prädikate für die stichtagsbezogene Kostenträger-Zuordnung.
 *
 * DAS eine Fenster-Prädikat für Filter- und Gruppierungs-Lesepfade, die aus
 * Performance-Gründen im SQL joinen statt den Row-Resolver
 * (`resolveCustomerInsuranceAt`) je Kunde aufzurufen. Semantisch identisch:
 * `validFrom <= asOf AND (validTo IS NULL OR validTo >= asOf)`, beide Grenzen
 * inklusiv.
 *
 * ERSETZT die verstreuten `valid_to IS NULL`-Bedingungen in Payer-Liste,
 * Rechnungslisten-Filter, Termin-/Economics-Cluster und Bundle-Gruppierung.
 * Ohne das ordnet ein Kassenwechsel rückwirkend ALLE Altmonate der neuen Kasse
 * zu — Filter und Rechnungsempfänger würden auseinanderlaufen.
 */

import { sql, and, isNull, or, lte, gte, type SQL } from "drizzle-orm";
import { customerInsuranceHistory } from "@shared/schema";

/**
 * Drizzle-Bedingung auf `customerInsuranceHistory` für einen festen Stichtag.
 * Für Query-Builder-Pfade (`db.select().from(customerInsuranceHistory)`).
 */
export function insuranceValidAt(asOfISO: string): SQL | undefined {
  return and(
    lte(customerInsuranceHistory.validFrom, asOfISO),
    or(
      isNull(customerInsuranceHistory.validTo),
      gte(customerInsuranceHistory.validTo, asOfISO),
    ),
  );
}

/**
 * Roh-SQL-Fragment für einen festen Stichtag, z. B. in `EXISTS (SELECT 1 FROM
 * customer_insurance_history cih WHERE … ${insuranceValidAtSqlRaw("cih", asOf)})`.
 *
 * @param alias Tabellen-Alias im umgebenden Statement.
 */
export function insuranceValidAtSqlRaw(alias: string, asOfISO: string): SQL {
  const col = sql.raw(alias);
  return sql`${col}.valid_from <= ${asOfISO} AND (${col}.valid_to IS NULL OR ${col}.valid_to >= ${asOfISO})`;
}

/**
 * Roh-SQL-Fragment mit KORRELIERTEM Stichtag: der Stichtag wird je Zeile aus dem
 * Abrechnungsmonat der Rechnung abgeleitet (letzter Tag des Monats). Nötig, wo
 * ein Statement Rechnungen mehrerer Monate gleichzeitig filtert — dort gibt es
 * keinen einzelnen Stichtag.
 *
 * @param alias Alias der `customer_insurance_history`-Zeile.
 * @param yearCol Voll qualifizierte Spalte mit dem Abrechnungsjahr.
 * @param monthCol Voll qualifizierte Spalte mit dem Abrechnungsmonat.
 */
export function insuranceValidAtBillingMonthSqlRaw(
  alias: string,
  yearCol: SQL | string,
  monthCol: SQL | string,
): SQL {
  const col = sql.raw(alias);
  const year = typeof yearCol === "string" ? sql.raw(yearCol) : yearCol;
  const month = typeof monthCol === "string" ? sql.raw(monthCol) : monthCol;
  // Letzter Tag des Abrechnungsmonats als date.
  const asOf = sql`((make_date(${year}, ${month}, 1) + interval '1 month' - interval '1 day')::date)`;
  return sql`${col}.valid_from <= ${asOf} AND (${col}.valid_to IS NULL OR ${col}.valid_to >= ${asOf})`;
}
