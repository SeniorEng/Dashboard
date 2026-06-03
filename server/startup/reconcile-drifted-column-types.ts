import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #924 — Reconcile bereits-provisionierter Prod-DBs, deren Spalten von den
 * alten (mittlerweile in #922 korrigierten) Startup-Migrationen mit dem FALSCHEN
 * Typ angelegt wurden.
 *
 * Hintergrund: Die Startup-Migrationen nutzen `CREATE TABLE IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS`. Bestehende DBs behalten daher den Typ, den das
 * alte DDL erzeugt hat — eine reine DDL-Korrektur altert sie NICHT rückwirkend.
 * Bis sie versöhnt sind, würde der nächste `drizzle-kit push` gegen Prod diese
 * Spalten anfassen wollen.
 *
 * Diese Migration ist idempotent: pro Ziel-Spalte wird der aktuelle DB-Typ aus
 * `information_schema` gelesen und NUR dann ein `ALTER COLUMN … SET DATA TYPE`
 * ausgeführt, wenn der Ist-Typ vom Soll-Typ abweicht. Existiert die Spalte (noch)
 * nicht, wird sie übersprungen — die jeweilige `ensure-*`-Migration legt sie dann
 * bereits mit dem korrekten Typ an.
 *
 * Die Ziel-Registry ist exportiert, damit der Drift-Wächter
 * (`tests/startup/startup-schema-drift.test.ts`) prüfen kann, dass jeder hier
 * versöhnte Soll-Typ exakt der Drizzle-Deklaration entspricht.
 */
export const RECONCILE_COLUMN_TYPE_TARGETS: ReadonlyArray<{
  table: string;
  column: string;
  /** Kanonischer Soll-Typ (== `canonDrizzleType` im Drift-Wächter). */
  targetType: "text" | "timestamptz";
  /** `information_schema.columns.data_type`, wenn die Spalte bereits korrekt ist. */
  expectedDataType: string;
}> = [
  // Das alte `fix-invoice-line-item-types`-DDL hat `inaktiv_ab` fälschlich auf
  // `date` konvertiert; das Drizzle-Modell deklariert `text("inaktiv_ab")`.
  {
    table: "customers",
    column: "inaktiv_ab",
    targetType: "text",
    expectedDataType: "text",
  },
  // Das alte CREATE-TABLE-DDL legte diese Zeitstempel als plain `timestamp` an;
  // das Drizzle-Modell nutzt den `timestamp`-Helper mit `withTimezone: true`.
  {
    table: "customer_creation_idempotency_keys",
    column: "created_at",
    targetType: "timestamptz",
    expectedDataType: "timestamp with time zone",
  },
  {
    table: "customer_creation_idempotency_keys",
    column: "expires_at",
    targetType: "timestamptz",
    expectedDataType: "timestamp with time zone",
  },
  {
    table: "customer_budget_recipients",
    column: "created_at",
    targetType: "timestamptz",
    expectedDataType: "timestamp with time zone",
  },
];

export async function reconcileDriftedColumnTypes(): Promise<void> {
  const changed: string[] = [];

  for (const target of RECONCILE_COLUMN_TYPE_TARGETS) {
    const res = await db.execute(sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${target.table}
        AND column_name = ${target.column}
      LIMIT 1
    `);
    const dataType = (res.rows[0] as { data_type?: string } | undefined)?.data_type;
    // Spalte (noch) nicht vorhanden → die ensure-*-Migration legt sie korrekt an.
    if (dataType === undefined) continue;
    // Bereits korrekt → nichts zu tun (Idempotenz).
    if (dataType === target.expectedDataType) continue;

    await db.execute(sql.raw(
      `ALTER TABLE "${target.table}" ALTER COLUMN "${target.column}" SET DATA TYPE ${target.targetType} USING "${target.column}"::${target.targetType}`,
    ));
    changed.push(`${target.table}.${target.column}: ${dataType}→${target.targetType}`);
  }

  if (changed.length > 0) {
    log(`Drift-Spaltentypen versöhnt: ${changed.join(", ")}`, "startup");
  }
}
