/**
 * Task #922 — Globaler Drift-Wächter für ALLE rohen DDL-Migrationen in
 * `server/startup/**`.
 *
 * Geschwister-Test zu `migration-ledger-schema-drift.test.ts`: Während jener
 * EINE Tabelle (`budget_migrations`) gegen einen handgeschriebenen Vertrag
 * prüft, enumeriert dieser Test JEDE Tabelle/Spalte, die zur Laufzeit per rohem
 * SQL in `server/startup/**` angelegt oder geändert wird, und stellt sicher,
 * dass sie exakt zu ihrer Drizzle-Deklaration passt (Typ inkl. Precision/Scale,
 * Nullability, Default-Art, Array-ness). `budget_migrations` selbst ist hier
 * bewusst ausgeklammert — es hat seinen dedizierten Geschwister-Test.
 *
 * WARUM das wichtig ist: Die Startup-Migrationen umgehen `drizzle-kit push`
 * absichtlich (explizit, damit Drizzle die großen Bestandstabellen nicht per
 * Diff-Heuristik anfasst). Dadurch existiert jede Spalte an ZWEI Stellen, die
 * synchron bleiben MÜSSEN: im rohen SQL UND im Drizzle-Modell. Driftet eine
 * ohne die andere, fängt der nächste `drizzle-kit push` an, die Spalte zu
 * altern/droppen (Daten-Verlust-Footgun) — und niemand merkt es bis Prod.
 *
 * Strategie — Drizzle IST der Vertrag (kein zweiter, handgepflegter):
 *   1. CREATE-TABLE / ADD-COLUMN: Das exakte Prod-SQL (aus den exportierten
 *      Konstanten) wird in eine isolierte TEMP-Tabelle gespielt und via
 *      `information_schema` introspiziert; jede so erzeugte Spalte wird gegen
 *      die gleichnamige Drizzle-Spalte verglichen.
 *   2. ALTER-TYPE-Registries (km/geo, monthly_work_hours, line-item-types):
 *      reine Vergleichslogik — die exportierte Ziel-Typ-Registry wird gegen das
 *      Drizzle-Modell geprüft (kein SQL-Exec nötig).
 *   3. DROP-Spalten-Registries: Die gedroppte Spalte MUSS aus dem Drizzle-Modell
 *      verschwunden sein (sonst legt `push` sie an, die Migration droppt sie
 *      beim nächsten Boot — Flapping).
 */
import { describe, it, expect } from "vitest";
import { sql, getTableColumns } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../server/lib/db";
import {
  appointments,
  budgetTransactions,
  customers,
  customerBudgetPreferences,
  customerBudgetRecipients,
  customerCreationIdempotencyKeys,
  companySettings,
  importBatches,
  invoices,
  invoiceLineItems,
  auditLog,
  employeeTimeEntries,
  users,
} from "@shared/schema";

// --- CREATE / ADD COLUMN raw-SQL sources -----------------------------------
import {
  IMPORT_BATCHES_CREATE_TABLE_SQL,
  APPOINTMENTS_IMPORT_BATCH_ID_COLUMN_SQL,
  BUDGET_TRANSACTIONS_IMPORT_BATCH_ID_COLUMN_SQL,
} from "../../server/startup/ensure-import-batch";
import {
  INVOICES_PER_POT_COLUMNS_SQL,
  CUSTOMER_BUDGET_RECIPIENTS_CREATE_TABLE_SQL,
} from "../../server/startup/ensure-invoice-per-pot-columns";
import {
  CUSTOMERS_SETUP_COLUMNS_SQL,
  CUSTOMER_IDEMPOTENCY_CREATE_TABLE_SQL,
} from "../../server/startup/ensure-customer-idempotency-schema";
import { AUDIT_PARENT_DELETION_COLUMN_SQL } from "../../server/startup/ensure-audit-parent-deletion";
import { BUDGET_START_DATE_ORIGIN_COLUMN_SQL } from "../../server/startup/ensure-budget-start-date-origin";
import { COMPANY_BANK_ACCOUNT_HOLDER_COLUMN_SQL } from "../../server/startup/ensure-company-bank-account-holder";
import { INVOICE_FINGERPRINT_COLUMNS_SQL } from "../../server/startup/ensure-invoice-fingerprint-columns";
import { INVOICE_LEISTUNGSNACHWEIS_COLUMNS_SQL } from "../../server/startup/ensure-invoice-leistungsnachweis-columns";
import { INVOICE_LINE_ITEM_QUANTITY_COLUMNS_SQL } from "../../server/startup/ensure-invoice-line-item-quantity-columns";
import { INVOICE_RENDER_SNAPSHOT_COLUMN_SQL } from "../../server/startup/ensure-invoice-render-snapshot";
import { INVOICE_STORNO_REFS_COLUMN_SQL } from "../../server/startup/migrate-invoice-storno-refs";
import { INVOICE_ZUGFERD_XML_COLUMN_SQL } from "../../server/startup/migrate-invoice-zugferd-xml";

// --- ALTER-TYPE registries -------------------------------------------------
import {
  KM_GEO_COLUMNS,
  KM_NUMERIC_PRECISION,
  KM_NUMERIC_SCALE,
  GEO_NUMERIC_PRECISION,
  GEO_NUMERIC_SCALE,
} from "../../server/startup/migrate-km-geo-to-numeric";
import { MONTHLY_WORK_HOURS_TARGET } from "../../server/startup/migrate-monthly-work-hours-to-numeric";
import { FIX_COLUMN_TYPE_TARGETS } from "../../server/startup/fix-invoice-line-item-types";

// --- DROP registries -------------------------------------------------------
import { DROPPED_APPOINTMENTS_SERVICE_TYPE } from "../../server/startup/drop-appointments-service-type";
import { DROPPED_AUA_APPROVAL_COLUMNS } from "../../server/startup/drop-aua-approval-columns";

// ===========================================================================
// Drizzle-Tabellen-Registry: DB-Tabellenname → Drizzle-Modell.
// ===========================================================================
const DRIZZLE_TABLES: Record<string, PgTable> = {
  appointments,
  budget_transactions: budgetTransactions,
  customers,
  customer_budget_preferences: customerBudgetPreferences,
  customer_budget_recipients: customerBudgetRecipients,
  customer_creation_idempotency_keys: customerCreationIdempotencyKeys,
  company_settings: companySettings,
  import_batches: importBatches,
  invoices,
  invoice_line_items: invoiceLineItems,
  audit_log: auditLog,
  employee_time_entries: employeeTimeEntries,
  users,
};

function drizzleColumnsByDbName(table: PgTable): Map<string, PgColumn> {
  const map = new Map<string, PgColumn>();
  for (const col of Object.values(getTableColumns(table)) as PgColumn[]) {
    map.set(col.name, col);
  }
  return map;
}

// ===========================================================================
// Kanonische Typ-/Default-Normalisierung (beide Seiten auf EINE Form bringen).
// ===========================================================================
type DefaultKind =
  | "none"
  | "sequence"
  | "now"
  | `bool:${string}`
  | `num:${string}`
  | `text:${string}`
  | `other:${string}`;

interface Canon {
  type: string;
  nullable: boolean;
  defaultKind: DefaultKind;
}

/** ARRAY-udt (`_int4`) → Basistyp (`integer`). */
function udtArrayToBase(udt: string): string {
  const map: Record<string, string> = {
    _int4: "integer",
    _int8: "bigint",
    _text: "text",
    _numeric: "numeric",
    _bool: "boolean",
  };
  return map[udt] ?? udt.replace(/^_/, "");
}

function normalizeBaseType(dataType: string): string {
  switch (dataType) {
    case "timestamp with time zone":
      return "timestamptz";
    case "timestamp without time zone":
      return "timestamp";
    case "time without time zone":
      return "time";
    case "time with time zone":
      return "timetz";
    default:
      return dataType;
  }
}

/** information_schema.columns-Zeile → kanonischer Typ. */
function canonProbeType(r: {
  data_type: string;
  udt_name: string | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string {
  if (r.data_type === "ARRAY") {
    return `${udtArrayToBase(r.udt_name ?? "")}[]`;
  }
  if (r.data_type === "numeric" && r.numeric_precision != null) {
    return `numeric(${r.numeric_precision},${r.numeric_scale ?? 0})`;
  }
  return normalizeBaseType(r.data_type);
}

function classifyProbeDefault(raw: string | null): DefaultKind {
  if (raw === null) return "none";
  if (/^nextval\(/i.test(raw)) return "sequence";
  if (/^now\(\)/i.test(raw)) return "now";
  const boolMatch = raw.match(/^(true|false)\b/i);
  if (boolMatch) return `bool:${boolMatch[1].toLowerCase()}`;
  const numMatch = raw.match(/^(-?\d+(?:\.\d+)?)(?:::)?/);
  if (numMatch && /^-?\d+(?:\.\d+)?$/.test(numMatch[1])) {
    return `num:${Number(numMatch[1])}`;
  }
  const textMatch = raw.match(/^'(.*)'::/);
  if (textMatch) return `text:${textMatch[1]}`;
  return `other:${raw}`;
}

/** Drizzle-Spalte (`getSQLType` + Metadaten) → kanonischer Typ. */
function canonDrizzleType(col: PgColumn): string {
  let t = col.getSQLType();
  if (t === "serial" || t === "bigserial") {
    return t === "serial" ? "integer" : "bigint";
  }
  // numeric(10, 3) → numeric(10,3)
  t = t.replace(/^numeric\((\d+),\s*(\d+)\)$/, "numeric($1,$2)");
  // Array: getSQLType liefert bereits "integer[]" o.Ä.
  if (t === "timestamp with time zone") return "timestamptz";
  if (t === "timestamp without time zone" || t === "timestamp") return "timestamp";
  if (t === "time without time zone") return "time";
  return t;
}

function classifyDrizzleDefault(col: PgColumn): DefaultKind {
  const sqlType = col.getSQLType();
  if (sqlType === "serial" || sqlType === "bigserial") return "sequence";
  if (!col.hasDefault) return "none";
  const d = col.default;
  if (typeof d === "boolean") return `bool:${d}`;
  if (typeof d === "number") return `num:${d}`;
  if (typeof d === "string") return `text:${d}`;
  // SQL-Default (z.B. defaultNow()).
  return "now";
}

function canonDrizzle(col: PgColumn): Canon {
  return {
    type: canonDrizzleType(col),
    nullable: !col.notNull,
    defaultKind: classifyDrizzleDefault(col),
  };
}

// ===========================================================================
// Probe-Helfer: rohes DDL in eine isolierte TEMP-Tabelle spielen + auslesen.
// ===========================================================================
interface ProbeColumn {
  name: string;
  canon: Canon;
}

/** Entfernt `REFERENCES <tbl>(<col>)`, damit die TEMP-Tabelle ohne FK lebt. */
function stripReferences(ddl: string): string {
  return ddl.replace(/\s+REFERENCES\s+"?\w+"?\s*\(\s*\w+\s*\)/gi, "");
}

async function introspectProbe(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  probe: string,
): Promise<ProbeColumn[]> {
  const res = await tx.execute(sql`
    SELECT column_name, data_type, udt_name, numeric_precision,
           numeric_scale, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = ${probe}
    ORDER BY ordinal_position
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    name: r.column_name as string,
    canon: {
      type: canonProbeType({
        data_type: r.data_type as string,
        udt_name: (r.udt_name as string | null) ?? null,
        numeric_precision: (r.numeric_precision as number | null) ?? null,
        numeric_scale: (r.numeric_scale as number | null) ?? null,
      }),
      nullable: (r.is_nullable as string) === "YES",
      defaultKind: classifyProbeDefault(
        (r.column_default as string | null) ?? null,
      ),
    },
  }));
}

let probeCounter = 0;
function nextProbeName(): string {
  probeCounter += 1;
  return `dft_probe_${process.pid}_${Date.now()}_${probeCounter}`;
}

interface CreateSource {
  label: string;
  rawSql: string;
  realTable: string;
  drizzleTable: PgTable;
  /** Auch prüfen, dass das Drizzle-Modell KEINE zusätzlichen Spalten hat. */
  fullParity: boolean;
  /** Spalten, die der Probe-Vergleich überspringt (z.B. Zwischen-Typen). */
  skipColumns?: string[];
}

interface AlterSource {
  label: string;
  rawSql: string;
  realTable: string;
  drizzleTable: PgTable;
  /** Spalten, die das ALTER hinzufügt und geprüft werden sollen. */
  columns: string[];
}

const CREATE_SOURCES: CreateSource[] = [
  {
    label: "ensure-import-batch: import_batches",
    rawSql: IMPORT_BATCHES_CREATE_TABLE_SQL,
    realTable: "import_batches",
    drizzleTable: importBatches,
    fullParity: true,
  },
  {
    label: "ensure-invoice-per-pot-columns: customer_budget_recipients",
    rawSql: CUSTOMER_BUDGET_RECIPIENTS_CREATE_TABLE_SQL,
    realTable: "customer_budget_recipients",
    drizzleTable: customerBudgetRecipients,
    fullParity: true,
  },
  {
    label: "ensure-customer-idempotency-schema: customer_creation_idempotency_keys",
    rawSql: CUSTOMER_IDEMPOTENCY_CREATE_TABLE_SQL,
    realTable: "customer_creation_idempotency_keys",
    drizzleTable: customerCreationIdempotencyKeys,
    fullParity: true,
  },
];

const ALTER_SOURCES: AlterSource[] = [
  {
    label: "ensure-import-batch: appointments.import_batch_id",
    rawSql: APPOINTMENTS_IMPORT_BATCH_ID_COLUMN_SQL,
    realTable: "appointments",
    drizzleTable: appointments,
    columns: ["import_batch_id"],
  },
  {
    label: "ensure-import-batch: budget_transactions.import_batch_id",
    rawSql: BUDGET_TRANSACTIONS_IMPORT_BATCH_ID_COLUMN_SQL,
    realTable: "budget_transactions",
    drizzleTable: budgetTransactions,
    columns: ["import_batch_id"],
  },
  {
    label: "ensure-invoice-per-pot-columns: invoices.budget_type/billing_run_id",
    rawSql: INVOICES_PER_POT_COLUMNS_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["budget_type", "billing_run_id"],
  },
  {
    label: "ensure-customer-idempotency-schema: customers.setup_*",
    rawSql: CUSTOMERS_SETUP_COLUMNS_SQL,
    realTable: "customers",
    drizzleTable: customers,
    columns: [
      "setup_signatures_pending",
      "setup_documents_pending",
      "setup_budgets_pending",
      "setup_delivery_pending",
      "setup_pending_payloads",
    ],
  },
  {
    label: "ensure-audit-parent-deletion: audit_log.parent_deletion_id",
    rawSql: AUDIT_PARENT_DELETION_COLUMN_SQL,
    realTable: "audit_log",
    drizzleTable: auditLog,
    columns: ["parent_deletion_id"],
  },
  {
    label: "ensure-budget-start-date-origin: customer_budget_preferences.budget_start_date_origin",
    rawSql: BUDGET_START_DATE_ORIGIN_COLUMN_SQL,
    realTable: "customer_budget_preferences",
    drizzleTable: customerBudgetPreferences,
    columns: ["budget_start_date_origin"],
  },
  {
    label: "ensure-company-bank-account-holder: company_settings.bank_account_holder",
    rawSql: COMPANY_BANK_ACCOUNT_HOLDER_COLUMN_SQL,
    realTable: "company_settings",
    drizzleTable: companySettings,
    columns: ["bank_account_holder"],
  },
  {
    label: "ensure-invoice-fingerprint-columns: invoices.*_fingerprint",
    rawSql: INVOICE_FINGERPRINT_COLUMNS_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["pdf_data_fingerprint", "leistungsnachweis_data_fingerprint"],
  },
  {
    label: "ensure-invoice-leistungsnachweis-columns: invoices.leistungsnachweis_*",
    rawSql: INVOICE_LEISTUNGSNACHWEIS_COLUMNS_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["leistungsnachweis_path", "leistungsnachweis_hash"],
  },
  {
    // `quantity_raw` wird als `real` angelegt und DANACH von migrate-km-geo auf
    // numeric(10,3) gehoben → hier überspringen, im ALTER-TYPE-Block geprüft.
    label: "ensure-invoice-line-item-quantity-columns: invoice_line_items.quantity_unit",
    rawSql: INVOICE_LINE_ITEM_QUANTITY_COLUMNS_SQL,
    realTable: "invoice_line_items",
    drizzleTable: invoiceLineItems,
    columns: ["quantity_unit"],
  },
  {
    label: "ensure-invoice-render-snapshot: invoices.render_snapshot",
    rawSql: INVOICE_RENDER_SNAPSHOT_COLUMN_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["render_snapshot"],
  },
  {
    label: "migrate-invoice-storno-refs: invoices.referenced_storno_invoice_ids",
    rawSql: INVOICE_STORNO_REFS_COLUMN_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["referenced_storno_invoice_ids"],
  },
  {
    label: "migrate-invoice-zugferd-xml: invoices.zugferd_xml",
    rawSql: INVOICE_ZUGFERD_XML_COLUMN_SQL,
    realTable: "invoices",
    drizzleTable: invoices,
    columns: ["zugferd_xml"],
  },
];

describe("Startup Schema-Drift (server/startup/**)", () => {
  describe("CREATE TABLE — rohes SQL == Drizzle-Modell", () => {
    for (const src of CREATE_SOURCES) {
      it(src.label, async () => {
        const probe = nextProbeName();
        const probeSql = stripReferences(
          src.rawSql.replace(
            new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${src.realTable}`, "i"),
            `CREATE TEMP TABLE ${probe}`,
          ),
        );
        // Sanity: Transformation hat gegriffen (Original-Name nicht mehr drin).
        expect(probeSql).toContain(`CREATE TEMP TABLE ${probe}`);

        let probeCols: ProbeColumn[] = [];
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(probeSql));
          probeCols = await introspectProbe(tx, probe);
        });

        const drizzleCols = drizzleColumnsByDbName(src.drizzleTable);
        for (const pc of probeCols) {
          if (src.skipColumns?.includes(pc.name)) continue;
          const dz = drizzleCols.get(pc.name);
          expect(dz, `Drizzle-Spalte fehlt: ${src.realTable}.${pc.name}`).toBeDefined();
          expect(
            pc.canon,
            `Drift bei ${src.realTable}.${pc.name}`,
          ).toEqual(canonDrizzle(dz!));
        }

        if (src.fullParity) {
          const probeNames = new Set(probeCols.map((c) => c.name));
          for (const dbName of drizzleCols.keys()) {
            expect(
              probeNames.has(dbName),
              `Drizzle hat Spalte ${src.realTable}.${dbName}, die das rohe CREATE-SQL nicht anlegt`,
            ).toBe(true);
          }
        }
      });
    }
  });

  describe("ADD COLUMN — rohes SQL == Drizzle-Modell", () => {
    for (const src of ALTER_SOURCES) {
      it(src.label, async () => {
        const probe = nextProbeName();
        const probeSql = stripReferences(
          src.rawSql.replace(
            new RegExp(`ALTER TABLE\\s+${src.realTable}\\b`, "i"),
            `ALTER TABLE ${probe}`,
          ),
        );
        expect(probeSql).toContain(`ALTER TABLE ${probe}`);

        let probeCols: ProbeColumn[] = [];
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`CREATE TEMP TABLE ${probe} (id integer)`));
          await tx.execute(sql.raw(probeSql));
          probeCols = await introspectProbe(tx, probe);
        });

        const byName = new Map(probeCols.map((c) => [c.name, c]));
        const drizzleCols = drizzleColumnsByDbName(src.drizzleTable);

        for (const colName of src.columns) {
          const pc = byName.get(colName);
          expect(pc, `Probe-Spalte fehlt: ${colName}`).toBeDefined();
          const dz = drizzleCols.get(colName);
          expect(
            dz,
            `Drizzle-Spalte fehlt: ${src.realTable}.${colName}`,
          ).toBeDefined();
          expect(
            pc!.canon,
            `Drift bei ${src.realTable}.${colName}`,
          ).toEqual(canonDrizzle(dz!));
        }
      });
    }
  });

  describe("ALTER TYPE — Ziel-Typ-Registry == Drizzle-Modell", () => {
    it("migrate-km-geo-to-numeric: jede km/geo-Spalte ist numeric mit der Ziel-Precision/Scale", () => {
      for (const spec of KM_GEO_COLUMNS) {
        const table = DRIZZLE_TABLES[spec.table];
        expect(table, `Unbekannte Tabelle: ${spec.table}`).toBeDefined();
        const col = drizzleColumnsByDbName(table).get(spec.column);
        expect(
          col,
          `Drizzle-Spalte fehlt: ${spec.table}.${spec.column}`,
        ).toBeDefined();
        const expected =
          spec.type === "km"
            ? `numeric(${KM_NUMERIC_PRECISION},${KM_NUMERIC_SCALE})`
            : `numeric(${GEO_NUMERIC_PRECISION},${GEO_NUMERIC_SCALE})`;
        expect(
          canonDrizzleType(col!),
          `${spec.table}.${spec.column} muss ${expected} sein`,
        ).toBe(expected);
      }
    });

    it("migrate-monthly-work-hours-to-numeric: users.monthly_work_hours ist numeric(6,2)", () => {
      const table = DRIZZLE_TABLES[MONTHLY_WORK_HOURS_TARGET.table];
      const col = drizzleColumnsByDbName(table).get(
        MONTHLY_WORK_HOURS_TARGET.column,
      );
      expect(col).toBeDefined();
      expect(canonDrizzleType(col!)).toBe(
        `numeric(${MONTHLY_WORK_HOURS_TARGET.precision},${MONTHLY_WORK_HOURS_TARGET.scale})`,
      );
    });

    it("fix-invoice-line-item-types: konvertierte Spalten haben den Ziel-Typ", () => {
      for (const target of FIX_COLUMN_TYPE_TARGETS) {
        const table = DRIZZLE_TABLES[target.table];
        expect(table, `Unbekannte Tabelle: ${target.table}`).toBeDefined();
        const col = drizzleColumnsByDbName(table).get(target.column);
        expect(
          col,
          `Drizzle-Spalte fehlt: ${target.table}.${target.column}`,
        ).toBeDefined();
        expect(
          canonDrizzleType(col!),
          `${target.table}.${target.column} muss ${target.targetType} sein`,
        ).toBe(target.targetType);
      }
    });
  });

  describe("DROP COLUMN — gedroppte Spalten sind aus dem Drizzle-Modell entfernt", () => {
    it("drop-appointments-service-type: appointments.service_type ist weg", () => {
      const table = DRIZZLE_TABLES[DROPPED_APPOINTMENTS_SERVICE_TYPE.table];
      const cols = drizzleColumnsByDbName(table);
      expect(cols.has(DROPPED_APPOINTMENTS_SERVICE_TYPE.column)).toBe(false);
    });

    it("drop-aua-approval-columns: customers.aua_approval_* sind weg", () => {
      const table = DRIZZLE_TABLES[DROPPED_AUA_APPROVAL_COLUMNS.table];
      const cols = drizzleColumnsByDbName(table);
      for (const col of DROPPED_AUA_APPROVAL_COLUMNS.columns) {
        expect(cols.has(col), `customers.${col} darf nicht im Modell sein`).toBe(
          false,
        );
      }
    });
  });
});
