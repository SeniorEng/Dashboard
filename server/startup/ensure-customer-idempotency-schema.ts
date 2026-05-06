import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

export async function ensureCustomerIdempotencySchema(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS setup_signatures_pending boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS setup_documents_pending  boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS setup_budgets_pending    boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS setup_delivery_pending   boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS setup_pending_payloads   jsonb
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS customer_creation_idempotency_keys (
        id serial PRIMARY KEY,
        idempotency_key text NOT NULL,
        payload_hash text NOT NULL,
        customer_id integer,
        created_by_user_id integer REFERENCES users(id),
        created_at timestamp NOT NULL DEFAULT now(),
        expires_at timestamp NOT NULL
      )
    `);
    // Kompatibilität mit teils-erstellten Umgebungen: Falls die Tabelle
    // schon existierte ohne created_by_user_id (oder mit altem Namen
    // user_id), die korrekte Spalte sicherstellen.
    await db.execute(sql`
      ALTER TABLE customer_creation_idempotency_keys
        ADD COLUMN IF NOT EXISTS created_by_user_id integer REFERENCES users(id)
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS customer_idem_key_unique
        ON customer_creation_idempotency_keys (idempotency_key)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS customer_idem_key_expires_idx
        ON customer_creation_idempotency_keys (expires_at)
    `);
  } catch (err) {
    log(`ensureCustomerIdempotencySchema: ${err}`, "startup");
  }
}
