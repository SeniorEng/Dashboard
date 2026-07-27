import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

// Task #943 — rohes CHECK-Constraint-DDL als SSoT-Konstante exportiert
// (Constraint-Drift-Wächter, analog zu den Spalten-/Index-Konstanten).
export const BUDGET_TX_APPOINTMENT_CHECK_NAME =
  "budget_transactions_appointment_required_check";

export const BUDGET_TX_APPOINTMENT_CHECK_SQL = `
    ALTER TABLE budget_transactions
    ADD CONSTRAINT budget_transactions_appointment_required_check
    CHECK (
      transaction_type IN ('manual_adjustment', 'expiration', 'write_off')
      OR appointment_id IS NOT NULL
    )
  `;

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
 *
 * @public — SSoT-AP0 (Task #1841): Diese Funktion ist AKTUELL bewusst NICHT im
 * Startup verdrahtet (siehe `server/index.ts` — die Constraint wird
 * „vorübergehend NICHT mehr beim Startup angelegt", weil Legacy-Waisen noch
 * nicht aufgelöst sind und ein `km-rebook` das `appointment_id` kurzzeitig auf
 * NULL setzt). Sie bleibt als SSoT-DDL + Constraint-Drift-Wächter erhalten und
 * wird vom deferred Follow-up (Rebook-Null-Out-Fix + Umstellung aller
 * Consumption-/Availability-Reader auf reversed-Rows) wieder scharf geschaltet.
 * Der `@public`-Tag hält das knip-Dead-Code-Gate ruhig, OHNE diese Rationale zu
 * verstecken — bitte NICHT löschen.
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

  await db.execute(sql.raw(BUDGET_TX_APPOINTMENT_CHECK_SQL));
  log(
    "CHECK-Constraint budget_transactions_appointment_required_check hinzugefügt (Task #819)",
    "startup",
  );
}
