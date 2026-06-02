import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #856 — Spalte `customer_budget_preferences.budget_start_date_origin`.
 *
 * Markiert die Herkunft des `budget_start_date`:
 *   - 'derived_pflegegrad' → automatisch aus dem Pflegegrad-Beginn abgeleitet
 *     (Wizard / POST /initial-budget). Der §45b-Lesepfad kappt den Anker aufs
 *     rechtliche Carryover-/Verfalls-Fenster (aktuelles Jahr + Vorjahr bis 30.06.).
 *   - 'manual' → explizit vom Admin gesetzt (PUT /preferences). Wird NIE gekappt
 *     (manuell gesetzter Start gewinnt immer vor dem abgeleiteten Anker).
 *
 * Idempotent, nullable, ohne destruktiven drizzle-kit-Push (GoBD: Bestand bleibt
 * unverändert). NULL = Altbestand vor #856 und wird im Lesepfad bewusst wie
 * 'manual' behandelt (kein stilles Umrechnen bestehender Kunden-Budgets;
 * betroffene Altkunden werden gezielt per Korrektur-Skript migriert).
 */
// Task #922 — Single-Source-of-Truth für das rohe DDL, damit der Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`) es introspizieren kann, ohne es
// zu duplizieren.
export const BUDGET_START_DATE_ORIGIN_COLUMN_SQL = `
  ALTER TABLE customer_budget_preferences
  ADD COLUMN IF NOT EXISTS budget_start_date_origin text
`;

export async function ensureBudgetStartDateOrigin(): Promise<void> {
  await db.execute(sql.raw(BUDGET_START_DATE_ORIGIN_COLUMN_SQL));
  log("customer_budget_preferences.budget_start_date_origin sichergestellt", "startup");
}
