/**
 * SSoT für ALLE Trigger und Trigger-Funktionen, die der Startup-Pfad anlegt.
 *
 * ERSETZT die bis hierhin auf drei Orte verteilte Antwort auf die Frage „welche
 * Trigger legt der Startup an?": die drei `*_TRIGGERS`-Arrays und die elf
 * `*_FN_SQL`-Konstanten lagen in den `ensure-*`-Migrationen, die Vereinigung
 * `ALL_STARTUP_TRIGGER_SPECS` existierte nur im TEST. Drei Verbraucher zählten
 * damit jeder für sich.
 *
 * Jetzt speisen sich alle drei aus dieser Datei:
 *   - der Laufzeit-Renderer  (`ensure-*`),
 *   - die versionierte Migration (`scripts/generate-trigger-migration.ts`),
 *   - der Drift-Wächter      (`tests/startup/startup-schema-drift.test.ts`).
 * Die Migration kann damit nicht gegen eine andere Menge gebaut werden als die,
 * die tatsächlich läuft.
 *
 * BEWUSST OHNE Laufzeit-Importe: diese Datei zieht nur den Typ aus
 * `trigger-spec` und sonst nichts. Läge hier ein `db`-Import (direkt oder über
 * eine `ensure-*`-Datei), bräuchte schon das RENDERN der Migration eine
 * Datenbankverbindung — der Generator liefe dann nur mit gesetzter
 * `DATABASE_URL`. Deshalb wohnen die Daten hier und die `ensure-*` importieren
 * sie, nicht umgekehrt.
 */
import type { StartupTriggerSpec } from "./trigger-spec";

// Task #943 — Trigger-Funktionen + Trigger-Specs als SSoT-Konstanten exportiert,
// damit der Startup-Schema-Drift-Wächter sie gegen ihre erwartete Bindung prüft.
export const AUDIT_LOG_PREVENT_MUTATION_FN_SQL = `
    CREATE OR REPLACE FUNCTION audit_log_prevent_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_audit_log_mutation', true) = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (% verweigert)', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const AUDIT_LOG_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION audit_log_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (TRUNCATE verweigert)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const AUDIT_LOG_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "audit_log_no_update_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "audit_log_prevent_mutation",
  },
  {
    name: "audit_log_no_delete_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "audit_log_prevent_mutation",
  },
  {
    name: "audit_log_no_truncate_trigger",
    table: "audit_log",
    timing: "BEFORE",
    events: ["TRUNCATE"],
    level: "STATEMENT",
    functionName: "audit_log_prevent_truncate",
  },
];

// Task #1273 (Budget-Ledger Stufe B) — die GoBD-Härtung ist von `budget_ledger`
// auf `budget_transactions` UMGEZOGEN (umbenannt + Ziel-Tabelle gewechselt,
// NICHT dupliziert). `budget_transactions` ist ab Stufe B die EINE append-only
// Finanz-Schicht; der frühere `budget_ledger`-Spiegel ist in Stufe C
// (Task #1274) ersatzlos entfernt.
export const BUDGET_TRANSACTIONS_PREVENT_UPDATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_update()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-UPDATE verboten (append-only; Korrektur nur via neue reversal-/consumption-Zeile)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_PREVENT_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-Hard-Delete verboten (append-only Finanz-Ledger)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_transactions_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION
        'budget_transactions: GoBD-TRUNCATE verboten'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const BUDGET_TRANSACTIONS_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "budget_transactions_no_update_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "budget_transactions_prevent_update",
  },
  {
    name: "budget_transactions_no_delete_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "budget_transactions_prevent_delete",
  },
  {
    name: "budget_transactions_no_truncate_trigger",
    table: "budget_transactions",
    timing: "BEFORE",
    events: ["TRUNCATE"],
    level: "STATEMENT",
    functionName: "budget_transactions_prevent_truncate",
  },
];

// Task #943 — Trigger-Funktionen + Trigger-Specs als SSoT-Konstanten exportiert,
// damit der Startup-Schema-Drift-Wächter sie gegen ihre erwartete Bindung prüft.
export const GOBD_PREVENT_RESURRECT_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_allocations_prevent_resurrect()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NEW;
      END IF;
      IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION
          'budget_allocations: GoBD-Resurrect verboten (soft-geloeschte Allokation darf nicht wiederbelebt werden)'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;

export const GOBD_ALLOCATIONS_PREVENT_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION budget_allocations_prevent_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'budget_allocations: GoBD-Hard-Delete verboten (nur Soft-Delete via deleted_at)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const GOBD_CBTS_PREVENT_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION cbts_prevent_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'customer_budget_type_settings: GoBD-Hard-Delete verboten (append-only Historisierung)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

export const GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL = `
    CREATE OR REPLACE FUNCTION invoices_prevent_finalized_delete()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN OLD;
      END IF;
      IF OLD.status IS DISTINCT FROM 'entwurf' THEN
        RAISE EXCEPTION
          'invoices: GoBD-Hard-Delete einer finalisierten Rechnung verboten (Korrektur nur via Storno)'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `;

export const GOBD_LINE_ITEMS_PREVENT_FINALIZED_MUTATION_FN_SQL = `
    CREATE OR REPLACE FUNCTION invoice_line_items_prevent_finalized_mutation()
    RETURNS trigger AS $$
    DECLARE
      parent_status text;
      ref_invoice_id integer;
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      ref_invoice_id := CASE TG_OP WHEN 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
      SELECT status INTO parent_status FROM invoices WHERE id = ref_invoice_id;
      IF parent_status IS NOT NULL AND parent_status IS DISTINCT FROM 'entwurf' THEN
        RAISE EXCEPTION
          'invoice_line_items: GoBD-Mutation einer Position der finalisierten Rechnung % verboten (% verweigert)', ref_invoice_id, TG_OP
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$ LANGUAGE plpgsql;
  `;

export const GOBD_PREVENT_TRUNCATE_FN_SQL = `
    CREATE OR REPLACE FUNCTION gobd_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION
        'GoBD: TRUNCATE auf % verboten', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;
  `;

/** Alle vier Tabellen, deren TRUNCATE über `gobd_prevent_truncate` gesperrt wird. */
export const GOBD_TRUNCATE_PROTECTED_TABLES = [
  "budget_allocations",
  "customer_budget_type_settings",
  "invoices",
  "invoice_line_items",
] as const;

export const GOBD_TABLE_TRIGGERS: StartupTriggerSpec[] = [
  {
    name: "budget_allocations_no_resurrect_trigger",
    table: "budget_allocations",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "budget_allocations_prevent_resurrect",
  },
  {
    name: "budget_allocations_no_delete_trigger",
    table: "budget_allocations",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "budget_allocations_prevent_delete",
  },
  {
    name: "cbts_no_delete_trigger",
    table: "customer_budget_type_settings",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "cbts_prevent_delete",
  },
  {
    name: "invoices_no_finalized_delete_trigger",
    table: "invoices",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "invoices_prevent_finalized_delete",
  },
  {
    name: "invoice_line_items_no_finalized_update_trigger",
    table: "invoice_line_items",
    timing: "BEFORE",
    events: ["UPDATE"],
    level: "ROW",
    functionName: "invoice_line_items_prevent_finalized_mutation",
  },
  {
    name: "invoice_line_items_no_finalized_delete_trigger",
    table: "invoice_line_items",
    timing: "BEFORE",
    events: ["DELETE"],
    level: "ROW",
    functionName: "invoice_line_items_prevent_finalized_mutation",
  },
  ...GOBD_TRUNCATE_PROTECTED_TABLES.map(
    (table): StartupTriggerSpec => ({
      name: `${table}_no_truncate_trigger`,
      table,
      timing: "BEFORE",
      events: ["TRUNCATE"],
      level: "STATEMENT",
      functionName: "gobd_prevent_truncate",
    }),
  ),
];

/** Eine Trigger-Funktion: Name (wie in `pg_proc`) + ihr `CREATE OR REPLACE`-DDL. */
export interface StartupTriggerFunction {
  readonly name: string;
  readonly sql: string;
}

/**
 * Die elf lebenden Trigger-Funktionen.
 *
 * Die Reihenfolge hier ist die Lese-Reihenfolge dieser Datei, NICHT die
 * Boot-Reihenfolge (die ist audit → gobd → budget_transactions, siehe
 * `server/index.ts`). Das ist folgenlos: die Migration legt alle Funktionen an,
 * bevor sie den ersten Trigger bindet.
 */
export const ALL_STARTUP_TRIGGER_FUNCTIONS: readonly StartupTriggerFunction[] = [
  { name: "audit_log_prevent_mutation", sql: AUDIT_LOG_PREVENT_MUTATION_FN_SQL },
  { name: "audit_log_prevent_truncate", sql: AUDIT_LOG_PREVENT_TRUNCATE_FN_SQL },
  { name: "budget_transactions_prevent_update", sql: BUDGET_TRANSACTIONS_PREVENT_UPDATE_FN_SQL },
  { name: "budget_transactions_prevent_delete", sql: BUDGET_TRANSACTIONS_PREVENT_DELETE_FN_SQL },
  { name: "budget_transactions_prevent_truncate", sql: BUDGET_TRANSACTIONS_PREVENT_TRUNCATE_FN_SQL },
  { name: "budget_allocations_prevent_resurrect", sql: GOBD_PREVENT_RESURRECT_FN_SQL },
  { name: "budget_allocations_prevent_delete", sql: GOBD_ALLOCATIONS_PREVENT_DELETE_FN_SQL },
  { name: "cbts_prevent_delete", sql: GOBD_CBTS_PREVENT_DELETE_FN_SQL },
  { name: "invoices_prevent_finalized_delete", sql: GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL },
  { name: "invoice_line_items_prevent_finalized_mutation", sql: GOBD_LINE_ITEMS_PREVENT_FINALIZED_MUTATION_FN_SQL },
  { name: "gobd_prevent_truncate", sql: GOBD_PREVENT_TRUNCATE_FN_SQL },
];

/** Alle Trigger-Bindungen des Startup-Pfads (Tabelle/Timing/Event/Level/Funktion). */
export const ALL_STARTUP_TRIGGER_SPECS: readonly StartupTriggerSpec[] = [
  ...AUDIT_LOG_TRIGGERS,
  ...BUDGET_TRANSACTIONS_TRIGGERS,
  ...GOBD_TABLE_TRIGGERS,
];

/**
 * Verwaiste Trigger-Funktionen aus der ersatzlos entfernten `budget_ledger`.
 *
 * `drop-budget-ledger.ts` (Ledger-Stufe C) hat die Tabelle samt ihrer Trigger
 * gedroppt, die zugehörigen Funktionen aber nicht — der Installer
 * (`ensure-budget-ledger-immutability.ts`) war da bereits ersatzlos gelöscht,
 * und in der gesamten git-Historie gibt es kein einziges `DROP FUNCTION`.
 *
 * Am 03.08.2026 read-only gegen Prod gemessen und mit der Dev-Kopie
 * abgeglichen: exakt diese drei sind dort noch vorhanden (14 statt 11
 * Trigger-Funktionen), keine weiteren Abweichungen, keine eigenen RULEs.
 *
 * Die Migration droppt sie — bewusst OHNE `CASCADE`: hängt wider Erwarten doch
 * etwas daran, MUSS sie scheitern statt es still mitzureißen.
 */
export const ORPHANED_TRIGGER_FUNCTIONS: readonly string[] = [
  "budget_ledger_prevent_delete",
  "budget_ledger_prevent_update",
  "budget_ledger_prevent_truncate",
];

/** Tabelle, auf der die Alt-RULEs sitzen. */
export const LEGACY_RULE_TABLE = "audit_log";

/**
 * Alte, GoBD-schwache `DO INSTEAD NOTHING`-RULEs auf `audit_log`.
 *
 * Solange eine davon existiert, schreibt sie das Statement um und der
 * BEFORE-Trigger feuert NIE — `DELETE`/`UPDATE` laufen still ins Leere
 * (`DELETE 0`, keine Exception). Genau der Vektor, den Task #824 abgeschafft
 * hat. Sie werden nirgends im Repo erzeugt; sie stammen aus der Vor-Repo-Zeit
 * und können nur durch einen Restore aus einem alten Backup zurückkehren.
 *
 * Drei Verbraucher, EINE Liste: der defensive Drop beim Startup, der
 * Laufzeit-Verifier (`lingeringRules` → `/api/health`) und die versionierte
 * Migration. Vorher standen die Namen doppelt — hartkodiert in den beiden
 * `DROP RULE`-Statements und noch einmal in der Verifier-Liste.
 */
export const FORBIDDEN_AUDIT_LOG_RULES = [
  "audit_log_no_update",
  "audit_log_no_delete",
] as const;
