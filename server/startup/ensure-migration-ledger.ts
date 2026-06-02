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
 *
 * Task #921 — Diese Tabelle ist in ZWEI Quellen deklariert, die byte-identisch
 * bleiben müssen: hier (rohes SQL, legt sie zur Laufzeit an) UND als Drizzle-
 * Modell `budgetMigrations` in `shared/schema/budget.ts` (damit `drizzle-kit
 * push` sie kennt und NICHT zu löschen/altern versucht). Damit ein
 * Architektur-Test (`tests/startup/migration-ledger-schema-drift.test.ts`) das
 * rohe SQL gegen das Drizzle-Modell prüfen kann, OHNE es zu duplizieren, sind
 * die DDL-Statements als Konstanten exportiert — sie sind die Single-Source-of-
 * Truth für das rohe SQL.
 */
export const MIGRATION_LEDGER_TABLE = "budget_migrations";
export const MIGRATION_LEDGER_NAME_INDEX = "budget_migrations_name_key";

export const MIGRATION_LEDGER_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS budget_migrations (
    id serial PRIMARY KEY,
    name text NOT NULL,
    version text NOT NULL DEFAULT '1',
    summary text,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export const MIGRATION_LEDGER_CREATE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS budget_migrations_name_key
  ON budget_migrations (name)
`;

export async function ensureMigrationLedger(): Promise<void> {
  await db.execute(sql.raw(MIGRATION_LEDGER_CREATE_TABLE_SQL));
  await db.execute(sql.raw(MIGRATION_LEDGER_CREATE_INDEX_SQL));
  log("Budget-Migrations-Ledger sichergestellt", "startup");
}
