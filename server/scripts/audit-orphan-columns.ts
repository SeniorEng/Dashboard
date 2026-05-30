/**
 * Task #862 — Audit-Skript: verwaiste DB-Spalten/-Tabellen vs. Drizzle-Schema.
 *
 * Hintergrund: Existiert in der Datenbank eine Spalte (oder Tabelle), die NICHT
 * im Drizzle-Schema (`shared/schema/`) definiert ist, meldet jeder
 * `drizzle-kit push` (u.a. im Post-Merge-Hook `scripts/post-merge.sh`) eine
 * destruktive „data-loss"-Änderung und bricht ab — die Warnung wiederholt sich
 * bei jedem Merge. Task #861 hat die ersten beiden Fälle
 * (`customers.aua_approval_ref` / `aua_approval_date`) per Startup-Migration
 * `server/startup/drop-aua-approval-columns.ts` behoben.
 *
 * Dieses Skript ist der wiederverwendbare Audit aus #862: es vergleicht das
 * live-DB-Schema (`information_schema`) mit den im Drizzle-Schema deklarierten
 * Tabellen/Spalten und listet jede DB-Spalte, die im Schema fehlt — inkl.
 * Non-NULL-Zählung als Sicherheits-Indikator, ob ein Drop gefahrlos wäre.
 *
 * Nur-lesend. Kein Schreibvorgang. Aufruf:
 *   tsx server/scripts/audit-orphan-columns.ts
 *
 * Exit-Code 0 = keine verwaisten Spalten/Tabellen (Push bleibt data-loss-frei).
 * Exit-Code 1 = es existieren verwaiste Spalten/Tabellen → pro Fall eine
 *   idempotente Startup-Migration nach dem Muster von
 *   `drop-aua-approval-columns.ts` ergänzen.
 */
import { sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { db } from "../lib/db";
import * as schema from "../../shared/schema";

function unwrapRows<T = Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = (res as { rows?: T[] })?.rows;
  return r ?? [];
}

async function main() {
  // 1. Im Drizzle-Schema deklarierte Tabellen → Spalten-DB-Namen.
  const schemaCols = new Map<string, Set<string>>();
  for (const value of Object.values(schema as Record<string, unknown>)) {
    if (value instanceof PgTable) {
      const cfg = getTableConfig(value);
      schemaCols.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
    }
  }

  // 2. Live-DB-Spalten.
  const dbRows = unwrapRows<{ table_name: string; column_name: string }>(
    await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, ordinal_position
    `),
  );
  const dbTables = new Map<string, string[]>();
  for (const row of dbRows) {
    const cols = dbTables.get(row.table_name) ?? [];
    cols.push(row.column_name);
    dbTables.set(row.table_name, cols);
  }

  const orphanTables: string[] = [];
  const orphanColumns: { table: string; column: string }[] = [];
  for (const [table, cols] of dbTables) {
    const known = schemaCols.get(table);
    if (!known) {
      orphanTables.push(table);
      continue;
    }
    for (const col of cols) {
      if (!known.has(col)) orphanColumns.push({ table, column: col });
    }
  }

  console.log("# Orphan-Column Audit — Task #862\n");

  console.log("## Verwaiste Tabellen (in DB, nicht im Schema)");
  if (orphanTables.length === 0) {
    console.log("_keine_\n");
  } else {
    for (const t of orphanTables) console.log(`- ${t}`);
    console.log("");
  }

  console.log("## Verwaiste Spalten (in DB, nicht im Schema)");
  if (orphanColumns.length === 0) {
    console.log("_keine_\n");
  } else {
    console.log("| Tabelle.Spalte | Non-NULL-Zeilen | Safe-to-Drop |");
    console.log("|---|---|---|");
    for (const { table, column } of orphanColumns) {
      const ident = `"${table}"."${column}"`;
      let nonNull = "?";
      try {
        const r = unwrapRows<{ n: string }>(
          await db.execute(
            sql.raw(
              `SELECT COUNT(*)::bigint AS n FROM "${table}" WHERE ${ident} IS NOT NULL`,
            ),
          ),
        )[0];
        nonNull = String(r?.n ?? "?");
      } catch (err) {
        nonNull = `error: ${(err as Error).message}`;
      }
      const safe = nonNull === "0" ? "ja (100% NULL)" : "PRÜFEN";
      console.log(`| ${table}.${column} | ${nonNull} | ${safe} |`);
    }
    console.log("");
  }

  const total = orphanTables.length + orphanColumns.length;
  if (total === 0) {
    console.log(
      "Ergebnis: keine Drift — `drizzle-kit push` bleibt data-loss-frei.",
    );
    process.exit(0);
  }
  console.log(
    `Ergebnis: ${total} verwaiste Objekt(e). Pro Fall eine idempotente ` +
      "Startup-Migration nach dem Muster von " +
      "server/startup/drop-aua-approval-columns.ts ergänzen.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
