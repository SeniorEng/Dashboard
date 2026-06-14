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
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { sql, getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../server/lib/db";
import {
  appointments,
  budgetAllocations,
  budgetReservations,
  budgetTransactions,
  customers,
  customerBudgetPreferences,
  customerBudgetRecipients,
  customerBudgetTypeSettings,
  customerCreationIdempotencyKeys,
  companySettings,
  importBatches,
  invoices,
  invoiceLineItems,
  auditLog,
  employeeTimeEntries,
  qontoTransactions,
  users,
} from "@shared/schema";

// --- CREATE / ADD COLUMN raw-SQL sources -----------------------------------
import {
  IMPORT_BATCHES_CREATE_TABLE_SQL,
  APPOINTMENTS_IMPORT_BATCH_ID_COLUMN_SQL,
  BUDGET_TRANSACTIONS_IMPORT_BATCH_ID_COLUMN_SQL,
  IMPORT_BATCHES_FILE_HASH_INDEX_SQL,
} from "../../server/startup/ensure-import-batch";
import {
  INVOICES_PER_POT_COLUMNS_SQL,
  CUSTOMER_BUDGET_RECIPIENTS_CREATE_TABLE_SQL,
  INVOICES_BILLING_RUN_INDEX_SQL,
  CUSTOMER_BUDGET_RECIPIENTS_INDEX_SQL,
} from "../../server/startup/ensure-invoice-per-pot-columns";
import {
  CUSTOMERS_SETUP_COLUMNS_SQL,
  CUSTOMER_IDEMPOTENCY_CREATE_TABLE_SQL,
  CUSTOMER_IDEMPOTENCY_UNIQUE_INDEX_SQL,
  CUSTOMER_IDEMPOTENCY_EXPIRES_INDEX_SQL,
} from "../../server/startup/ensure-customer-idempotency-schema";
import {
  AUDIT_PARENT_DELETION_COLUMN_SQL,
  AUDIT_PARENT_DELETION_INDEX_SQL,
} from "../../server/startup/ensure-audit-parent-deletion";
import { QONTO_MATCH_UNIQUE_INDEX_SQL } from "../../server/startup/ensure-qonto-match-idempotency";
import { RESERVATION_CAPTURED_TX_INDEX_SQL } from "../../server/startup/ensure-reservation-captured-transaction-link";
import {
  CBTS_UNIQUE_INDEX_SQL,
  BUDGET_ALLOCATIONS_AUTO_UNIQUE_INDEX_SQL,
} from "../../server/startup/backfill-budget-historization";
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
import { RECONCILE_COLUMN_TYPE_TARGETS } from "../../server/startup/reconcile-drifted-column-types";

// --- DROP registries -------------------------------------------------------
import { DROPPED_APPOINTMENTS_SERVICE_TYPE } from "../../server/startup/drop-appointments-service-type";
import { DROPPED_AUA_APPROVAL_COLUMNS } from "../../server/startup/drop-aua-approval-columns";

// --- CHECK-constraint raw-SQL sources --------------------------------------
import {
  BUDGET_TX_APPOINTMENT_CHECK_NAME,
  BUDGET_TX_APPOINTMENT_CHECK_SQL,
} from "../../server/startup/ensure-budget-tx-appointment-constraint";
import {
  APPOINTMENTS_PROSPECT_OR_CUSTOMER_CHECK_NAME,
  APPOINTMENTS_PROSPECT_OR_CUSTOMER_CHECK_SQL,
} from "../../server/startup/migrate-erstberatung-customers";

// --- Trigger specs (SSoT) --------------------------------------------------
import {
  type StartupTriggerSpec,
  type TriggerEvent,
  renderCreateTriggerSql,
} from "../../server/startup/trigger-spec";
import { AUDIT_LOG_TRIGGERS } from "../../server/startup/ensure-audit-log-immutable";
import { BUDGET_TRANSACTIONS_TRIGGERS } from "../../server/startup/ensure-budget-transactions-immutability";
import { GOBD_TABLE_TRIGGERS } from "../../server/startup/ensure-gobd-table-immutability";

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

    it("reconcile-drifted-column-types: versöhnte Spalten == Drizzle-Soll-Typ", () => {
      for (const target of RECONCILE_COLUMN_TYPE_TARGETS) {
        const table = DRIZZLE_TABLES[target.table];
        expect(table, `Unbekannte Tabelle: ${target.table}`).toBeDefined();
        const col = drizzleColumnsByDbName(table).get(target.column);
        expect(
          col,
          `Drizzle-Spalte fehlt: ${target.table}.${target.column}`,
        ).toBeDefined();
        // Soll-Typ (targetType) muss exakt der Drizzle-Deklaration entsprechen,
        // sonst würde das Reconcile die Spalte in einen Typ versöhnen, den der
        // nächste `drizzle-kit push` sofort wieder altern würde.
        expect(
          canonDrizzleType(col!),
          `${target.table}.${target.column} muss ${target.targetType} sein`,
        ).toBe(target.targetType);
        // expectedDataType (information_schema-Form) und targetType (kanonisch)
        // müssen denselben Typ beschreiben, sonst greift der Idempotenz-Guard fehl.
        expect(
          normalizeBaseType(target.expectedDataType),
          `${target.table}.${target.column}: expectedDataType passt nicht zu targetType`,
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

// ===========================================================================
// Task #923 — INDEX / UNIQUE-CONSTRAINT-Drift.
//
// Der Spalten-Drift-Wächter oben prüft Typ/Nullability/Default, NICHT aber die
// Indexe/Unique-Constraints, die die Startup-Migrationen per rohem SQL anlegen.
// Ein Index, der nur im rohen SQL existiert (oder dort ANDERS definiert ist als
// im Drizzle-Modell), lässt `drizzle-kit push` ihn anlegen/droppen bzw. Dev und
// Prod auseinanderlaufen — derselbe Footgun, den #922 für Spalten geschlossen
// hat.
//
// Strategie (pro Startup-Index): Wir spielen BEIDE Definitionen — das rohe
// Startup-SQL UND die aus dem Drizzle-Modell (`getTableConfig().indexes`)
// gerenderte — gegen DIESELBE TEMP-Tabelle und vergleichen die von PostgreSQL
// normalisierten `pg_get_indexdef`-Ausgaben (nur der Indexname wird ausmaskiert).
// So werden Spaltenliste/-reihenfolge, UNIQUE-ness UND der WHERE-Prädikat
// (partielle Indexe) identisch normalisiert verglichen. `budget_migrations` ist
// bewusst ausgeklammert — sein Index hat den dedizierten Geschwister-Test
// `migration-ledger-schema-drift.test.ts`.
// ===========================================================================

const dialect = new PgDialect();

interface IndexSource {
  label: string;
  /** Rohes Startup-SQL (exportierte SSoT-Konstante). */
  rawSql: string;
  /** Index-Name, wie ihn beide Quellen tragen MÜSSEN. */
  indexName: string;
  realTable: string;
  drizzleTable: PgTable;
  /** DDL der TEMP-Tabelle: indizierte + im WHERE referenzierte Spalten. */
  tempColumns: string;
}

const INDEX_SOURCES: IndexSource[] = [
  {
    label: "ensure-import-batch: import_batches_file_hash_idx",
    rawSql: IMPORT_BATCHES_FILE_HASH_INDEX_SQL,
    indexName: "import_batches_file_hash_idx",
    realTable: "import_batches",
    drizzleTable: importBatches,
    tempColumns: "file_hash text",
  },
  {
    label: "ensure-invoice-per-pot-columns: invoices_billing_run_id_idx",
    rawSql: INVOICES_BILLING_RUN_INDEX_SQL,
    indexName: "invoices_billing_run_id_idx",
    realTable: "invoices",
    drizzleTable: invoices,
    tempColumns: "billing_run_id text",
  },
  {
    label:
      "ensure-invoice-per-pot-columns: customer_budget_recipients_customer_idx",
    rawSql: CUSTOMER_BUDGET_RECIPIENTS_INDEX_SQL,
    indexName: "customer_budget_recipients_customer_idx",
    realTable: "customer_budget_recipients",
    drizzleTable: customerBudgetRecipients,
    tempColumns: "customer_id integer, budget_type text",
  },
  {
    label: "ensure-customer-idempotency-schema: customer_idem_key_unique",
    rawSql: CUSTOMER_IDEMPOTENCY_UNIQUE_INDEX_SQL,
    indexName: "customer_idem_key_unique",
    realTable: "customer_creation_idempotency_keys",
    drizzleTable: customerCreationIdempotencyKeys,
    tempColumns: "idempotency_key text",
  },
  {
    label: "ensure-customer-idempotency-schema: customer_idem_key_expires_idx",
    rawSql: CUSTOMER_IDEMPOTENCY_EXPIRES_INDEX_SQL,
    indexName: "customer_idem_key_expires_idx",
    realTable: "customer_creation_idempotency_keys",
    drizzleTable: customerCreationIdempotencyKeys,
    tempColumns: "expires_at timestamptz",
  },
  {
    label: "ensure-audit-parent-deletion: audit_log_parent_deletion_idx",
    rawSql: AUDIT_PARENT_DELETION_INDEX_SQL,
    indexName: "audit_log_parent_deletion_idx",
    realTable: "audit_log",
    drizzleTable: auditLog,
    tempColumns: "parent_deletion_id integer",
  },
  {
    label:
      "ensure-qonto-match-idempotency: qonto_transactions_matched_invoice_unique_idx",
    rawSql: QONTO_MATCH_UNIQUE_INDEX_SQL,
    indexName: "qonto_transactions_matched_invoice_unique_idx",
    realTable: "qonto_transactions",
    drizzleTable: qontoTransactions,
    tempColumns: "matched_invoice_id integer",
  },
  {
    label:
      "ensure-reservation-captured-transaction-link: budget_reservations_captured_transaction_idx",
    rawSql: RESERVATION_CAPTURED_TX_INDEX_SQL,
    indexName: "budget_reservations_captured_transaction_idx",
    realTable: "budget_reservations",
    drizzleTable: budgetReservations,
    tempColumns: "captured_transaction_id integer",
  },
  {
    label:
      "backfill-budget-historization: customer_budget_type_settings_unique_idx",
    rawSql: CBTS_UNIQUE_INDEX_SQL,
    indexName: "customer_budget_type_settings_unique_idx",
    realTable: "customer_budget_type_settings",
    drizzleTable: customerBudgetTypeSettings,
    tempColumns: "customer_id integer, budget_type text, valid_to date",
  },
  {
    label: "backfill-budget-historization: budget_allocations_auto_unique_idx",
    rawSql: BUDGET_ALLOCATIONS_AUTO_UNIQUE_INDEX_SQL,
    indexName: "budget_allocations_auto_unique_idx",
    realTable: "budget_allocations",
    drizzleTable: budgetAllocations,
    tempColumns:
      "customer_id integer, budget_type text, year integer, month integer, source text, deleted_at timestamptz",
  },
];

/** Indexe, die woanders abgesichert sind und vom Coverage-Scan ignoriert werden. */
const INDEX_COVERAGE_ALLOWLIST = new Set<string>([
  // budget_migrations: dedizierter Geschwister-Test (migration-ledger-...).
  "budget_migrations_name_key",
]);

/** Rohes CREATE-INDEX-SQL auf eine isolierte TEMP-Tabelle + frischen Namen umbiegen. */
function rewriteRawIndexSql(
  rawSql: string,
  realTable: string,
  probe: string,
  probeIndexName: string,
): string {
  let s = rawSql.trim();
  s = s.replace(
    /(CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?)\S+/i,
    `$1${probeIndexName}`,
  );
  s = s.replace(new RegExp(`\\bON\\s+"?${realTable}"?`, "i"), `ON ${probe}`);
  return s;
}

/** Aus dem Drizzle-Index-Config ein CREATE-INDEX-SQL für die TEMP-Tabelle bauen. */
function buildDrizzleIndexSql(
  table: PgTable,
  indexName: string,
  probe: string,
  probeIndexName: string,
): string {
  const { indexes } = getTableConfig(table);
  const idx = indexes.find((i) => i.config.name === indexName);
  if (!idx) {
    throw new Error(
      `Drizzle-Modell hat keinen Index namens "${indexName}" — rohes Startup-SQL legt ihn aber an (push würde ihn droppen).`,
    );
  }
  const cfg = idx.config;
  const unique = cfg.unique ? "UNIQUE " : "";
  const cols = (cfg.columns as Array<{ name: string }>)
    .map((c) => c.name)
    .join(", ");
  const where = cfg.where
    ? ` WHERE ${dialect.sqlToQuery(cfg.where).sql}`
    : "";
  return `CREATE ${unique}INDEX ${probeIndexName} ON ${probe} (${cols})${where}`;
}

/** Indexname aus dem `pg_get_indexdef`-String ausmaskieren, damit nur die Definition bleibt. */
function maskIndexName(indexDef: string, indexName: string): string {
  return indexDef.replace(indexName, "IDX");
}

describe("Startup Index-Drift (server/startup/**)", () => {
  describe("INDEX / UNIQUE — rohes SQL == Drizzle-Modell", () => {
    for (const src of INDEX_SOURCES) {
      it(src.label, async () => {
        const probe = nextProbeName();
        const rawIdxName = `${probe}_raw`;
        const dzIdxName = `${probe}_dz`;

        const rawIndexSql = rewriteRawIndexSql(
          src.rawSql,
          src.realTable,
          probe,
          rawIdxName,
        );
        // Sanity: Transformation hat gegriffen (echter Tabellenname nicht mehr
        // als CREATE-INDEX-Ziel, frischer Indexname gesetzt).
        expect(rawIndexSql).toContain(`ON ${probe}`);
        expect(rawIndexSql).toContain(rawIdxName);
        expect(rawIndexSql).not.toMatch(
          new RegExp(`\\bON\\s+"?${src.realTable}"?[\\s(]`, "i"),
        );

        // buildDrizzleIndexSql wirft, wenn der Index im Modell fehlt → klare Drift-Meldung.
        const dzIndexSql = buildDrizzleIndexSql(
          src.drizzleTable,
          src.indexName,
          probe,
          dzIdxName,
        );

        let rawDef = "";
        let dzDef = "";
        await db.transaction(async (tx) => {
          await tx.execute(
            sql.raw(`CREATE TEMP TABLE ${probe} (${src.tempColumns})`),
          );
          await tx.execute(sql.raw(rawIndexSql));
          await tx.execute(sql.raw(dzIndexSql));

          const res = await tx.execute(sql`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename = ${probe}
            ORDER BY indexname
          `);
          for (const r of res.rows as Array<Record<string, unknown>>) {
            const name = r.indexname as string;
            const def = r.indexdef as string;
            if (name === rawIdxName) rawDef = maskIndexName(def, rawIdxName);
            if (name === dzIdxName) dzDef = maskIndexName(def, dzIdxName);
          }
        });

        expect(rawDef, `rohes Index-SQL erzeugte keinen Index: ${src.label}`).not.toBe(
          "",
        );
        expect(
          dzDef,
          `Drizzle-Index-SQL erzeugte keinen Index: ${src.label}`,
        ).not.toBe("");
        expect(
          rawDef,
          `Index-Drift bei ${src.indexName}: rohes Startup-SQL ≠ Drizzle-Modell`,
        ).toEqual(dzDef);
      });
    }
  });

  it("jeder CREATE-INDEX in server/startup/** ist vom Drift-Wächter abgedeckt", () => {
    const covered = new Set(INDEX_SOURCES.map((s) => s.indexName));
    const startupDir = join(process.cwd(), "server", "startup");

    const found = new Map<string, string>(); // indexName -> Datei
    for (const entry of readdirSync(startupDir)) {
      if (!entry.endsWith(".ts")) continue;
      const full = join(startupDir, entry);
      if (!statSync(full).isFile()) continue;
      // JS-Kommentare entfernen, damit erläuternde Prosa (z.B. ein im Fließtext
      // zitiertes `CREATE UNIQUE INDEX IF NOT EXISTS …`) keine Phantom-Treffer
      // erzeugt — nur echte DDL in Template-Strings soll zählen.
      const sourceText = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const re =
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sourceText)) !== null) {
        found.set(m[1], entry);
      }
    }

    const uncovered = [...found.entries()].filter(
      ([name]) => !covered.has(name) && !INDEX_COVERAGE_ALLOWLIST.has(name),
    );
    expect(
      uncovered,
      `Neue(r) Startup-Index ohne Drift-Wächter-Eintrag: ${uncovered
        .map(([name, file]) => `${name} (${file})`)
        .join(", ")}. In INDEX_SOURCES aufnehmen oder allowlisten.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// Task #943 — CHECK-CONSTRAINT-Drift.
//
// Der Spalten-/Index-Drift-Wächter oben deckt Typ/Nullability/Default und
// Indexe ab, NICHT aber die CHECK-Constraints, die die Startup-Migrationen per
// rohem SQL anlegen. Ein CHECK, der nur im rohen SQL existiert (oder dort ein
// ANDERES Prädikat trägt als beabsichtigt), bleibt vom Drizzle-Modell völlig
// unbemerkt — Drizzle kennt diese CHECKs gar nicht. Driftet das Prädikat,
// lässt entweder GoBD-verletzendes Schreiben durch oder blockiert legitimes.
//
// Strategie (pro Startup-CHECK): Wir spielen das rohe Startup-SQL UND ein
// unabhängig im Test handgepflegtes Erwartungs-Prädikat in DIESELBE TEMP-
// Tabelle und vergleichen die von PostgreSQL normalisierte
// `pg_get_constraintdef`-Ausgabe (die den Namen NICHT enthält). So werden
// beide Prädikate identisch normalisiert (z.B. `IN (...)` → `= ANY (ARRAY...)`)
// und ein Drift zwischen Startup-DDL und dem erwarteten Vertrag fällt auf.
// ===========================================================================

interface CheckSource {
  label: string;
  /** Rohes Startup-SQL (exportierte SSoT-Konstante). */
  rawSql: string;
  /** Constraint-Name, wie ihn das Startup-SQL trägt. */
  constraintName: string;
  realTable: string;
  /** DDL der TEMP-Tabelle: alle im CHECK referenzierten Spalten. */
  tempColumns: string;
  /** Unabhängig handgepflegtes Erwartungs-Prädikat (der eigentliche Vertrag). */
  expectedPredicate: string;
}

const CHECK_SOURCES: CheckSource[] = [
  {
    label:
      "ensure-budget-tx-appointment-constraint: budget_transactions_appointment_required_check",
    rawSql: BUDGET_TX_APPOINTMENT_CHECK_SQL,
    constraintName: BUDGET_TX_APPOINTMENT_CHECK_NAME,
    realTable: "budget_transactions",
    tempColumns: "transaction_type text, appointment_id integer",
    expectedPredicate:
      "transaction_type IN ('manual_adjustment', 'expiration', 'write_off') OR appointment_id IS NOT NULL",
  },
  {
    label:
      "migrate-erstberatung-customers: appointments_prospect_or_customer_check",
    rawSql: APPOINTMENTS_PROSPECT_OR_CUSTOMER_CHECK_SQL,
    constraintName: APPOINTMENTS_PROSPECT_OR_CUSTOMER_CHECK_NAME,
    realTable: "appointments",
    tempColumns: "prospect_id integer, customer_id integer",
    expectedPredicate: "prospect_id IS NOT NULL OR customer_id IS NOT NULL",
  },
];

/** CHECK-Constraints, die woanders abgesichert sind / kein CHECK-Vertrag nötig. */
const CHECK_COVERAGE_ALLOWLIST = new Set<string>([]);

/** Rohes ALTER…ADD CONSTRAINT…CHECK auf eine TEMP-Tabelle + frischen Namen umbiegen. */
function rewriteRawCheckSql(
  rawSql: string,
  realTable: string,
  probe: string,
  probeConstraintName: string,
): string {
  let s = rawSql.trim();
  s = s.replace(
    new RegExp(`ALTER TABLE\\s+"?${realTable}"?`, "i"),
    `ALTER TABLE ${probe}`,
  );
  s = s.replace(
    /ADD CONSTRAINT\s+\S+/i,
    `ADD CONSTRAINT ${probeConstraintName}`,
  );
  return s;
}

async function readCheckDefs(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  probe: string,
): Promise<Map<string, string>> {
  const res = await tx.execute(sql`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    WHERE c.relname = ${probe} AND con.contype = 'c'
  `);
  const map = new Map<string, string>();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    map.set(r.conname as string, r.def as string);
  }
  return map;
}

describe("Startup CHECK-Constraint-Drift (server/startup/**)", () => {
  describe("CHECK — rohes SQL == erwartetes Prädikat", () => {
    for (const src of CHECK_SOURCES) {
      it(src.label, async () => {
        const probe = nextProbeName();
        const rawConName = `${probe}_raw`;
        const expConName = `${probe}_exp`;

        const rawCheckSql = rewriteRawCheckSql(
          src.rawSql,
          src.realTable,
          probe,
          rawConName,
        );
        // Sanity: Transformation hat gegriffen.
        expect(rawCheckSql).toContain(`ALTER TABLE ${probe}`);
        expect(rawCheckSql).toContain(rawConName);
        expect(rawCheckSql).not.toMatch(
          new RegExp(`ALTER TABLE\\s+"?${src.realTable}"?`, "i"),
        );

        let rawDef = "";
        let expDef = "";
        await db.transaction(async (tx) => {
          await tx.execute(
            sql.raw(`CREATE TEMP TABLE ${probe} (${src.tempColumns})`),
          );
          await tx.execute(sql.raw(rawCheckSql));
          await tx.execute(
            sql.raw(
              `ALTER TABLE ${probe} ADD CONSTRAINT ${expConName} CHECK (${src.expectedPredicate})`,
            ),
          );
          const defs = await readCheckDefs(tx, probe);
          rawDef = defs.get(rawConName) ?? "";
          expDef = defs.get(expConName) ?? "";
        });

        expect(
          rawDef,
          `rohes CHECK-SQL erzeugte keinen Constraint: ${src.label}`,
        ).not.toBe("");
        expect(
          expDef,
          `Erwartungs-Prädikat erzeugte keinen Constraint: ${src.label}`,
        ).not.toBe("");
        expect(
          rawDef,
          `CHECK-Drift bei ${src.constraintName}: rohes Startup-SQL ≠ erwartetes Prädikat`,
        ).toEqual(expDef);
      });
    }
  });

  it("absichtlich abweichendes CHECK-Prädikat fällt auf", async () => {
    // Negativ-Kontrolle: das rohe budget_tx-CHECK gegen ein bewusst FALSCHES
    // Prädikat (ohne den transaction_type-Zweig) → die normalisierten Defs
    // dürfen NICHT gleich sein, sonst wäre der Vergleich oben wertlos.
    const probe = nextProbeName();
    const rawConName = `${probe}_raw`;
    const wrongConName = `${probe}_wrong`;
    const rawCheckSql = rewriteRawCheckSql(
      BUDGET_TX_APPOINTMENT_CHECK_SQL,
      "budget_transactions",
      probe,
      rawConName,
    );

    let rawDef = "";
    let wrongDef = "";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          `CREATE TEMP TABLE ${probe} (transaction_type text, appointment_id integer)`,
        ),
      );
      await tx.execute(sql.raw(rawCheckSql));
      await tx.execute(
        sql.raw(
          `ALTER TABLE ${probe} ADD CONSTRAINT ${wrongConName} CHECK (appointment_id IS NOT NULL)`,
        ),
      );
      const defs = await readCheckDefs(tx, probe);
      rawDef = defs.get(rawConName) ?? "";
      wrongDef = defs.get(wrongConName) ?? "";
    });

    expect(rawDef).not.toBe("");
    expect(wrongDef).not.toBe("");
    expect(rawDef).not.toEqual(wrongDef);
  });

  it("jeder ADD CONSTRAINT … CHECK in server/startup/** ist abgedeckt", () => {
    const covered = new Set(CHECK_SOURCES.map((s) => s.constraintName));
    const startupDir = join(process.cwd(), "server", "startup");

    const found = new Map<string, string>(); // constraintName -> Datei
    for (const entry of readdirSync(startupDir)) {
      if (!entry.endsWith(".ts")) continue;
      const full = join(startupDir, entry);
      if (!statSync(full).isFile()) continue;
      const sourceText = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const re =
        /ADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)\s+CHECK\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sourceText)) !== null) {
        found.set(m[1], entry);
      }
    }

    const uncovered = [...found.entries()].filter(
      ([name]) => !covered.has(name) && !CHECK_COVERAGE_ALLOWLIST.has(name),
    );
    expect(
      uncovered,
      `Neue(r) Startup-CHECK-Constraint ohne Drift-Wächter-Eintrag: ${uncovered
        .map(([name, file]) => `${name} (${file})`)
        .join(", ")}. In CHECK_SOURCES aufnehmen oder allowlisten.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// Task #943 — TRIGGER-Drift.
//
// Die GoBD-/audit_log-Immutabilitäts-Migrationen schützen ihre Tabellen per
// BEFORE-Trigger (Hard-Delete-/Resurrect-/Mutations-/TRUNCATE-Sperren). Diese
// Trigger sind GoBD-kritisch: fehlt einer oder ist er an das falsche
// Event/Timing/Level/die falsche Funktion gebunden, lässt die DB stillschweigend
// verbotene Schreibzugriffe durch. Drizzle kennt diese Trigger NICHT.
//
// Strategie: Jede Migration deklariert ihre Trigger als typisierte
// `StartupTriggerSpec` (SSoT) und BAUT ihr CREATE-TRIGGER-DDL daraus
// (`renderCreateTriggerSql`). Dieser Test liest die zur Laufzeit (beim Startup)
// real angelegten Trigger aus `pg_trigger` der Live-Test-DB, dekodiert die
// `tgtype`-Bitmaske und vergleicht Tabelle/Timing/Events/Level/Funktion gegen
// die Spec. So ist garantiert: (a) der Trigger existiert wirklich, (b) er ist
// exakt so gebunden, wie die Spec behauptet.
// ===========================================================================

const ALL_STARTUP_TRIGGER_SPECS: StartupTriggerSpec[] = [
  ...AUDIT_LOG_TRIGGERS,
  ...BUDGET_TRANSACTIONS_TRIGGERS,
  ...GOBD_TABLE_TRIGGERS,
];

// pg_trigger.tgtype-Bitmaske (siehe PostgreSQL-Quelle catalog/pg_trigger.h).
const TG_ROW = 1 << 0;
const TG_BEFORE = 1 << 1;
const TG_INSERT = 1 << 2;
const TG_DELETE = 1 << 3;
const TG_UPDATE = 1 << 4;
const TG_TRUNCATE = 1 << 5;

interface DecodedTrigger {
  timing: "BEFORE" | "AFTER";
  level: "ROW" | "STATEMENT";
  events: Set<TriggerEvent>;
  functionName: string;
}

function decodeTgType(tgtype: number, proname: string): DecodedTrigger {
  const events = new Set<TriggerEvent>();
  if (tgtype & TG_INSERT) events.add("INSERT");
  if (tgtype & TG_UPDATE) events.add("UPDATE");
  if (tgtype & TG_DELETE) events.add("DELETE");
  if (tgtype & TG_TRUNCATE) events.add("TRUNCATE");
  return {
    timing: tgtype & TG_BEFORE ? "BEFORE" : "AFTER",
    level: tgtype & TG_ROW ? "ROW" : "STATEMENT",
    events,
    functionName: proname,
  };
}

function eventsEqual(a: Set<TriggerEvent>, b: Iterable<TriggerEvent>): boolean {
  const bs = new Set(b);
  if (a.size !== bs.size) return false;
  for (const e of a) if (!bs.has(e)) return false;
  return true;
}

/** Reiner Vergleich: deckt sich der real gebundene Trigger mit der Spec? */
function triggerMatchesSpec(
  decoded: DecodedTrigger,
  table: string,
  spec: StartupTriggerSpec,
): boolean {
  return (
    decoded.timing === spec.timing &&
    decoded.level === spec.level &&
    decoded.functionName === spec.functionName &&
    table === spec.table &&
    eventsEqual(decoded.events, spec.events)
  );
}

interface LiveTrigger {
  tgtype: number;
  proname: string;
  relname: string;
}

async function readLiveTrigger(
  exec: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  table: string,
  name: string,
): Promise<LiveTrigger | null> {
  const res = await exec.execute(sql`
    SELECT t.tgtype::int AS tgtype, p.proname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_proc p ON t.tgfoid = p.oid
    WHERE c.relname = ${table}
      AND t.tgname = ${name}
      AND NOT t.tgisinternal
  `);
  const row = (res.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    tgtype: Number(row.tgtype),
    proname: row.proname as string,
    relname: row.relname as string,
  };
}

describe("Startup Trigger-Drift (server/startup/**)", () => {
  describe("TRIGGER — Live-DB-Bindung == Spec", () => {
    for (const spec of ALL_STARTUP_TRIGGER_SPECS) {
      it(`${spec.table}.${spec.name}`, async () => {
        const live = await readLiveTrigger(db, spec.table, spec.name);
        expect(
          live,
          `Trigger fehlt in der DB: ${spec.name} auf ${spec.table}`,
        ).not.toBeNull();
        const decoded = decodeTgType(live!.tgtype, live!.proname);
        expect(decoded.timing, `Timing-Drift bei ${spec.name}`).toBe(
          spec.timing,
        );
        expect(decoded.level, `Level-Drift bei ${spec.name}`).toBe(spec.level);
        expect(
          [...decoded.events].sort(),
          `Event-Drift bei ${spec.name}`,
        ).toEqual([...spec.events].sort());
        expect(
          decoded.functionName,
          `Funktions-Drift bei ${spec.name}`,
        ).toBe(spec.functionName);
        expect(live!.relname, `Tabellen-Drift bei ${spec.name}`).toBe(
          spec.table,
        );
        expect(triggerMatchesSpec(decoded, live!.relname, spec)).toBe(true);
      });
    }
  });

  it("absichtlich abweichende Trigger-Bindung fällt auf", async () => {
    // Negativ-Kontrolle: ein bewusst falsch gebundener Trigger (AFTER statt
    // BEFORE) auf einer TEMP-Tabelle muss vom Vergleich abgelehnt werden — sonst
    // wäre die Live-Prüfung oben wertlos. Wir nutzen eine real existierende
    // Trigger-Funktion (aus dem Startup), aber eine verfälschte Spec.
    const reference = ALL_STARTUP_TRIGGER_SPECS.find(
      (s) => s.timing === "BEFORE" && s.level === "ROW",
    )!;
    const probe = nextProbeName();
    const probeTrigger = `${probe}_t`;
    const wrongSpec: StartupTriggerSpec = {
      ...reference,
      timing: "AFTER",
      name: probeTrigger,
    };

    let decoded: DecodedTrigger | null = null;
    let relname = "";
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE TEMP TABLE ${probe} (id integer)`));
      await tx.execute(
        sql.raw(renderCreateTriggerSql(wrongSpec, probe, probeTrigger)),
      );
      const live = await readLiveTrigger(tx, probe, probeTrigger);
      expect(live).not.toBeNull();
      decoded = decodeTgType(live!.tgtype, live!.proname);
      relname = live!.relname;
    });

    // Gegen die ORIGINALE (BEFORE-)Spec verglichen → muss als Drift auffallen.
    expect(triggerMatchesSpec(decoded!, relname, reference)).toBe(false);
    expect(decoded!.timing).toBe("AFTER");
  });

  it("jeder CREATE TRIGGER in server/startup/** ist über eine Spec abgedeckt", () => {
    const covered = new Set(ALL_STARTUP_TRIGGER_SPECS.map((s) => s.name));
    const startupDir = join(process.cwd(), "server", "startup");

    const found = new Map<string, string>(); // triggerName -> Datei
    for (const entry of readdirSync(startupDir)) {
      if (!entry.endsWith(".ts")) continue;
      // trigger-spec.ts ist der Renderer (enthält `CREATE TRIGGER ${...}`),
      // keine Migration → nicht scannen.
      if (entry === "trigger-spec.ts") continue;
      const full = join(startupDir, entry);
      if (!statSync(full).isFile()) continue;
      const sourceText = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const re =
        /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sourceText)) !== null) {
        found.set(m[1], entry);
      }
    }

    const uncovered = [...found.entries()].filter(
      ([name]) => !covered.has(name),
    );
    expect(
      uncovered,
      `Roh angelegter Startup-Trigger ohne Spec/Drift-Wächter-Eintrag: ${uncovered
        .map(([name, file]) => `${name} (${file})`)
        .join(", ")}. Als StartupTriggerSpec deklarieren (renderCreateTriggerSql).`,
    ).toEqual([]);
  });
});
