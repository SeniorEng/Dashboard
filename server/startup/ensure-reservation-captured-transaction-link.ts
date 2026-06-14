import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #1272 — Budget-Ledger Stufe A (Dual-Link).
 *
 * Stellt die neue nullable FK-Spalte `budget_reservations.captured_transaction_id`
 * (→ `budget_transactions.id`) idempotent sicher. GoBD-Bestandsmuster: reines
 * ADD COLUMN IF NOT EXISTS + bedingter FK + Index, KEIN `drizzle-kit push`.
 *
 * Die Spalte ist nullable — Bestands-Reservierungen bleiben unverändert (NULL)
 * und werden erst über den separaten Backfill befüllt. Sie ist seit Stufe C
 * (Task #1274) der EINE Capture-Link (der frühere `captured_ledger_id` auf den
 * `budget_ledger`-Spiegel ist entfernt).
 *
 * Der FK wird SPALTEN-basiert (nicht namens-basiert) geprüft, damit die
 * Migration unabhängig von einer eventuell von `drizzle-kit` abweichenden
 * Constraint-Namens-Trunkierung idempotent bleibt.
 */
export const RESERVATION_CAPTURED_TX_COLUMN_SQL = `
  ALTER TABLE budget_reservations
  ADD COLUMN IF NOT EXISTS captured_transaction_id integer
`;

export const RESERVATION_CAPTURED_TX_FK_SQL = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'budget_reservations'::regclass
        AND c.contype = 'f'
        AND a.attname = 'captured_transaction_id'
    ) THEN
      ALTER TABLE budget_reservations
      ADD CONSTRAINT budget_reservations_captured_transaction_id_budget_transactions_id_fk
      FOREIGN KEY (captured_transaction_id) REFERENCES budget_transactions(id);
    END IF;
  END $$;
`;

export const RESERVATION_CAPTURED_TX_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS budget_reservations_captured_transaction_idx
  ON budget_reservations (captured_transaction_id)
`;

export async function ensureReservationCapturedTransactionLink(): Promise<void> {
  await db.execute(sql.raw(RESERVATION_CAPTURED_TX_COLUMN_SQL));
  await db.execute(sql.raw(RESERVATION_CAPTURED_TX_FK_SQL));
  await db.execute(sql.raw(RESERVATION_CAPTURED_TX_INDEX_SQL));
  log("budget_reservations.captured_transaction_id (Dual-Link) sichergestellt", "startup");
}
