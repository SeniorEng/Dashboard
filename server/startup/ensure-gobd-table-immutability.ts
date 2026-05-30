import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

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
  // -------------------------------------------------------------------------
  // budget_allocations: kein Resurrect, kein Hard-Delete, kein TRUNCATE.
  // -------------------------------------------------------------------------
  await db.execute(sql`
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
  `);

  await db.execute(sql`
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
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS budget_allocations_no_resurrect_trigger ON budget_allocations`);
  await db.execute(sql`
    CREATE TRIGGER budget_allocations_no_resurrect_trigger
    BEFORE UPDATE ON budget_allocations
    FOR EACH ROW EXECUTE FUNCTION budget_allocations_prevent_resurrect();
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS budget_allocations_no_delete_trigger ON budget_allocations`);
  await db.execute(sql`
    CREATE TRIGGER budget_allocations_no_delete_trigger
    BEFORE DELETE ON budget_allocations
    FOR EACH ROW EXECUTE FUNCTION budget_allocations_prevent_delete();
  `);

  // -------------------------------------------------------------------------
  // customer_budget_type_settings: append-only (kein Hard-Delete).
  // -------------------------------------------------------------------------
  await db.execute(sql`
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
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS cbts_no_delete_trigger ON customer_budget_type_settings`);
  await db.execute(sql`
    CREATE TRIGGER cbts_no_delete_trigger
    BEFORE DELETE ON customer_budget_type_settings
    FOR EACH ROW EXECUTE FUNCTION cbts_prevent_delete();
  `);

  // -------------------------------------------------------------------------
  // invoices: finalisierte Rechnungen (status <> 'entwurf') sind unloeschbar.
  // -------------------------------------------------------------------------
  await db.execute(sql`
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
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS invoices_no_finalized_delete_trigger ON invoices`);
  await db.execute(sql`
    CREATE TRIGGER invoices_no_finalized_delete_trigger
    BEFORE DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION invoices_prevent_finalized_delete();
  `);

  // -------------------------------------------------------------------------
  // invoice_line_items: Positionen finalisierter Rechnungen sind eingefroren.
  // -------------------------------------------------------------------------
  await db.execute(sql`
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
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS invoice_line_items_no_finalized_update_trigger ON invoice_line_items`);
  await db.execute(sql`
    CREATE TRIGGER invoice_line_items_no_finalized_update_trigger
    BEFORE UPDATE ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION invoice_line_items_prevent_finalized_mutation();
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS invoice_line_items_no_finalized_delete_trigger ON invoice_line_items`);
  await db.execute(sql`
    CREATE TRIGGER invoice_line_items_no_finalized_delete_trigger
    BEFORE DELETE ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION invoice_line_items_prevent_finalized_mutation();
  `);

  // -------------------------------------------------------------------------
  // Gemeinsamer TRUNCATE-Schutz fuer alle vier Tabellen.
  // -------------------------------------------------------------------------
  await db.execute(sql`
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
  `);

  for (const table of [
    "budget_allocations",
    "customer_budget_type_settings",
    "invoices",
    "invoice_line_items",
  ]) {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${table}_no_truncate_trigger ON ${table}`));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${table}_no_truncate_trigger
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION gobd_prevent_truncate();
    `));
  }

  log("GoBD-Unveraenderbarkeit weiterer Tabellen (Trigger) sichergestellt", "startup");
}
