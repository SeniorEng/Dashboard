import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";

/**
 * Task #445 — Idempotenz-Constraint für Qonto-Matches.
 *
 * Stellt einen partiellen Unique-Index auf
 * `qonto_transactions.matched_invoice_id` (WHERE NOT NULL) sicher,
 * sodass keine zwei Qonto-Transaktionen dieselbe Rechnung matchen
 * können (Doppelmatch-Schutz bei parallelem autoMatch/manuellem Match).
 *
 * Lauffähig idempotent (`IF NOT EXISTS`). Wenn bereits Duplikate
 * existieren, scheitert die Index-Erstellung — Fehler wird geloggt,
 * Bootstrapping läuft weiter, damit der Server hochfährt und ein
 * Operator die Duplikate manuell auflösen kann.
 */
export async function ensureQontoMatchIdempotency(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS qonto_transactions_matched_invoice_unique_idx
        ON qonto_transactions (matched_invoice_id)
        WHERE matched_invoice_id IS NOT NULL
    `);
  } catch (err) {
    log(`ensureQontoMatchIdempotency: ${err}`, "startup");
  }
}
