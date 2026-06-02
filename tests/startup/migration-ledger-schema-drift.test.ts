/**
 * Task #921 — Drift-Wächter für die Migrations-Ledger-Tabelle `budget_migrations`.
 *
 * Die Tabelle ist an ZWEI Stellen deklariert, die byte-identisch bleiben müssen:
 *   1. Rohes SQL in `server/startup/ensure-migration-ledger.ts`
 *      (legt die Tabelle zur Laufzeit/in Produktion an).
 *   2. Drizzle-Modell `budgetMigrations` in `shared/schema/budget.ts`
 *      (damit `drizzle-kit push` sie kennt und NICHT zu altern/löschen versucht).
 *
 * Driftet eine ohne die andere, fängt `drizzle-kit push` wieder an, die Tabelle
 * zu altern/droppen (genau der Daten-Verlust-Footgun, den Task #919 geschlossen
 * hat) — und niemand merkt es bis zum nächsten Prod-Push.
 *
 * Strategie: Wir definieren EINEN erwarteten Vertrag (`EXPECTED`) und prüfen,
 * dass BEIDE Quellen ihn erfüllen:
 *   - Das rohe SQL wird aus den exportierten Konstanten in eine isolierte
 *     TEMP-Tabelle gespielt und via `information_schema` / `pg_indexes`
 *     introspiziert.
 *   - Das Drizzle-Modell wird via `getTableColumns` / `getTableConfig`
 *     introspiziert.
 * Driftet eine der beiden Quellen vom Vertrag (oder voneinander), schlägt der
 * Test fehl und zwingt zu einer bewussten, konsistenten Änderung.
 */
import { describe, it, expect } from "vitest";
import { sql, getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../../server/lib/db";
import { budgetMigrations } from "@shared/schema";
import {
  MIGRATION_LEDGER_TABLE,
  MIGRATION_LEDGER_NAME_INDEX,
  MIGRATION_LEDGER_CREATE_TABLE_SQL,
  MIGRATION_LEDGER_CREATE_INDEX_SQL,
} from "../../server/startup/ensure-migration-ledger";

type DefaultKind = "none" | "sequence" | "now" | "literal";

interface ExpectedColumn {
  name: string;
  /** information_schema.columns.data_type */
  dataType: string;
  nullable: boolean;
  defaultKind: DefaultKind;
  /** Nur bei defaultKind === "literal": normalisierter DB-Default. */
  literalDefault?: string;
}

/**
 * Der eine, menschenlesbare Vertrag. Wer ihn ändern will, MUSS rohes SQL UND
 * Drizzle-Modell konsistent mit-ändern — sonst bricht dieser Test.
 */
const EXPECTED_COLUMNS: ExpectedColumn[] = [
  { name: "id", dataType: "integer", nullable: false, defaultKind: "sequence" },
  { name: "name", dataType: "text", nullable: false, defaultKind: "none" },
  {
    name: "version",
    dataType: "text",
    nullable: false,
    defaultKind: "literal",
    literalDefault: "'1'::text",
  },
  { name: "summary", dataType: "text", nullable: true, defaultKind: "none" },
  {
    name: "applied_at",
    dataType: "timestamp with time zone",
    nullable: false,
    defaultKind: "now",
  },
];

const EXPECTED_UNIQUE_INDEX = {
  name: MIGRATION_LEDGER_NAME_INDEX,
  columns: ["name"],
};

function classifyDbDefault(raw: string | null): {
  kind: DefaultKind;
  literal?: string;
} {
  if (raw === null) return { kind: "none" };
  if (/^nextval\(/i.test(raw)) return { kind: "sequence" };
  if (/^now\(\)/i.test(raw)) return { kind: "now" };
  return { kind: "literal", literal: raw };
}

interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultKind: DefaultKind;
  literalDefault?: string;
}

function toComparable(col: IntrospectedColumn) {
  return {
    name: col.name,
    dataType: col.dataType,
    nullable: col.nullable,
    defaultKind: col.defaultKind,
    ...(col.defaultKind === "literal"
      ? { literalDefault: col.literalDefault }
      : {}),
  };
}

const expectedComparable = EXPECTED_COLUMNS.map(toComparable);

describe(`Migration-Ledger Schema-Drift (${MIGRATION_LEDGER_TABLE})`, () => {
  it("rohes SQL aus ensure-migration-ledger.ts erfüllt den erwarteten Vertrag", async () => {
    // Das exakte Prod-SQL (aus den exportierten Konstanten) in eine isolierte
    // TEMP-Tabelle spielen — innerhalb EINER Transaktion, damit alle Statements
    // dieselbe Connection (und damit dasselbe pg_temp-Schema) sehen. Die
    // TEMP-Tabelle verschwindet automatisch am Transaktionsende; die echte
    // `budget_migrations` wird nie angefasst.
    const probe = `bm_probe_${process.pid}_${Date.now()}`;

    const probeTableSql = MIGRATION_LEDGER_CREATE_TABLE_SQL.replace(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE}`,
      `CREATE TEMP TABLE ${probe}`,
    );
    const probeIndexSql = MIGRATION_LEDGER_CREATE_INDEX_SQL.replaceAll(
      MIGRATION_LEDGER_TABLE,
      probe,
    );

    // Sanity: die Transformationen haben gegriffen (kein verbliebener
    // Original-Name, sonst würde die echte Tabelle/Index getroffen).
    expect(probeTableSql).toContain(`CREATE TEMP TABLE ${probe}`);
    expect(probeTableSql).not.toContain(MIGRATION_LEDGER_TABLE);
    expect(probeIndexSql).not.toContain(MIGRATION_LEDGER_TABLE);

    let columns: IntrospectedColumn[] = [];
    let indexDefs: string[] = [];

    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(probeTableSql));
      await tx.execute(sql.raw(probeIndexSql));

      const colRes = await tx.execute(sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = ${probe}
        ORDER BY ordinal_position
      `);
      columns = (colRes.rows as Array<Record<string, unknown>>).map((r) => {
        const def = classifyDbDefault(
          (r.column_default as string | null) ?? null,
        );
        return {
          name: r.column_name as string,
          dataType: r.data_type as string,
          nullable: (r.is_nullable as string) === "YES",
          defaultKind: def.kind,
          literalDefault: def.literal,
        };
      });

      const idxRes = await tx.execute(sql`
        SELECT indexdef
        FROM pg_indexes
        WHERE tablename = ${probe}
      `);
      indexDefs = (idxRes.rows as Array<Record<string, unknown>>).map(
        (r) => r.indexdef as string,
      );
    });

    expect(columns.map(toComparable)).toEqual(expectedComparable);

    // Unique-Index auf (name) muss existieren (TEMP-Index trägt einen
    // probe-spezifischen Namen + pg_temp-Schema, daher per Definition prüfen).
    const uniqueOnName = indexDefs.find(
      (def) =>
        /UNIQUE INDEX/i.test(def) &&
        new RegExp(`\\(${EXPECTED_UNIQUE_INDEX.columns.join(", ")}\\)`).test(
          def,
        ),
    );
    expect(uniqueOnName).toBeDefined();
  });

  it("Drizzle-Modell budgetMigrations erfüllt denselben Vertrag", () => {
    const cols = Object.values(getTableColumns(budgetMigrations));

    const drizzleColumns: IntrospectedColumn[] = cols.map((col) => {
      const sqlType = col.getSQLType();
      // Drizzle `serial` ⇒ DB-Typ `integer` mit Sequence-Default.
      const isSerial = sqlType === "serial";
      const dataType = isSerial ? "integer" : sqlType;

      let defaultKind: DefaultKind = "none";
      let literalDefault: string | undefined;
      if (isSerial) {
        defaultKind = "sequence";
      } else if (col.hasDefault) {
        if (typeof col.default === "string") {
          // text-Default ⇒ DB normalisiert auf `'<wert>'::text`.
          defaultKind = "literal";
          literalDefault = `'${col.default}'::${sqlType}`;
        } else {
          // SQL-Default (z.B. now()).
          defaultKind = "now";
        }
      }

      return {
        name: col.name,
        dataType,
        nullable: !col.notNull,
        defaultKind,
        literalDefault,
      };
    });

    expect(drizzleColumns.map(toComparable)).toEqual(expectedComparable);

    // Unique-Index aus dem Drizzle-Modell.
    const { indexes } = getTableConfig(budgetMigrations);
    const drizzleUnique = indexes.map((idx) => ({
      name: idx.config.name,
      unique: idx.config.unique,
      columns: idx.config.columns.map((c) => (c as { name: string }).name),
    }));

    expect(drizzleUnique).toContainEqual({
      name: EXPECTED_UNIQUE_INDEX.name,
      unique: true,
      columns: EXPECTED_UNIQUE_INDEX.columns,
    });
  });
});
