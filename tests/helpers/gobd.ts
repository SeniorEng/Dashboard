import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Test-Helper: führt `fn` in EINER Transaktion mit transaktions-lokal
 * freigeschaltetem GoBD-Bypass aus.
 *
 * Hintergrund: `invoices`, `invoice_line_items`, `budget_allocations` und
 * `customer_budget_type_settings` sind per BEFORE-Trigger
 * (`server/startup/ensure-gobd-table-immutability.ts`) gegen Hard-Deletes
 * (bzw. Mutationen finalisierter Zeilen) geschützt. Test-Teardowns, die diese
 * Zeilen wirklich entfernen müssen, schalten den dokumentierten Bypass
 * `SET LOCAL app.allow_gobd_mutation = 'on'` frei — `SET LOCAL` gilt nur
 * innerhalb dieser Transaktion und wird beim Commit/Rollback verworfen.
 *
 * Niemals in Produktionspfaden verwenden — ausschließlich Test-Cleanup.
 */
export async function withGobdMutation<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    return fn(tx);
  });
}
