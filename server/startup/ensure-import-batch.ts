import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #819 — Import-Batch-Protokoll & Verlinkung.
 *
 * Legt idempotent an:
 *   - Tabelle `import_batches` (Datei-Hash für Doppel-Import-Erkennung,
 *     Zähler für importierte/aktualisierte/übersprungene Zeilen).
 *   - Spalte `appointments.import_batch_id`.
 *   - Spalte `budget_transactions.import_batch_id`.
 *
 * KEIN `drizzle-kit push` — bewusst explizit, damit Drizzle die bestehenden
 * großen Tabellen nicht per Diff-Heuristik anfasst.
 */
// Task #922 — rohes DDL als Single-Source-of-Truth exportiert (Drift-Wächter).
export const IMPORT_BATCHES_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS import_batches (
    id SERIAL PRIMARY KEY,
    file_name TEXT,
    file_hash TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    imported_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id INTEGER REFERENCES users(id)
  )
`;

export const IMPORT_BATCHES_FILE_HASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS import_batches_file_hash_idx ON import_batches (file_hash)
`;

export const APPOINTMENTS_IMPORT_BATCH_ID_COLUMN_SQL = `
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS import_batch_id INTEGER
`;

export const BUDGET_TRANSACTIONS_IMPORT_BATCH_ID_COLUMN_SQL = `
  ALTER TABLE budget_transactions ADD COLUMN IF NOT EXISTS import_batch_id INTEGER
`;

export async function ensureImportBatch(): Promise<void> {
  await db.execute(sql.raw(IMPORT_BATCHES_CREATE_TABLE_SQL));
  await db.execute(sql.raw(IMPORT_BATCHES_FILE_HASH_INDEX_SQL));
  await db.execute(sql.raw(APPOINTMENTS_IMPORT_BATCH_ID_COLUMN_SQL));
  await db.execute(sql.raw(BUDGET_TRANSACTIONS_IMPORT_BATCH_ID_COLUMN_SQL));

  log("Import-Batch-Tabelle + import_batch_id-Spalten sichergestellt (Task #819)", "startup");
}
