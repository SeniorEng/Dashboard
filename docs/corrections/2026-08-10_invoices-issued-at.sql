-- #66/#75 — Schema-Schritt auf Prod (Replit) nachziehen.
--
-- Befund: `invoices.issued_at` fehlt auf Prod. Damit bricht JEDE Abfrage, die
-- das ganze `invoices`-Objekt selektiert (`getInvoices` tut das) — daher die
-- schnellen 500er auf /billing, /billing/pipeline und /billing/open-for-match.
--
-- Vollstaendig additiv und idempotent: mehrfaches Ausfuehren ist folgenlos.
-- Reihenfolge ist zwingend: Spalte -> Backfill -> Trigger. Der Trigger-Rumpf
-- liest `OLD.issued_at`; wird er VOR der Spalte ersetzt, scheitert danach jedes
-- DELETE auf `invoices` mit "record OLD has no field issued_at" — auch das
-- legitime Loeschen eines Entwurfs.
--
-- KEIN GoBD-Bypass (`app.allow_gobd_mutation`) noetig, und er waere schaedlich:
-- auf `invoices` haengen ausschliesslich `invoices_no_finalized_delete_trigger`
-- (BEFORE DELETE) und `invoices_no_truncate_trigger` (BEFORE TRUNCATE) — es gibt
-- dort KEINEN UPDATE-Trigger (migrations/manual/0001_gobd_triggers.sql:268-296,
-- SSoT server/startup/trigger-registry.ts). Der Backfill ist ein UPDATE und
-- laeuft an beiden vorbei. Ein Bypass waere wirkungslos und wuerde nur fuer die
-- Dauer der Transaktion den Loeschschutz abschalten.
--
-- Vorher: Backup ziehen (docs/pre-publish-backup-runbook.md).

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Spalte — exakt wie migrations/0001_right_scrambler.sql:
--     timestamptz, NULLABLE, KEIN Default.
--     Nullable ist Absicht: NULL heisst "nie ausgegeben"; der Backfill unten
--     setzt die Marke nur dort, wo sie fachlich gilt (GoBD: keine pauschale
--     Mutation auf historische Datensaetze).
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS issued_at timestamp with time zone;

-- ---------------------------------------------------------------------------
-- (1b) Nummernkreis-Tabelle aus demselben Merge. Sie ist Teil des #66-Schritts
--      und wird vom Backfill unten befuellt — fehlt sie, scheitert (2b).
--      Ersetzt die fruehere Ableitung `MAX(...) + 1` ueber die verbliebenen
--      Zeilen als Quelle der naechsten Belegnummer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_number_sequence (
  billing_year integer PRIMARY KEY NOT NULL,
  last_number  integer NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- (2) Backfill — 1:1 aus server/startup/backfill-invoice-issued-at.ts.
--
--     Anker bewusst COALESCE(sent_at, storniert_at, paid_at, created_at) und
--     NICHT now(): sonst behauptet das Protokoll eine Ausgabe zum
--     Migrationszeitpunkt. `created_at` ist die letzte Rueckfallebene.
--
--     Ohne diesen Schritt waere der Loeschschutz fuer den GESAMTEN Bestand ein
--     No-op (issued_at ueberall NULL) und der Bestand verloere gleichzeitig den
--     Korrekturweg: `versendet -> entwurf` ist entfernt, und das
--     Fehlmarkierungs-Ventil lehnt eine Rechnung ohne Marke ab.
-- ---------------------------------------------------------------------------
UPDATE invoices
   SET issued_at = COALESCE(sent_at, storniert_at, paid_at, created_at)
 WHERE issued_at IS NULL
   AND status <> 'entwurf';

-- ---------------------------------------------------------------------------
-- (2b) Hochwassermarke je Jahr deterministisch verankern. `GREATEST` sorgt
--      dafuer, dass ein bereits hoeher stehender Zaehler nie zurueckfaellt.
-- ---------------------------------------------------------------------------
INSERT INTO invoice_number_sequence (billing_year, last_number, updated_at)
SELECT billing_year,
       COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'RE-\d{4}-(\d+)') AS INTEGER)), 0),
       now()
  FROM invoices
 GROUP BY billing_year
ON CONFLICT (billing_year) DO UPDATE
  SET last_number = GREATEST(invoice_number_sequence.last_number, EXCLUDED.last_number),
      updated_at  = now();

-- ---------------------------------------------------------------------------
-- (3) Trigger-Funktion — 1:1 aus server/startup/trigger-registry.ts
--     (GOBD_INVOICES_PREVENT_FINALIZED_DELETE_FN_SQL).
--
--     `CREATE OR REPLACE` taucht die bestehende Funktion aus; der bereits
--     haengende Trigger zeigt weiter auf sie. Das DROP/CREATE TRIGGER darunter
--     ist nur die Absicherung fuer den Fall, dass er auf Prod gar nicht haengt.
--
--     NICHT mitziehen: `invoice_line_items_prevent_finalized_mutation` feuert
--     auf UPDATE UND DELETE und gated am Eltern-Status. Dieselbe
--     `issued_at`-Bedingung dort wuerde die Positionen einer per Ventil wieder
--     bearbeitbaren Rechnung sperren — also genau das blockieren, wofuer das
--     Ventil da ist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoices_prevent_finalized_delete()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_gobd_mutation', true) = 'on' THEN
    RETURN OLD;
  END IF;
  -- Zwei Gruende, eine Sperre:
  --   status <> 'entwurf'      -- finalisiert, war nie loeschbar
  --   issued_at IS NOT NULL    -- je ausgegeben (#66)
  --
  -- Der zweite Zweig existiert, weil 'entwurf' seit dem
  -- Fehlmarkierungs-Ventil NICHT mehr 'nie ausgegeben' heisst. Eine
  -- ausgegebene Rechnung kann wieder im Entwurfsstatus stehen; ohne diesen
  -- Zweig faellt fuer genau sie das DB-seitige Netz weg und die
  -- Anwendungsschicht waere die einzige Lage. Jetzt faengt der Trigger auch
  -- rohes SQL und psql.
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

-- ===========================================================================
-- NACH dem COMMIT ausfuehren (rein lesend) — bestaetigt den Schritt UND prueft
-- in einem Zug, ob eine zweite Drift dahinter wartet: `getInvoices` ist nur der
-- erste Schritt der drei kaputten Endpunkte, direkt danach laeuft
-- `getClaimedInvoiceIds` gegen die Qonto-Tabellen.
-- Erwartet: 6 Zeilen. Fehlt eine, ist das die naechste Luecke.
-- ===========================================================================
-- SELECT table_name, column_name
--   FROM information_schema.columns
--  WHERE (table_name, column_name) IN (
--          ('invoices','issued_at'),
--          ('qonto_transactions','matched_payment_advice_id'),
--          ('qonto_transactions','matched_invoice_id'),
--          ('qonto_transactions','billing_irrelevant_at'),
--          ('payment_advices','deleted_at'),
--          ('payment_advice_items','matched_invoice_id'))
--  ORDER BY 1,2;
--
-- SELECT to_regclass('invoice_number_sequence') AS sequenz_tabelle;   -- nicht NULL
-- SELECT count(*) FILTER (WHERE issued_at IS NULL AND status <> 'entwurf') AS ungemarkt
--   FROM invoices;                                                    -- muss 0 sein
