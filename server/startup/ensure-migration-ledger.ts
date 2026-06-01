import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #895 — Migrations-Ledger für einmalige Budget-Daten-Migrationen.
 *
 * `budget_migrations` protokolliert pro erfolgreich angewendeter Migration eine
 * Zeile (eindeutig per `name`). Der Guarded-Runner
 * (`server/startup/budget-migration-runner.ts`) liest diese Tabelle, um eine
 * Migration genau EINMAL auszuführen, und schreibt den Eintrag INNERHALB der
 * Migrations-Transaktion (Rollback entfernt ihn wieder).
 *
 * Bewusst KEIN GoBD-Immutability-Trigger: Dies ist operative Migrations-
 * Metadaten, kein historisierter Finanzdatensatz.
 *
 * Idempotent (CREATE TABLE/INDEX IF NOT EXISTS) — beim nächsten Boot ein No-Op.
 */
export async function ensureMigrationLedger(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS budget_migrations (
      id serial PRIMARY KEY,
      name text NOT NULL,
      version text NOT NULL DEFAULT '1',
      summary text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS budget_migrations_name_key
    ON budget_migrations (name)
  `);
  log("Budget-Migrations-Ledger sichergestellt", "startup");
}
