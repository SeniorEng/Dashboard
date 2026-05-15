import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #440 — GoBD-Härtung der Budget-Historisierung.
 *
 * Vorher konnte `customer_budget_type_settings.valid_from` NULL sein
 * (insbesondere für Kunden, die vor der Historisierungsumstellung angelegt
 * wurden). Der neue Aktivitäts-Filter (`getActiveBudgetTypeSettings`) lässt
 * NULL aus Defensiv-Gründen weiterhin gelten, aber GoBD verlangt eine
 * explizite Zeitlinie pro Zeile.
 *
 * Diese einmalige Migration setzt `valid_from = '1970-01-01'` für alle
 * Zeilen, deren `valid_from` aktuell NULL ist (Sentinel-Datum: "schon immer
 * gültig"). Das ist idempotent — nach dem ersten Lauf passt der UPDATE auf
 * keine Zeile mehr.
 *
 * Die historisierte Schließung (`validTo = heute`) und Neuanlage
 * (`validFrom = heute+1`) übernimmt seitdem `upsertBudgetTypeSettings`.
 */
export async function backfillBudgetHistorization(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE customer_budget_type_settings
    SET valid_from = DATE '1970-01-01',
        updated_at = NOW()
    WHERE valid_from IS NULL
  `);
  const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
  if (rowCount > 0) {
    log(
      `Budget-Historisierung: valid_from auf '1970-01-01' in ${rowCount} customer_budget_type_settings-Zeile(n) gesetzt (Task #440).`,
      "startup",
    );
  }

  // Idempotent: Legacy-Voll-UNIQUE-Indexe gezielt entfernen und durch die
  // partiellen Pendants (Task #440) ersetzen. Drizzle-Schema deklariert die
  // neuen Indexe als partial uniqueIndex; in produktiven DBs vor #440 kann
  // hingegen ein älterer Voll-UNIQUE-Index existieren (typisch von
  // drizzle-kit push generierte `_unique` / `_key`-Indexe), der die neue
  // close+insert / replacement-insert-Logik mit Unique-Violations bricht.
  // Wir entfernen ausschließlich die bekannten Legacy-Namen — andere
  // Indexe bleiben unangetastet.
  await db.execute(sql`ALTER TABLE customer_budget_type_settings DROP CONSTRAINT IF EXISTS customer_budget_type_settings_customer_id_budget_type_unique`);
  await db.execute(sql`ALTER TABLE customer_budget_type_settings DROP CONSTRAINT IF EXISTS customer_budget_type_settings_customer_id_budget_type_key`);
  await db.execute(sql`DROP INDEX IF EXISTS customer_budget_type_settings_customer_id_budget_type_unique`);
  await db.execute(sql`DROP INDEX IF EXISTS customer_budget_type_settings_customer_id_budget_type_key`);

  await db.execute(sql`ALTER TABLE budget_allocations DROP CONSTRAINT IF EXISTS budget_allocations_customer_id_budget_type_year_month_source_unique`);
  await db.execute(sql`ALTER TABLE budget_allocations DROP CONSTRAINT IF EXISTS budget_allocations_customer_id_budget_type_year_month_source_key`);
  await db.execute(sql`DROP INDEX IF EXISTS budget_allocations_customer_id_budget_type_year_month_source_unique`);
  await db.execute(sql`DROP INDEX IF EXISTS budget_allocations_customer_id_budget_type_year_month_source_key`);

  // Falls die namensgleichen Indexe `customer_budget_type_settings_unique_idx` /
  // `budget_allocations_auto_unique_idx` in einer vor Task #440 migrierten DB
  // existieren, aber noch als Voll-UNIQUE (ohne WHERE-Klausel) angelegt sind,
  // droppen wir sie gezielt — andernfalls wäre `CREATE UNIQUE INDEX IF NOT
  // EXISTS ...` unten ein No-Op und die alte Voll-Uniqueness würde die neue
  // close+insert / replacement-insert-Logik mit Unique-Violations brechen.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname = 'customer_budget_type_settings_unique_idx'
          AND x.indpred IS NULL
      ) THEN
        EXECUTE 'DROP INDEX customer_budget_type_settings_unique_idx';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname = 'budget_allocations_auto_unique_idx'
          AND x.indpred IS NULL
      ) THEN
        EXECUTE 'DROP INDEX budget_allocations_auto_unique_idx';
      END IF;
    END $$;
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_budget_type_settings_unique_idx
      ON customer_budget_type_settings (customer_id, budget_type)
      WHERE valid_to IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS budget_allocations_auto_unique_idx
      ON budget_allocations (customer_id, budget_type, year, month, source)
      WHERE deleted_at IS NULL
  `);
}
