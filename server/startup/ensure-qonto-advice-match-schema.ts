import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1672 — Schema-Erweiterung für den Sammel-Avis ↔ Sammelzahlung-Match.
 *
 * Additiv/expand-safe (kein destruktiver Diff), idempotent:
 *  - Spalte `matched_payment_advice_id` (FK → payment_advices): eine
 *    Sammelzahlung zeigt auf ein ganzes Avis statt auf eine Einzelrechnung.
 *  - Spalte `advice_suggestion_dismissed_at`: abgelehnte rückwirkende
 *    Vorschläge tauchen beim nächsten Sync/Import nicht erneut auf.
 *  - Partieller Unique-Index (ein Avis ↔ eine Zahlung).
 *  - Such-Index auf der FK-Spalte.
 *  - XOR-Check: nie gleichzeitig auf Einzelrechnung UND Avis gebunden.
 *
 * Kein `drizzle-kit push`. Bei existierenden verletzenden Daten schlägt nur der
 * jeweilige Schritt fehl (Fehler geloggt, Boot läuft weiter).
 */
export const QONTO_ADVICE_MATCH_DDL: string[] = [
  `ALTER TABLE qonto_transactions
     ADD COLUMN IF NOT EXISTS matched_payment_advice_id integer
     REFERENCES payment_advices(id)`,
  `ALTER TABLE qonto_transactions
     ADD COLUMN IF NOT EXISTS advice_suggestion_dismissed_at timestamp`,
  `CREATE UNIQUE INDEX IF NOT EXISTS qonto_transactions_matched_advice_unique_idx
     ON qonto_transactions (matched_payment_advice_id)
     WHERE matched_payment_advice_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS qonto_transactions_matched_advice_idx
     ON qonto_transactions (matched_payment_advice_id)`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'qonto_transactions_match_xor'
     ) THEN
       ALTER TABLE qonto_transactions
         ADD CONSTRAINT qonto_transactions_match_xor
         CHECK (NOT (matched_invoice_id IS NOT NULL AND matched_payment_advice_id IS NOT NULL));
     END IF;
   END $$`,
];

export async function ensureQontoAdviceMatchSchema(): Promise<void> {
  for (const ddl of QONTO_ADVICE_MATCH_DDL) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err) {
      log(`ensureQontoAdviceMatchSchema: ${err}`, "startup");
    }
  }
}
