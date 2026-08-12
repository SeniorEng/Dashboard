-- #66/#75 – Schema-Schritt auf Prod (Replit/neondb) nachziehen.
-- Befund: invoices.issued_at fehlt auf Prod -> getInvoices (selektiert das
-- ganze invoices-Objekt) wirft 42703 -> 500 auf /billing, /pipeline, /open-for-match.
-- Vollstaendig additiv + idempotent. Reihenfolge zwingend: Spalte -> Backfill -> Trigger
-- (der Trigger-Rumpf liest OLD.issued_at). Vorher Backup gezogen.

BEGIN;

-- (1) Spalte: timestamptz, NULLABLE, kein Default. NULL = "nie ausgegeben".
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS issued_at timestamp with time zone;

-- (1b) Nummernkreis-Tabelle aus demselben #66-Schritt.
CREATE TABLE IF NOT EXISTS invoice_number_sequence (
  billing_year integer PRIMARY KEY NOT NULL,
  last_number  integer NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

-- (2) Backfill (1:1 aus backfill-invoice-issued-at.ts). Entwuerfe bleiben NULL.
UPDATE invoices
   SET issued_at = COALESCE(sent_at, storniert_at, paid_at, created_at)
 WHERE issued_at IS NULL
   AND status <> 'entwurf';

-- (2b) Hochwassermarke je Jahr, GREATEST verhindert Ruecklauf.
INSERT INTO invoice_number_sequence (billing_year, last_number, updated_at)
SELECT billing_year,
       COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'RE-\d{4}-(\d+)') AS INTEGER)), 0),
       now()
  FROM invoices
 GROUP BY billing_year
ON CONFLICT (billing_year) DO UPDATE
   SET last_number = GREATEST(invoice_number_sequence.last_number, EXCLUDED.last_number),
       updated_at  = now();

-- (3) Trigger-Funktion (1:1 aus trigger-registry.ts). CREATE OR REPLACE tauscht
--     den Rumpf, bestehender Trigger zeigt weiter drauf. issued_at-Zweig neu (#66).
CREATE OR REPLACE FUNCTION invoices_prevent_finalized_delete()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status IS DISTINCT FROM 'entwurf' OR OLD.issued_at IS NOT NULL THEN
    RAISE EXCEPTION
      'invoices: GoBD-Hard-Delete verboten - Rechnung ist finalisiert oder wurde bereits ausgegeben (Korrektur nur via Storno)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_no_finalized_delete_trigger ON invoices;
CREATE TRIGGER invoices_no_finalized_delete_trigger
    BEFORE DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION invoices_prevent_finalized_delete();

COMMIT;

-- ============================================================================
-- Verifikation (rein lesend, nach COMMIT, ausserhalb der Transaktion).
-- ============================================================================

-- Erwartet: 6 Zeilen (issued_at jetzt da + 5 Qonto-Spalten schon vorhanden).
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE (table_name, column_name) IN (
         ('invoices','issued_at'),
         ('qonto_transactions','matched_payment_advice_id'),
         ('qonto_transactions','matched_invoice_id'),
         ('qonto_transactions','billing_irrelevant_at'),
         ('payment_advices','deleted_at'),
         ('payment_advice_items','matched_invoice_id'))
 ORDER BY 1,2;

-- Erwartet: nicht NULL.
SELECT to_regclass('invoice_number_sequence') AS sequenz_tabelle;

-- Erwartet: 0.
SELECT count(*) FILTER (WHERE issued_at IS NULL AND status <> 'entwurf') AS ungemarkt
  FROM invoices;