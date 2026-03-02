import { db } from "../lib/db";
import { sql } from "drizzle-orm";

export async function repairDuplicateInitialBalances(): Promise<void> {
  try {
    const duplicates = await db.execute(sql`
      WITH ranked AS (
        SELECT id, customer_id, budget_type, year, month, amount_cents,
          ROW_NUMBER() OVER (
            PARTITION BY customer_id, budget_type, year
            ORDER BY
              CASE WHEN month IS NOT NULL THEN 0 ELSE 1 END,
              id DESC
          ) AS rn
        FROM budget_allocations
        WHERE source = 'initial_balance'
      )
      SELECT id, customer_id, budget_type, year, month, amount_cents
      FROM ranked WHERE rn > 1
    `);

    if (duplicates.rows.length === 0) {
      console.log("[STARTUP] Keine doppelten Startwerte gefunden");
      return;
    }

    for (const dup of duplicates.rows as { id: number }[]) {
      await db.execute(sql`DELETE FROM budget_allocations WHERE id = ${dup.id}`);
    }

    console.log(`[STARTUP] ${duplicates.rows.length} doppelte Startwerte bereinigt`);
  } catch (error) {
    console.error("[STARTUP] Fehler bei Startwert-Bereinigung:", error);
  }
}
