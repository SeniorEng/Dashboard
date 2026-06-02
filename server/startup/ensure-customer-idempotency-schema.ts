import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

// Task #922 — rohes DDL als Single-Source-of-Truth exportiert, damit der
// Drift-Wächter (`tests/startup/startup-schema-drift.test.ts`) es introspizieren
// kann, ohne es zu duplizieren. `created_at`/`expires_at` sind bewusst
// `timestamptz` — das Drizzle-Modell `customerCreationIdempotencyKeys` nutzt den
// `timestamp`-Helper (`withTimezone: true`), die rohe Tabelle MUSS dazu passen,
// sonst altert `drizzle-kit push` die Spalten.
export const CUSTOMERS_SETUP_COLUMNS_SQL = `
  ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS setup_signatures_pending boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS setup_documents_pending  boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS setup_budgets_pending    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS setup_delivery_pending   boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS setup_pending_payloads   jsonb
`;

export const CUSTOMER_IDEMPOTENCY_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS customer_creation_idempotency_keys (
    id serial PRIMARY KEY,
    idempotency_key text NOT NULL,
    payload_hash text NOT NULL,
    customer_id integer,
    created_by_user_id integer REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )
`;

export const CUSTOMER_IDEMPOTENCY_CREATED_BY_COLUMN_SQL = `
  ALTER TABLE customer_creation_idempotency_keys
    ADD COLUMN IF NOT EXISTS created_by_user_id integer REFERENCES users(id)
`;

export const CUSTOMER_IDEMPOTENCY_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS customer_idem_key_unique
    ON customer_creation_idempotency_keys (idempotency_key)
`;

export const CUSTOMER_IDEMPOTENCY_EXPIRES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS customer_idem_key_expires_idx
    ON customer_creation_idempotency_keys (expires_at)
`;

export async function ensureCustomerIdempotencySchema(): Promise<void> {
  try {
    await db.execute(sql.raw(CUSTOMERS_SETUP_COLUMNS_SQL));

    await db.execute(sql.raw(CUSTOMER_IDEMPOTENCY_CREATE_TABLE_SQL));
    // Kompatibilität mit teils-erstellten Umgebungen: Falls die Tabelle
    // schon existierte ohne created_by_user_id (oder mit altem Namen
    // user_id), die korrekte Spalte sicherstellen.
    await db.execute(sql.raw(CUSTOMER_IDEMPOTENCY_CREATED_BY_COLUMN_SQL));
    await db.execute(sql.raw(CUSTOMER_IDEMPOTENCY_UNIQUE_INDEX_SQL));
    await db.execute(sql.raw(CUSTOMER_IDEMPOTENCY_EXPIRES_INDEX_SQL));
  } catch (err) {
    log(`ensureCustomerIdempotencySchema: ${err}`, "startup");
  }
}
