import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1326 — Endgültiges Entfernen der drei verwaisten Legacy-Preis-Tabellen
 * `customer_service_prices`, `customer_contract_rates` und `service_rates`.
 *
 * Vorbedingung (Task #1325 — Preis-Konsolidierung): Alle Preis-Lese-/Schreib-
 * pfade lesen/schreiben ausschließlich die vereinheitlichte `prices`-SSoT; die
 * alten Drizzle-Definitionen und jede Code-Referenz auf die drei Tabellen sind
 * entfernt. Die Zeilen wurden im Cutover nach `prices` übernommen, rekonstruiert
 * über `origin`:
 *   - service_rates            → scope="standard" (origin="service_rates")
 *   - customer_contract_rates  → scope="customer"  (origin="customer_contract_rates")
 *   - customer_service_prices  → scope="customer"  (origin="customer_service_prices")
 *
 * DATENSICHERHEIT (Ersetzungs-Regel + GoBD): Dieser Hook droppt eine Tabelle NUR,
 * wenn ihre Zeilen nachweislich bereits in `prices` repräsentiert sind — konkret:
 * wenn die Legacy-Tabelle leer ist ODER `prices` bereits Zeilen mit der passenden
 * `origin` enthält. Sind in der Legacy-Tabelle noch Zeilen, `prices` aber für
 * diese `origin` leer (= Migration noch nicht gelaufen), wird der DROP
 * ÜBERSPRUNGEN und laut geloggt. So verliert ein verfrühter App-Start (vor der
 * Prices-Befüllung) keine produktiven Preis-Daten.
 *
 * Idempotent: prüft Existenz vor dem DROP, mehrfacher Lauf = No-Op.
 *
 * HINWEIS ZUM REPLIT-PUBLISH: Der automatische Publish-Schema-Diff (dev hat die
 * Tabellen nicht mehr, prod noch) generiert den DROP eigenständig im Migrations-
 * Schritt VOR App-Start und umgeht damit diesen Laufzeit-Guard. Vor dem Publish
 * MUSS der Operator daher verifizieren, dass `prices` in prod befüllt ist und die
 * Zeilenzahlen zur Legacy-Quelle passen (read-only Prod-Replica-Vergleich) — siehe
 * docs/deployment-log.md / docs/pre-publish-backup-runbook.md. Ein vorheriges
 * Vollbackup ist Pflicht.
 */

interface LegacyPriceTable {
  readonly table: string;
  readonly origin: string;
}

export const LEGACY_PRICE_TABLES: readonly LegacyPriceTable[] = [
  { table: "customer_service_prices", origin: "customer_service_prices" },
  { table: "customer_contract_rates", origin: "customer_contract_rates" },
  { table: "service_rates", origin: "service_rates" },
];

export async function dropLegacyPriceTables(): Promise<void> {
  for (const { table, origin } of LEGACY_PRICE_TABLES) {
    const existing = await db.execute(sql`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
      LIMIT 1
    `);
    const existsRows = (existing as { rows?: unknown[] }).rows ?? [];
    if (existsRows.length === 0) {
      // Bereits gedroppt (z.B. dev nach Task #1325) — No-Op.
      continue;
    }

    // Datensicherheits-Guard: nur droppen, wenn die Zeilen in `prices` stecken.
    const safety = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM ${sql.identifier(table)}) AS legacy_count,
        (SELECT count(*)::int FROM prices WHERE origin = ${origin}) AS prices_count
    `);
    const safetyRow =
      ((
        safety as unknown as {
          rows?: Array<{ legacy_count: number; prices_count: number }>;
        }
      ).rows ?? [])[0];
    const legacyCount = Number(safetyRow?.legacy_count ?? 0);
    const pricesCount = Number(safetyRow?.prices_count ?? 0);

    if (legacyCount > 0 && pricesCount === 0) {
      log(
        `Legacy-Preis-Tabelle ${table} NICHT gedroppt: ${legacyCount} Zeile(n) vorhanden, ` +
          `aber 0 Zeilen in prices (origin=${origin}). Datenmigration nach prices noch nicht ` +
          `erfolgt — DROP übersprungen, um Datenverlust zu vermeiden (Task #1326).`,
        "startup",
      );
      continue;
    }

    await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(table)}`);
    log(
      `Legacy-Preis-Tabelle ${table} gedroppt (Task #1326). Vorbedingung erfüllt: ` +
        `${legacyCount} Legacy-Zeile(n), ${pricesCount} prices-Zeile(n) mit origin=${origin}.`,
      "startup",
    );
  }
}
