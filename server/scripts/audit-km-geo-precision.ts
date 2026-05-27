/**
 * Task #678 — Audit-Skript für KM-/Geo-Spalten (Sweep #663 High Finding 9).
 *
 * Liest pro betroffener Spalte aus der Production-DB:
 *   - Speichertyp (data_type, precision/scale)
 *   - Anzahl Zeilen gesamt / non-NULL
 *   - Min / Max / Distinct-Count
 *   - 5 Beispielwerte (jüngste Zeilen, falls Primärschlüssel verfügbar)
 *   - Drift-Erkennung: Werte, bei denen `value != ROUND(value::numeric, 3)`
 *     (KM) bzw. `value != ROUND(value::numeric, 6)` (Geo) — sichtbarer
 *     Float-Drift, der nach Migration verschwindet.
 *
 * Nur-lesend. Kein Schreibvorgang. Aufruf:
 *   tsx server/scripts/audit-km-geo-precision.ts
 *
 * Ergebnis dient als Pre-Migrations-Baseline für `docs/migration-km-geo-numeric.md`.
 */
import { sql } from "drizzle-orm";
import { db } from "../lib/db";

type ColumnSpec = {
  table: string;
  column: string;
  type: "km" | "geo";
};

const COLUMNS: ColumnSpec[] = [
  { table: "appointments", column: "travel_kilometers", type: "km" },
  { table: "appointments", column: "customer_kilometers", type: "km" },
  { table: "appointments", column: "no_show_kilometers", type: "km" },
  { table: "employee_time_entries", column: "kilometers", type: "km" },
  { table: "budget_transactions", column: "travel_kilometers", type: "km" },
  { table: "budget_transactions", column: "customer_kilometers", type: "km" },
  { table: "invoice_line_items", column: "quantity_raw", type: "km" },
  { table: "users", column: "latitude", type: "geo" },
  { table: "users", column: "longitude", type: "geo" },
  { table: "customers", column: "latitude", type: "geo" },
  { table: "customers", column: "longitude", type: "geo" },
  { table: "company_settings", column: "latitude", type: "geo" },
  { table: "company_settings", column: "longitude", type: "geo" },
  { table: "appointments", column: "doctor_latitude", type: "geo" },
  { table: "appointments", column: "doctor_longitude", type: "geo" },
];

function unwrapRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const r = (res as { rows?: Array<Record<string, unknown>> })?.rows;
  return r ?? [];
}

async function auditColumn(spec: ColumnSpec) {
  const scale = spec.type === "km" ? 3 : 6;
  const ident = `"${spec.table}"."${spec.column}"`;

  const typeInfo = unwrapRows(await db.execute(sql`
    SELECT data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${spec.table}
      AND column_name = ${spec.column}
    LIMIT 1
  `))[0];
  if (!typeInfo) {
    return { spec, missing: true as const };
  }

  const stats = unwrapRows(await db.execute(sql.raw(`
    SELECT
      COUNT(*)::bigint AS total_rows,
      COUNT(${ident})::bigint AS non_null_rows,
      MIN(${ident})::text AS min_val,
      MAX(${ident})::text AS max_val,
      COUNT(DISTINCT ${ident})::bigint AS distinct_count
    FROM "${spec.table}"
  `)))[0] ?? {};

  const drift = unwrapRows(await db.execute(sql.raw(`
    SELECT COUNT(*)::bigint AS drift_count
    FROM "${spec.table}"
    WHERE ${ident} IS NOT NULL
      AND ${ident}::numeric != ROUND(${ident}::numeric, ${scale})
  `)))[0] ?? {};

  const samples = unwrapRows(await db.execute(sql.raw(`
    SELECT ${ident}::text AS v
    FROM "${spec.table}"
    WHERE ${ident} IS NOT NULL
    ORDER BY ${ident} DESC NULLS LAST
    LIMIT 5
  `)));

  return {
    spec,
    missing: false as const,
    typeInfo,
    stats,
    driftCount: drift.drift_count,
    samples: samples.map((r) => r.v),
  };
}

async function main() {
  console.log("# KM/Geo Precision Audit — Task #678\n");
  console.log("| Tabelle.Spalte | Typ | Zeilen (non-null/total) | Distinct | Min | Max | Float-Drift | Samples |");
  console.log("|---|---|---|---|---|---|---|---|");

  for (const spec of COLUMNS) {
    try {
      const r = await auditColumn(spec);
      if (r.missing) {
        console.log(`| ${spec.table}.${spec.column} | _missing_ | — | — | — | — | — | — |`);
        continue;
      }
      const t = r.typeInfo as Record<string, unknown>;
      const s = r.stats as Record<string, unknown>;
      const typeStr = `${t.data_type}${t.numeric_precision ? `(${t.numeric_precision},${t.numeric_scale})` : ""}`;
      console.log(
        `| ${spec.table}.${spec.column} | ${typeStr} | ${s.non_null_rows}/${s.total_rows} | ${s.distinct_count} | ${s.min_val ?? "—"} | ${s.max_val ?? "—"} | ${r.driftCount} | ${(r.samples ?? []).join(", ")} |`,
      );
    } catch (err) {
      console.log(`| ${spec.table}.${spec.column} | _error_ | ${(err as Error).message} | | | | | |`);
    }
  }

  console.log("\nFloat-Drift = Anzahl Zeilen, bei denen value != ROUND(value::numeric, scale).");
  console.log("Nach Migration auf numeric muss diese Spalte überall 0 sein.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
