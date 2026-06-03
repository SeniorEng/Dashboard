import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import {
  type StartupTriggerSpec,
  renderCreateTriggerSql,
  renderDropTriggerSql,
} from "./trigger-spec";

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

/**
 * GoBD: technische Absicherung weiterer integritäts-/historisierungskritischer
 * Tabellen gegen stilles Überschreiben (Task #828).
 *
 * `audit_log` ist seit Task #824 per raising BEFORE-Trigger unveränderbar. Die
 * übrigen GoBD-relevanten Tabellen verließen sich bislang ausschließlich auf
 * App-Logik (Soft-Deletes, append-only Konventionen). Eine versehentliche oder
 * bösartige direkte Mutation (z.B. `DELETE FROM budget_allocations …` oder ein
 * Resurrect via `deleted_at = NULL`) wäre still durchgegangen.
 *
 * Diese Migration legt BEFORE-Trigger an, die solche Mutationen mit einer
 * Exception ABLEHNEN (nicht still schlucken — GoBD verlangt technisches
 * Fehlschlagen). Geschützt werden:
 *
 *  - `budget_allocations`        — kein Resurrect (`deleted_at` NOT NULL → NULL),
 *                                  kein Hard-Delete, kein TRUNCATE.
 *  - `customer_budget_type_settings` — append-only: kein Hard-Delete,
 *                                  kein TRUNCATE. (UPDATEs bleiben erlaubt, da
 *                                  der Phasen-Append/In-Place-Pfad geschlossene
 *                                  Zeilen legitim umklemmt.)
 *  - `invoices`                  — finalisierte Rechnungen (`status <> 'entwurf'`)
 *                                  dürfen nicht hart gelöscht werden; kein
 *                                  TRUNCATE. (UPDATE bleibt erlaubt: Status-
 *                                  Übergänge, Qonto-Payment-Matching, PDF-Cache.)
 *  - `invoice_line_items`        — Positionen finalisierter Rechnungen sind
 *                                  eingefroren: kein UPDATE/DELETE, kein TRUNCATE.
 *
 * Legitime Test-/Cleanup-/Merge-Pfade (Kunden-Merge, Test-Daten-Purge,
 * `migrate-budget-sources`) setzen transaktions-lokal
 * `SET LOCAL app.allow_gobd_mutation = 'on'`, womit die Trigger die Mutation
 * für genau diese Transaktion durchlassen. In Produktion wird dieses GUC nie
 * gesetzt → jeder verbotene Schreibzugriff schlägt fehl.
 *
 * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE; bei
 * jedem weiteren Boot ein No-Op.
 */
export async function ensureGobdTableImmutability(): Promise<void> {
  // Trigger-Funktionen (CREATE OR REPLACE — idempotent).
  await db.execute(sql.raw(GOBD_PREVENT_RESURRECT_FN_SQL));
  await db.execute(sql.raw(GOBD_ALLOCATIONS_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_CBTS_PREVENT_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL));
  await db.execute(sql.raw(GOBD_LINE_ITEMS_PREVENT_FINALIZED_MUTATION_FN_SQL));
  await db.execute(sql.raw(GOBD_PREVENT_TRUNCATE_FN_SQL));

  // Trigger (DROP IF EXISTS + CREATE) aus den SSoT-Specs rendern.
  for (const spec of GOBD_TABLE_TRIGGERS) {
    await db.execute(sql.raw(renderDropTriggerSql(spec)));
    await db.execute(sql.raw(renderCreateTriggerSql(spec)));
  }

  log("GoBD-Unveraenderbarkeit weiterer Tabellen (Trigger) sichergestellt", "startup");
}
