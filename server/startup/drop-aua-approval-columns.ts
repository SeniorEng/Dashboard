import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #861 — Drop leftover legacy `customers.aua_approval_ref` /
 * `customers.aua_approval_date` columns.
 *
 * Beide Spalten existieren in der DB, sind aber NICHT im Drizzle-Schema
 * definiert und werden im Produktivcode nirgends gelesen oder geschrieben.
 * Dadurch meldet jeder `drizzle-kit push` (im Post-Merge-Hook) eine
 * destruktive „data-loss"-Änderung und bricht ab — die Warnung wiederholt
 * sich bei jedem Merge.
 *
 * DB-verifiziert (2026-05-30): beide Spalten sind über alle Zeilen 100% NULL.
 * Diese idempotente Migration entfernt sie endgültig — ABER nur, nachdem ein
 * Sicherheits-Guard pro Spalte bestätigt hat, dass tatsächlich kein einziger
 * Nicht-NULL-Wert existiert. Findet sich wider Erwarten ein Wert, bleibt die
 * Spalte erhalten und es wird gewarnt (kein stiller Datenverlust).
 */
// Task #922 — als SSoT exportiert: der Drift-Wächter
// (`tests/startup/startup-schema-drift.test.ts`) stellt sicher, dass diese
// gedroppten Spalten NICHT (wieder) im Drizzle-Modell auftauchen — sonst legt
// `drizzle-kit push` sie an und diese Migration droppt sie beim nächsten Boot
// wieder (Flapping / destruktive Push-Warnung).
export const DROPPED_AUA_APPROVAL_COLUMNS = {
  table: "customers",
  columns: ["aua_approval_ref", "aua_approval_date"],
} as const;

async function dropColumnIfEmpty(column: string): Promise<void> {
  const exists = await db.execute(sql`
    SELECT 1 AS exists
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = ${column}
    LIMIT 1
  `);
  if (exists.rows.length === 0) return;

  const nonNull = await db.execute(
    sql`SELECT 1 AS found FROM customers WHERE ${sql.identifier(column)} IS NOT NULL LIMIT 1`,
  );
  if (nonNull.rows.length > 0) {
    log(
      `Drop customers.${column} übersprungen: Spalte enthält Nicht-NULL-Werte (kein Datenverlust)`,
      "startup",
    );
    return;
  }

  await db.execute(
    sql`ALTER TABLE customers DROP COLUMN IF EXISTS ${sql.identifier(column)}`,
  );
  log(`Migration: customers.${column} entfernt`, "startup");
}

export async function dropAuaApprovalColumns(): Promise<void> {
  try {
    await dropColumnIfEmpty("aua_approval_ref");
    await dropColumnIfEmpty("aua_approval_date");
  } catch (error) {
    log(`Drop customers.aua_approval_* fehlgeschlagen: ${error}`, "startup");
  }
}
