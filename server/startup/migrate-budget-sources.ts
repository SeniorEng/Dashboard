import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

export async function migrateBudgetSources(): Promise<void> {
  const check = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM budget_allocations
    WHERE source = 'monthly' AND deleted_at IS NULL
  `);
  const pending = Number((check.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);
  if (pending === 0) return;

  // Task #828: Dieser legitime Hard-Delete redundanter, bereits soft-gelöschter
  // 'monthly_auto'-Duplikate trifft den GoBD-Trigger budget_allocations_no_delete.
  // Bypass transaktions-lokal freischalten (in EINER Transaktion mit dem DELETE).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx.execute(sql`
      DELETE FROM budget_allocations
      WHERE source = 'monthly_auto'
        AND deleted_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM budget_allocations m
          WHERE m.customer_id = budget_allocations.customer_id
            AND m.budget_type = budget_allocations.budget_type
            AND m.year = budget_allocations.year
            AND m.month = budget_allocations.month
            AND m.source = 'monthly'
            AND m.deleted_at IS NULL
        )
    `);
  });

  const result = await db.execute(sql`
    UPDATE budget_allocations 
    SET source = 'monthly_auto'
    WHERE source = 'monthly'
      AND deleted_at IS NULL
  `);

  const renamed = (result as any).rowCount ?? 0;
  if (renamed > 0) {
    log(`Budget-Migration: ${renamed} Allocations von 'monthly' auf 'monthly_auto' umbenannt`, "startup");
  }
}
