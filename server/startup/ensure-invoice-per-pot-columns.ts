import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #759 — Variant C (Rechnungs-Split pro Budget-Topf).
 *
 * Stellt die neuen Spalten `invoices.budget_type` und `invoices.billing_run_id`
 * sowie die Tabelle `customer_budget_recipients` sicher. Idempotent, ohne
 * destruktive drizzle-kit-Push-Pfade (GoBD: Bestand bleibt unverändert).
 *
 * - `budget_type` ist nullable — historische Rechnungen vor #759 behalten
 *   NULL und verhalten sich exakt wie zuvor.
 * - `billing_run_id` ist nullable — nur Pot-Split-Läufe mit ≥2 Rechnungen
 *   tragen eine UUID; Single-Pot-Läufe bleiben NULL.
 * - Index auf `billing_run_id` für das Cascade-Storno-Lookup.
 * - `customer_budget_recipients` historisiert pro (Kunde × Topf) optionale
 *   Empfänger-Overrides (append-only via validFrom/validTo).
 */
// Task #922 — rohes DDL als Single-Source-of-Truth exportiert (Drift-Wächter).
// `created_at` ist bewusst `timestamptz` — das Drizzle-Modell
// `customerBudgetRecipients` nutzt den `timestamp`-Helper (`withTimezone: true`),
// die rohe Tabelle MUSS dazu passen, sonst altert `drizzle-kit push` die Spalte.
export const INVOICES_PER_POT_COLUMNS_SQL = `
  ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS budget_type text,
  ADD COLUMN IF NOT EXISTS billing_run_id text
`;

export const INVOICES_BILLING_RUN_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS invoices_billing_run_id_idx
  ON invoices (billing_run_id)
`;

export const CUSTOMER_BUDGET_RECIPIENTS_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS customer_budget_recipients (
    id serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    budget_type text NOT NULL,
    insurance_provider_id integer,
    recipient_name text NOT NULL,
    recipient_address text,
    ik_nummer text,
    versichertennummer text,
    valid_from date NOT NULL,
    valid_to date,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by_user_id integer REFERENCES users(id)
  )
`;

export const CUSTOMER_BUDGET_RECIPIENTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS customer_budget_recipients_customer_idx
  ON customer_budget_recipients (customer_id, budget_type)
`;

export async function ensureInvoicePerPotColumns(): Promise<void> {
  await db.execute(sql.raw(INVOICES_PER_POT_COLUMNS_SQL));
  await db.execute(sql.raw(INVOICES_BILLING_RUN_INDEX_SQL));

  await db.execute(sql.raw(CUSTOMER_BUDGET_RECIPIENTS_CREATE_TABLE_SQL));
  await db.execute(sql.raw(CUSTOMER_BUDGET_RECIPIENTS_INDEX_SQL));

  log("Invoice-Per-Pot-Spalten + customer_budget_recipients sichergestellt", "startup");
}
