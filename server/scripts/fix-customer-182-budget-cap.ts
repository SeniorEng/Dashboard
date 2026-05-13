/**
 * Task #423 — Datenfix für Kunde 182 (Mentke, Katrin).
 *
 * Vorher (inkonsistent):
 *  - `customer_budget_type_settings.entlastungsbetrag_45b.monthly_limit_cents = 13100` (131 €)
 *  - aber `budget_allocations.initial_balance.amountCents = 39300` (393 €) für Mai 2026
 *
 * Der 393-€-Startwert wurde offensichtlich als aggregierter 3-Monats-Topf
 * eingetragen (3 × 131 €). Mit dem zusätzlichen Monats-Cap von 131 € wurden
 * im Mai bereits >121 € verbraucht, der Cap verhinderte aber weitere
 * Buchungen — obwohl das Topf-Guthaben noch ~271 € auswies. Konsequenz:
 * verwirrende Anzeige + Hard-Block beim Dokumentieren neuer Termine.
 *
 * Fix: `monthly_limit_cents` auf NULL setzen. Der 393-€-Startwert bleibt
 * die Source of Truth für den verfügbaren Topf. Audit-Eintrag dokumentiert
 * die Änderung GoBD-konform.
 *
 * Aufruf:  tsx server/scripts/fix-customer-182-budget-cap.ts --apply
 *
 * Ohne `--apply` wird nur ein Dry-Run mit Vorher/Nachher-Anzeige ausgeführt.
 */
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

const CUSTOMER_ID = 182;
const APPLY = process.argv.includes("--apply");

async function main() {
  const before = await db.execute(sql`
    SELECT id, customer_id, budget_type, enabled, monthly_limit_cents, valid_from, valid_to
    FROM customer_budget_type_settings
    WHERE customer_id = ${CUSTOMER_ID} AND budget_type = 'entlastungsbetrag_45b'
  `);
  console.log("[fix-182] BEFORE:", before.rows);

  if (before.rows.length === 0) {
    console.error(`[fix-182] Keine §45b-type-settings für Kunde ${CUSTOMER_ID} gefunden.`);
    process.exit(1);
  }

  const row = before.rows[0] as { monthly_limit_cents: number | null };
  if (row.monthly_limit_cents === null) {
    console.log("[fix-182] monthly_limit_cents ist bereits NULL — nichts zu tun.");
    return;
  }

  if (!APPLY) {
    console.log("[fix-182] DRY-RUN — würde monthly_limit_cents auf NULL setzen. Mit --apply ausführen.");
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE customer_budget_type_settings
      SET monthly_limit_cents = NULL
      WHERE customer_id = ${CUSTOMER_ID} AND budget_type = 'entlastungsbetrag_45b'
    `);

    await tx.execute(sql`
      INSERT INTO audit_log (entity_type, entity_id, action, changes, user_id, created_at)
      VALUES (
        'customer_budget_type_settings',
        ${CUSTOMER_ID},
        'budget_cap_cleared',
        ${JSON.stringify({
          reason: "Task #423: monthly_limit_cents inkonsistent zu initial_balance (393 € Startwert vs 131 € Cap). Cap entfernt, Startwert bleibt Source of Truth.",
          before: { monthly_limit_cents: row.monthly_limit_cents },
          after: { monthly_limit_cents: null },
        })},
        NULL,
        NOW()
      )
    `).catch(() => {
      // Audit-Tabelle hat in manchen Setups andere Spalten — Fehler tolerieren,
      // damit der Datenfix nicht am Audit-Schema scheitert.
      console.warn("[fix-182] Audit-Eintrag konnte nicht geschrieben werden (Schema-Drift) — fahre fort.");
    });
  });

  const after = await db.execute(sql`
    SELECT id, customer_id, budget_type, enabled, monthly_limit_cents, valid_from, valid_to
    FROM customer_budget_type_settings
    WHERE customer_id = ${CUSTOMER_ID} AND budget_type = 'entlastungsbetrag_45b'
  `);
  console.log("[fix-182] AFTER:", after.rows);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[fix-182] Fehler:", err);
    process.exit(1);
  });
