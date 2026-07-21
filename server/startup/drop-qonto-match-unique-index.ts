import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #1822 — Teilzahlungen: den partiellen Unique-Index auf
 * `qonto_transactions.matched_invoice_id` entfernen.
 *
 * Bis Task #445 galt „höchstens EINE Qonto-Transaktion pro Rechnung"
 * (Unique-Index `qonto_transactions_matched_invoice_unique_idx`). Für
 * Teilzahlungen müssen sich mehrere Überweisungen auf DIESELBE Rechnung legen
 * und zum Restbetrag aufsummieren — deshalb wird der Unique-Index gelöscht.
 *
 * Die Per-Transaktions-Idempotenz (dieselbe Transaktion nicht doppelt binden)
 * bleibt über den `isNull(matchedInvoiceId)`-Guard in den Match-Schreibpfaden
 * erhalten. Der reine Lookup ist weiterhin über den plain-Index
 * `qonto_transactions_matched_invoice_idx` abgedeckt.
 *
 * Lauffähig idempotent (`DROP INDEX IF EXISTS`). Auf einer frischen DB, die den
 * Index nie hatte, ist der Aufruf ein No-op.
 */
// Index-DDL als Konstante exportiert (Index-Drift-Wächter-SSoT, Task #923).
export const QONTO_MATCH_DROP_UNIQUE_INDEX_SQL = `
  DROP INDEX IF EXISTS qonto_transactions_matched_invoice_unique_idx
`;

export async function dropQontoMatchUniqueIndex(): Promise<void> {
  try {
    await db.execute(sql.raw(QONTO_MATCH_DROP_UNIQUE_INDEX_SQL));
  } catch (err) {
    log(`dropQontoMatchUniqueIndex: ${err}`, "startup");
  }
}
