import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1274 — Budget-Ledger Stufe C (finale Entfernung).
 *
 * Der frühere `budget_ledger` war zuletzt nur noch ein reiner Spiegel von
 * `budget_transactions` (Capture-Insert im Hard-Hold-Pfad). Seit Stufe B
 * (Task #1273) liegt die GoBD-Immutability auf `budget_transactions`, seit
 * Stufe A (Task #1272) trägt jede captured Reservierung den EINEN Capture-Link
 * `budget_reservations.captured_transaction_id` (→ `budget_transactions.id`).
 * Damit ist sowohl die Spiegel-Tabelle als auch der alte Zweit-Link
 * `budget_reservations.captured_ledger_id` (→ `budget_ledger.id`) überflüssig.
 *
 * Dieser Schritt entfernt beide idempotent und OHNE destruktiven
 * `drizzle-kit push`: zuerst die FK-Spalte `captured_ledger_id` (sonst
 * verhindert der FK das DROP der Tabelle), danach die Tabelle selbst.
 */
// Single-Source-of-Truth für das rohe DDL, damit der Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`) die gedroppte Spalte
// introspizieren kann, ohne sie zu duplizieren.
export const DROP_BUDGET_RESERVATIONS_CAPTURED_LEDGER_ID_SQL = `
  ALTER TABLE budget_reservations
    DROP COLUMN IF EXISTS captured_ledger_id
`;

export const DROP_BUDGET_LEDGER_TABLE_SQL = `
  DROP TABLE IF EXISTS budget_ledger
`;

/** DROP-Registry für den Drift-Wächter: Spalte MUSS aus dem Modell weg sein. */
export const DROPPED_BUDGET_RESERVATIONS_CAPTURED_LEDGER_ID = {
  table: "budget_reservations",
  column: "captured_ledger_id",
} as const;

export async function dropBudgetLedger(): Promise<void> {
  await db.execute(sql.raw(DROP_BUDGET_RESERVATIONS_CAPTURED_LEDGER_ID_SQL));
  await db.execute(sql.raw(DROP_BUDGET_LEDGER_TABLE_SQL));
  log(
    "budget_reservations.captured_ledger_id + Tabelle budget_ledger entfernt (Stufe C)",
    "startup",
  );
}
