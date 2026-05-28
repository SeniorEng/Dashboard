import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #728 (Phase 2.1) — Einmalige Backfill-Migration: Inhalt der
 * Legacy-Tabelle `customer_budgets` in die SSoT
 * `customer_budget_type_settings` übertragen, bevor die Lese-Fallbacks in
 * `server/storage/budget/allocation-storage.ts`
 * (`getMonthlyBudgetAmountCents` / `getCustomerBudgetAmounts`) abgeschaltet
 * werden.
 *
 * Mapping pro Kunde (LATEST `customer_budgets`-Zeile pro Customer,
 * unabhängig vom `validTo`-Stand — die Tabelle wurde historisch immer
 * mit „letzter Eintrag = wahrer Stand" gepflegt):
 *   - entlastungsbetrag45b > 0   → entlastungsbetrag_45b.monthly_limit_cents
 *   - pflegesachleistungen36 > 0 → umwandlung_45a.monthly_limit_cents
 *   - verhinderungspflege39 > 0  → ersatzpflege_39_42a.yearly_limit_cents
 *
 * Idempotenz: pro (customer_id, budget_type) wird NUR geschrieben, wenn
 * dort noch GAR KEINE Zeile existiert (offen ODER geschlossen). Damit
 * überschreibt der Backfill nie eine bereits historisierte Konfiguration
 * und kann beliebig oft laufen.
 *
 * `valid_from` = `customer_budgets.valid_from` falls vorhanden, sonst
 * der Sentinel '1970-01-01' (= „schon immer gültig", siehe
 * `shared/domain/budget-settings-sentinel.ts` — wird hier als SQL-Literal
 * eingesetzt, weil die Whitelist von `budget-sentinel-uniqueness.test.ts`
 * Roh-SQL-Backfills ausdrücklich erlaubt).
 *
 * `enabled = true`, `priority` aus der gesetzlichen Reihenfolge (1/2/3).
 */
export async function backfillCustomerBudgetsToTypeSettings(): Promise<void> {
  const result = await db.execute(sql`
    WITH latest_budgets AS (
      SELECT DISTINCT ON (customer_id)
        customer_id,
        entlastungsbetrag_45b,
        verhinderungspflege_39,
        pflegesachleistungen_36,
        valid_from
      FROM customer_budgets
      ORDER BY customer_id, valid_from DESC NULLS LAST, id DESC
    ),
    mapped AS (
      SELECT
        customer_id,
        'entlastungsbetrag_45b'::text AS budget_type,
        1 AS priority,
        entlastungsbetrag_45b AS monthly_limit_cents,
        NULL::integer AS yearly_limit_cents,
        valid_from
      FROM latest_budgets
      WHERE entlastungsbetrag_45b IS NOT NULL AND entlastungsbetrag_45b > 0
      UNION ALL
      SELECT
        customer_id,
        'umwandlung_45a'::text,
        2,
        pflegesachleistungen_36,
        NULL::integer,
        valid_from
      FROM latest_budgets
      WHERE pflegesachleistungen_36 IS NOT NULL AND pflegesachleistungen_36 > 0
      UNION ALL
      SELECT
        customer_id,
        'ersatzpflege_39_42a'::text,
        3,
        NULL::integer,
        verhinderungspflege_39,
        valid_from
      FROM latest_budgets
      WHERE verhinderungspflege_39 IS NOT NULL AND verhinderungspflege_39 > 0
    )
    INSERT INTO customer_budget_type_settings (
      customer_id, budget_type, enabled, priority,
      monthly_limit_cents, yearly_limit_cents,
      valid_from, valid_to,
      created_at, updated_at
    )
    SELECT
      m.customer_id,
      m.budget_type,
      TRUE,
      m.priority,
      m.monthly_limit_cents,
      m.yearly_limit_cents,
      COALESCE(m.valid_from, DATE '1970-01-01'),
      NULL,
      NOW(),
      NOW()
    FROM mapped m
    WHERE NOT EXISTS (
      SELECT 1
      FROM customer_budget_type_settings s
      WHERE s.customer_id = m.customer_id
        AND s.budget_type = m.budget_type
    )
  `);

  const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
  if (rowCount > 0) {
    log(
      `Backfill customer_budgets → customer_budget_type_settings: ${rowCount} Zeilen migriert (Task #728 Phase 2.1)`,
      "startup",
    );
  }
}
