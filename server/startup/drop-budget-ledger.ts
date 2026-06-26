import { sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

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

/**
 * Task #1446 — Scharfgeschaltete, gegatete Variante des budget_ledger-Drops.
 *
 * Läuft als `GuardedBudgetMigration` (Name `drop-budget-ledger-1443`) über
 * `runGuardedBudgetMigration`, registriert NUR bei gesetztem Freigabe-Flag
 * `APPROVED_DROP_BUDGET_LEDGER`. Über den Wrapper erbt der Drop für umsonst:
 * exactly-once-Ledger-Insert in der Tx, `pg_advisory_xact_lock`, EINE
 * Transaktion und PRE/POST-`checkBudgetConservation` mit Auto-Rollback.
 *
 * Die beiden rohen SQL-Statements laufen gegen die bereitgestellte `tx`
 * (FK-sicher: ZUERST die Spalte `captured_ledger_id`, sonst verhindert der FK
 * das `DROP TABLE`). `checkBudgetConservation` liest `budget_ledger`/
 * `capturedLedgerId` nicht mehr (Kreuzcheck über `captured_transaction_id →
 * budget_transactions`), daher ist der POST-Check in derselben Transaktion auch
 * nach dem Drop gültig. SQL-Text/Reihenfolge und die `DROPPED_*`-Registry
 * bleiben unverändert (der Drift-Wächter introspiziert sie).
 */
export async function dropBudgetLedger(tx: Tx): Promise<BudgetMigrationSummary> {
  await tx.execute(sql.raw(DROP_BUDGET_RESERVATIONS_CAPTURED_LEDGER_ID_SQL));
  await tx.execute(sql.raw(DROP_BUDGET_LEDGER_TABLE_SQL));
  const note =
    "budget_reservations.captured_ledger_id + Tabelle budget_ledger entfernt (Stufe C)";
  log(note, "startup");
  return { changed: 1, note };
}
