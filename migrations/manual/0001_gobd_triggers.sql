-- GENERIERT — NICHT VON HAND BEARBEITEN.
-- Quelle: server/startup/trigger-registry.ts
-- Neu erzeugen: npx tsx scripts/generate-trigger-migration.ts
--
-- GoBD-/Unveraenderlichkeits-Trigger als versionierte Migration (A1).
-- Bildet exakt ab, was der Startup-Pfad heute zur Laufzeit anlegt:
--   11 Trigger-Funktionen, 16 Trigger.
--
-- Drizzle kann Trigger und Funktionen nicht ausdruecken; diese Datei ist
-- deshalb die handgefuehrte Haelfte des Schema-Bauplans neben der
-- generierten Baseline (A2).
--
-- AUSFUEHRUNG: NUR transaktional und mit Abbruch bei Fehler --
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <diese Datei>
-- Ohne -1/ON_ERROR_STOP laeuft psql nach einem Fehler weiter und endet mit
-- Exit 0 — der Fail-fast des DROP-Blocks unten waere dann wirkungslos.
-- Der programmatische Migrator (A3) faehrt jede Migration ohnehin in einer
-- Transaktion; dort gilt die Zusage strukturell.

-- ---------------------------------------------------------------------------
-- 1) Verwaiste Funktionen der ersatzlos entfernten `budget_ledger`.
--
-- `drop-budget-ledger.ts` hat Tabelle und Trigger gedroppt, die Funktionen
-- aber nicht; am 03.08.2026 read-only in Prod nachgewiesen (14 statt 11).
-- BEWUSST OHNE CASCADE: haengt wider Erwarten doch etwas daran, MUSS die
-- Migration hier scheitern statt es still mitzureissen.
-- Steht am Anfang, damit dieser Fall auffaellt, bevor irgendetwas gebaut wird
-- — vorausgesetzt, die Datei laeuft transaktional (siehe Kopf).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS budget_ledger_prevent_delete();
DROP FUNCTION IF EXISTS budget_ledger_prevent_update();
DROP FUNCTION IF EXISTS budget_ledger_prevent_truncate();

-- ---------------------------------------------------------------------------
-- 2) Trigger-Funktionen.
-- ---------------------------------------------------------------------------
-- audit_log_prevent_mutation
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

-- audit_log_prevent_truncate
CREATE OR REPLACE FUNCTION audit_log_prevent_truncate()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'audit_log ist GoBD-technisch unveraenderbar (TRUNCATE verweigert)'
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;

-- budget_transactions_prevent_update
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

-- budget_transactions_prevent_delete
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

-- budget_transactions_prevent_truncate
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

-- budget_allocations_prevent_resurrect
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

-- budget_allocations_prevent_delete
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

-- cbts_prevent_delete
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

-- invoices_prevent_finalized_delete
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

-- invoice_line_items_prevent_finalized_mutation
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

-- gobd_prevent_truncate
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

-- ---------------------------------------------------------------------------
-- 3) Trigger-Bindungen.
--
-- `DROP ... IF EXISTS` vor jedem `CREATE`, damit die Migration auf einer DB,
-- die den Trigger bereits per Startup-DDL traegt, idempotent bleibt.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_log_no_update_trigger ON audit_log;
CREATE TRIGGER audit_log_no_update_trigger
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete_trigger ON audit_log;
CREATE TRIGGER audit_log_no_delete_trigger
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

DROP TRIGGER IF EXISTS audit_log_no_truncate_trigger ON audit_log;
CREATE TRIGGER audit_log_no_truncate_trigger
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_prevent_truncate();

DROP TRIGGER IF EXISTS budget_transactions_no_update_trigger ON budget_transactions;
CREATE TRIGGER budget_transactions_no_update_trigger
    BEFORE UPDATE ON budget_transactions
    FOR EACH ROW EXECUTE FUNCTION budget_transactions_prevent_update();

DROP TRIGGER IF EXISTS budget_transactions_no_delete_trigger ON budget_transactions;
CREATE TRIGGER budget_transactions_no_delete_trigger
    BEFORE DELETE ON budget_transactions
    FOR EACH ROW EXECUTE FUNCTION budget_transactions_prevent_delete();

DROP TRIGGER IF EXISTS budget_transactions_no_truncate_trigger ON budget_transactions;
CREATE TRIGGER budget_transactions_no_truncate_trigger
    BEFORE TRUNCATE ON budget_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION budget_transactions_prevent_truncate();

DROP TRIGGER IF EXISTS budget_allocations_no_resurrect_trigger ON budget_allocations;
CREATE TRIGGER budget_allocations_no_resurrect_trigger
    BEFORE UPDATE ON budget_allocations
    FOR EACH ROW EXECUTE FUNCTION budget_allocations_prevent_resurrect();

DROP TRIGGER IF EXISTS budget_allocations_no_delete_trigger ON budget_allocations;
CREATE TRIGGER budget_allocations_no_delete_trigger
    BEFORE DELETE ON budget_allocations
    FOR EACH ROW EXECUTE FUNCTION budget_allocations_prevent_delete();

DROP TRIGGER IF EXISTS cbts_no_delete_trigger ON customer_budget_type_settings;
CREATE TRIGGER cbts_no_delete_trigger
    BEFORE DELETE ON customer_budget_type_settings
    FOR EACH ROW EXECUTE FUNCTION cbts_prevent_delete();

DROP TRIGGER IF EXISTS invoices_no_finalized_delete_trigger ON invoices;
CREATE TRIGGER invoices_no_finalized_delete_trigger
    BEFORE DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION invoices_prevent_finalized_delete();

DROP TRIGGER IF EXISTS invoice_line_items_no_finalized_update_trigger ON invoice_line_items;
CREATE TRIGGER invoice_line_items_no_finalized_update_trigger
    BEFORE UPDATE ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION invoice_line_items_prevent_finalized_mutation();

DROP TRIGGER IF EXISTS invoice_line_items_no_finalized_delete_trigger ON invoice_line_items;
CREATE TRIGGER invoice_line_items_no_finalized_delete_trigger
    BEFORE DELETE ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION invoice_line_items_prevent_finalized_mutation();

DROP TRIGGER IF EXISTS budget_allocations_no_truncate_trigger ON budget_allocations;
CREATE TRIGGER budget_allocations_no_truncate_trigger
    BEFORE TRUNCATE ON budget_allocations
    FOR EACH STATEMENT EXECUTE FUNCTION gobd_prevent_truncate();

DROP TRIGGER IF EXISTS customer_budget_type_settings_no_truncate_trigger ON customer_budget_type_settings;
CREATE TRIGGER customer_budget_type_settings_no_truncate_trigger
    BEFORE TRUNCATE ON customer_budget_type_settings
    FOR EACH STATEMENT EXECUTE FUNCTION gobd_prevent_truncate();

DROP TRIGGER IF EXISTS invoices_no_truncate_trigger ON invoices;
CREATE TRIGGER invoices_no_truncate_trigger
    BEFORE TRUNCATE ON invoices
    FOR EACH STATEMENT EXECUTE FUNCTION gobd_prevent_truncate();

DROP TRIGGER IF EXISTS invoice_line_items_no_truncate_trigger ON invoice_line_items;
CREATE TRIGGER invoice_line_items_no_truncate_trigger
    BEFORE TRUNCATE ON invoice_line_items
    FOR EACH STATEMENT EXECUTE FUNCTION gobd_prevent_truncate();
