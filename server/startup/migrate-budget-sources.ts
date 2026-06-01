import { sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #828 / Task #895 — Benennt aktive `monthly`-Allocations auf `monthly_auto`
 * um und räumt redundante, bereits soft-gelöschte `monthly_auto`-Duplikate weg.
 *
 * Läuft seit Task #895 über den Guarded-Migrations-Runner
 * (`budget-migration-runner.ts`): Der Runner stellt die Transaktion bereit,
 * setzt transaktions-lokal `app.allow_gobd_mutation = 'on'` (für den legitimen
 * Hard-Delete gegen den GoBD-Trigger `budget_allocations_no_delete`) und klammert
 * den Lauf mit einem Conservation-Pre-/Post-Check ein. Bleibt idempotent: nach
 * dem ersten Lauf trifft die WHERE-Klausel keine Zeile mehr (No-Op).
 *
 * Conservation: Diese Migration ändert nur das `source`-Label aktiver Zeilen
 * (Σ Allocated unverändert) und hard-löscht ausschließlich BEREITS soft-gelöschte
 * Duplikate (zählen ohnehin nicht zur aktiven Allocation) → kein Topf wird
 * überzogen.
 */
export async function migrateBudgetSources(tx: Tx): Promise<BudgetMigrationSummary> {
  const check = await tx.execute(sql`
    SELECT COUNT(*) as cnt FROM budget_allocations
    WHERE source = 'monthly' AND deleted_at IS NULL
  `);
  const pending = Number((check.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0);
  if (pending === 0) {
    return { changed: 0, note: "keine offenen 'monthly'-Allocations" };
  }

  // Legitimer Hard-Delete redundanter, bereits soft-gelöschter 'monthly_auto'-
  // Duplikate. Der GoBD-Bypass ist vom Runner transaktions-lokal gesetzt.
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

  const result = await tx.execute(sql`
    UPDATE budget_allocations
    SET source = 'monthly_auto'
    WHERE source = 'monthly'
      AND deleted_at IS NULL
  `);

  const renamed = (result as { rowCount?: number }).rowCount ?? 0;
  return {
    changed: renamed,
    note: `${renamed} Allocations 'monthly' → 'monthly_auto' umbenannt`,
  };
}
