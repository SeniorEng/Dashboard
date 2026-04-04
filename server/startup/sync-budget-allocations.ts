import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { log } from "../lib/log";

export async function syncAllBudgetAllocations(): Promise<number> {
  const result = await db.execute(sql`
    SELECT DISTINCT cbts.customer_id
    FROM customer_budget_type_settings cbts
    JOIN customers c ON c.id = cbts.customer_id
    WHERE cbts.enabled = true
      AND c.status = 'aktiv'
      AND c.deleted_at IS NULL
  `);

  let synced = 0;
  for (const row of result.rows as Array<{ customer_id: number }>) {
    try {
      await budgetLedgerStorage.syncBudgetAllocations(row.customer_id);
      synced++;
    } catch (err) {
      log(`Budget-Sync Fehler bei Kunde ${row.customer_id}: ${err}`, "startup");
    }
  }

  return synced;
}
