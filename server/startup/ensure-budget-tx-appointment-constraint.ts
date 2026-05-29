import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #819 — CHECK-Constraint: Consumption-/Reversal-Buchungen MÜSSEN einen
 * Termin-Bezug haben.
 *
 *   transaction_type IN ('manual_adjustment','expiration','write_off')
 *   OR appointment_id IS NOT NULL
 *
 * Damit kann keine `consumption`/`reversal`-Zeile mehr ohne `appointment_id`
 * entstehen (GoBD-Lückenlosigkeit). manual_adjustment/expiration/write_off
 * sind systembedingt termin-los und daher ausgenommen.
 *
 * Sicheres, idempotentes Muster (analog
 * `migrate-erstberatung-customers.ts`):
 *   1. Existiert die Constraint bereits → nichts tun.
 *   2. Sonst verletzende Zeilen zählen. Gibt es welche (z. B. noch nicht
 *      aufgelöste Waisen) → SKIP + Log, damit der Startup NICHT crasht. Der
 *      Backfill `backfillOrphanReversalAppointmentId` MUSS davor laufen.
 *   3. Andernfalls Constraint anlegen.
 */
export async function ensureBudgetTxAppointmentConstraint(): Promise<void> {
  const existing = await db.execute(sql`
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'budget_transactions_appointment_required_check'
      AND t.relname = 'budget_transactions'
  `);

  if ((existing.rows as unknown[]).length > 0) {
    return;
  }

  const violating = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM budget_transactions
    WHERE appointment_id IS NULL
      AND transaction_type NOT IN ('manual_adjustment', 'expiration', 'write_off')
  `);
  const violatingCount = Number(
    (violating.rows as Array<{ cnt: string }>)[0]?.cnt ?? 0,
  );

  if (violatingCount > 0) {
    log(
      `CHECK-Constraint budget_transactions_appointment_required_check übersprungen: ` +
        `${violatingCount} Buchungen ohne appointment_id (Backfill muss zuerst laufen)`,
      "startup",
    );
    return;
  }

  await db.execute(sql`
    ALTER TABLE budget_transactions
    ADD CONSTRAINT budget_transactions_appointment_required_check
    CHECK (
      transaction_type IN ('manual_adjustment', 'expiration', 'write_off')
      OR appointment_id IS NOT NULL
    )
  `);
  log(
    "CHECK-Constraint budget_transactions_appointment_required_check hinzugefügt (Task #819)",
    "startup",
  );
}
