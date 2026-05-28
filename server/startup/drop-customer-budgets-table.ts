import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #743 — Endgültiges Entfernen der eingefrorenen Legacy-Tabelle
 * `customer_budgets`. Vorbedingung: der mit Task #728 Phase 2.1
 * eingeführte Backfill (`backfill-customer-budgets-to-typesettings.ts`)
 * ist auf Production gelaufen und der Operator-Pre-Publish-Check aus
 * `docs/deployment-log.md` (Eintrag 2026-05-28) hat bestätigt, dass alle
 * Inhalte in `customer_budget_type_settings` übernommen sind.
 *
 * Der Backup-Snapshot der Tabelle ist Pflicht — siehe
 * `docs/pre-publish-backup-runbook.md` (§3.2 / §8). Dieses Skript prüft
 * NUR die Existenz und droppt sie idempotent (mehrfacher Lauf ist No-Op).
 */
export async function dropCustomerBudgetsTable(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customer_budgets'
    LIMIT 1
  `);
  const rows = (existing as { rows?: unknown[] }).rows ?? [];
  if (rows.length === 0) {
    return;
  }

  await db.execute(sql`DROP TABLE IF EXISTS customer_budgets CASCADE`);
  log(
    "Legacy-Tabelle customer_budgets gedroppt (Task #743). Vorbedingung: Backfill nach customer_budget_type_settings ist abgeschlossen.",
    "startup",
  );
}
