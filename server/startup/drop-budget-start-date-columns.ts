import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1204 — Entfernt die persistierten Budget-Anker-Spalten
 * `customer_budget_preferences.budget_start_date` und
 * `budget_start_date_origin`.
 *
 * Der Budget-Anker wird seit Task #1204 zur LAUFZEIT pro Topf aus der
 * Pflegegrad-Historie abgeleitet (§45a/§39 = roher frühester Pflegegrad-Beginn,
 * §45b aufs laufende Jahr gebodet) — siehe
 * `server/storage/budget/allocation-storage.ts`. Eine persistierte Anker-Spalte
 * ist damit überflüssig und konnte historisch falsch stehen bleiben; sie wird
 * hier idempotent (ohne destruktiven drizzle-kit-Push) entfernt. Der
 * Stichmonat bleibt über die `initial_balance`-Allokation (`validFrom`)
 * erhalten, die Monatslimits über `monthly_limit_cents`.
 */
// Single-Source-of-Truth für das rohe DDL, damit der Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`) es introspizieren kann, ohne es
// zu duplizieren.
export const DROP_BUDGET_START_DATE_COLUMNS_SQL = `
  ALTER TABLE customer_budget_preferences
    DROP COLUMN IF EXISTS budget_start_date,
    DROP COLUMN IF EXISTS budget_start_date_origin
`;

export async function dropBudgetStartDateColumns(): Promise<void> {
  await db.execute(sql.raw(DROP_BUDGET_START_DATE_COLUMNS_SQL));
  log("customer_budget_preferences.budget_start_date(_origin) entfernt", "startup");
}
