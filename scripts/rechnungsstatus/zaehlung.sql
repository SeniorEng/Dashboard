-- ============================================================================
-- Rechnungsstatus-Umbau — ZÄHLUNG gegen den aktuellen Prod-Stand
--
-- READ-ONLY. Kein INSERT/UPDATE/DELETE, keine Transaktion nötig.
-- Ausführen auf PRODUKTIV (Replit), Ergebnis zurück an die Box.
--
-- ZWECK: Die Ziel-Spec (`docs/rechnungsstatus-zielmodell.md`) steht auf Zahlen
-- aus der pseudonymisierten Referenz-Kopie vom 13.08.2026. Bevor die Migration
-- gebaut wird, muss dieselbe Zählung auf Produktion bestätigen, dass die
-- Grundlage noch stimmt.
--
-- ERWARTUNG (Referenz-Kopie, 13.08.2026) — Abweichungen MELDEN, nicht
-- wegdiskutieren:
--
--   status         | typ            | Zeilen | sent_at
--   ---------------+----------------+--------+--------
--   versendet      | rechnung       |    172 | 172
--   storniert      | rechnung       |    110 |  69
--   entwurf        | stornorechnung |    114 |   0
--   bezahlt        | rechnung       |     73 |  73
--   avis_erhalten  | rechnung       |     54 |  54
--   entwurf        | rechnung       |     10 |   0
--   storniert      | nachberechnung |      4 |   0
--   teilweise_bez. | —              |      0 |   —
--
-- Prod ist seit dem 13.08. weitergelaufen. ABSOLUTE Abweichungen sind normal
-- (es wurde weiter abgerechnet). Was gemeldet werden MUSS, sind
-- STRUKTURELLE Abweichungen — Block (F) sucht genau die.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (A) VERTEILUNG NACH STATUS
--     Eine Zeile je Wert. `teilweise_bezahlt` und jeder unbekannte Wert
--     erscheinen hier ebenfalls — die Spec setzt voraus, dass es nur die
--     sechs bekannten gibt.
-- ---------------------------------------------------------------------------
SELECT
  status,
  count(*)                        AS zeilen,
  sum(gross_amount_cents) / 100.0 AS brutto_euro,
  count(*) FILTER (WHERE sent_at IS NOT NULL) AS mit_sent_at,
  count(*) FILTER (WHERE paid_at IS NOT NULL) AS mit_paid_at
FROM invoices
GROUP BY status
ORDER BY count(*) DESC;

-- ---------------------------------------------------------------------------
-- (B) VERTEILUNG NACH TYP — inklusive der historischen `nachberechnung`
--
--     Die Spec fasst `nachberechnung` NICHT an (GoBD-Immutabilität, Spalte ist
--     `text`, keine Enum-Migration). Diese Zählung sagt nur, wie groß der
--     Altbestand ist, damit niemand ihn versehentlich für abwesend hält.
-- ---------------------------------------------------------------------------
SELECT
  invoice_type,
  count(*)                        AS zeilen,
  sum(gross_amount_cents) / 100.0 AS brutto_euro
FROM invoices
GROUP BY invoice_type
ORDER BY count(*) DESC;

-- ---------------------------------------------------------------------------
-- (C) DIE EIGENTLICHE GRUNDLAGE — Status × Typ
--     Aus dieser Kreuztabelle folgt die Migrations-Abbildung. Sie ist der
--     Vergleichspunkt zur Erwartungstabelle im Kopf.
-- ---------------------------------------------------------------------------
SELECT
  status,
  invoice_type,
  count(*)                                    AS zeilen,
  sum(gross_amount_cents) / 100.0             AS brutto_euro,
  count(*) FILTER (WHERE sent_at IS NOT NULL)  AS mit_sent_at,
  count(*) FILTER (WHERE paid_at IS NOT NULL)  AS mit_paid_at,
  count(*) FILTER (WHERE pdf_path IS NOT NULL) AS mit_pdf
FROM invoices
GROUP BY status, invoice_type
ORDER BY invoice_type, status;

-- ---------------------------------------------------------------------------
-- (D) MIGRATIONS-VORSCHAU — wie viele Zeilen trifft jede Abbildung?
--
--     Genau die drei Abbildungen aus der Spec. Alles andere bleibt unverändert
--     und taucht deshalb hier nicht auf.
-- ---------------------------------------------------------------------------
SELECT
  'avis_erhalten -> versendet'                       AS abbildung,
  count(*)                                           AS zeilen,
  sum(gross_amount_cents) / 100.0                    AS brutto_euro,
  count(*) FILTER (WHERE paid_at IS NOT NULL)        AS mit_paid_at_ABWEICHUNG
FROM invoices WHERE status = 'avis_erhalten'
UNION ALL
SELECT
  'teilweise_bezahlt -> versendet + Badge',
  count(*),
  sum(gross_amount_cents) / 100.0,
  count(*) FILTER (WHERE paid_at IS NOT NULL)
FROM invoices WHERE status = 'teilweise_bezahlt'
UNION ALL
SELECT
  'stornorechnung/entwurf -> abgeschlossen',
  count(*),
  sum(gross_amount_cents) / 100.0,
  count(*) FILTER (WHERE paid_at IS NOT NULL)
FROM invoices WHERE invoice_type = 'stornorechnung' AND status = 'entwurf';

-- `mit_paid_at_ABWEICHUNG` muss ÜBERALL 0 sein. Eine Zeile mit Zahlungsdatum,
-- die auf `versendet` bzw. `abgeschlossen` gehoben wird, verlöre eine Aussage.

-- ---------------------------------------------------------------------------
-- (E) SANITY-CHECKS — die Annahmen der Spec, einzeln nachgerechnet
-- ---------------------------------------------------------------------------

-- (E1) Die „114": Storno-Dokumente auf `entwurf`. Die Spec begründet ihren
--      neuen Endzustand damit, dass sie NIE VERSANDT (sent_at NULL), aber
--      FERTIG ERZEUGT (pdf_path gesetzt) sind und ihr Original bereits
--      storniert ist. Alle drei Spalten müssen die Erwartung treffen.
SELECT
  count(*)                                                        AS storno_auf_entwurf,
  count(*) FILTER (WHERE s.sent_at IS NULL)                        AS davon_nie_versandt,
  count(*) FILTER (WHERE s.pdf_path IS NOT NULL)                   AS davon_mit_pdf,
  count(*) FILTER (WHERE s.stornierte_rechnung_id IS NOT NULL)     AS davon_mit_original,
  count(*) FILTER (WHERE o.status = 'storniert')                   AS davon_original_storniert,
  sum(s.gross_amount_cents) / 100.0                                AS brutto_euro
FROM invoices s
LEFT JOIN invoices o ON o.id = s.stornierte_rechnung_id
WHERE s.invoice_type = 'stornorechnung' AND s.status = 'entwurf';

-- (E2) Ist `teilweise_bezahlt` weiterhin leer? Die Spec nennt den Fall
--      „latent". Ist er inzwischen eingetreten, ändert das die Dringlichkeit
--      von W1 (falsche EUR-Summe im Cockpit-Board) — melden.
SELECT count(*) AS teilweise_bezahlt_zeilen FROM invoices WHERE status = 'teilweise_bezahlt';

-- (E3) Die Storno-EUR-Summe, die nach Abschnitt 4.4 ausgeschlossen bleiben
--      MUSS. Auf der Referenz-Kopie: −15.884,35 €.
--      Zum Vergleich daneben die Summe der Stufe `versendet` — sie zeigt, um
--      wie viel die Anzeige falsch würde, wenn die Regel beim Umbau verloren
--      geht.
SELECT
  (SELECT sum(gross_amount_cents) / 100.0 FROM invoices
    WHERE invoice_type = 'stornorechnung')                 AS storno_summe_auszuschliessen,
  (SELECT sum(gross_amount_cents) / 100.0 FROM invoices
    WHERE status = 'versendet' AND invoice_type <> 'stornorechnung') AS stufe_versendet_heute;

-- ---------------------------------------------------------------------------
-- (F) STRUKTURELLE ABWEICHUNGEN — hier MUSS alles leer sein
--
--     Absolute Zahlen dürfen von der Referenz-Kopie abweichen (Prod läuft
--     weiter). Diese Abfrage sucht dagegen Zeilen, die die Spec-ANNAHMEN
--     brechen. Kommt hier auch nur eine Zeile, ist die Grundlage der Spec
--     nicht mehr vollständig — dann NICHT bauen, sondern zurück an die Box.
--
--     Gegen die Referenz-Kopie liefert der Block 0 Zeilen. Damit er nicht als
--     „still und immer leer" durchgeht, wurde er dort mit INVERTIERTEN
--     Bedingungen gegengeprüft: dieselbe Abfrageform findet dann 342 Zeilen.
--     Der Block misst also, er schweigt nur.
-- ---------------------------------------------------------------------------
SELECT * FROM (
  -- Unbekannter Status: die Spec kennt genau sechs Altwerte.
  SELECT 'unbekannter status'::text AS befund, id, invoice_number, status, invoice_type
    FROM invoices
   WHERE status NOT IN ('entwurf','versendet','avis_erhalten','teilweise_bezahlt','bezahlt','storniert')

  UNION ALL
  -- Unbekannter Typ.
  SELECT 'unbekannter typ', id, invoice_number, status, invoice_type
    FROM invoices
   WHERE invoice_type NOT IN ('rechnung','stornorechnung','nachberechnung')

  UNION ALL
  -- Storno-Dokument, das NICHT auf `entwurf` steht: die Spec setzt voraus,
  -- dass alle dort stehen (nur dann ist die Abbildung vollständig).
  SELECT 'stornorechnung nicht auf entwurf', id, invoice_number, status, invoice_type
    FROM invoices
   WHERE invoice_type = 'stornorechnung' AND status <> 'entwurf'

  UNION ALL
  -- Storno-Dokument mit sent_at: dann wäre „nie versandt" falsch, und die
  -- Migration dürfte sent_at nicht pauschal auf NULL belassen.
  SELECT 'stornorechnung MIT sent_at', id, invoice_number, status, invoice_type
    FROM invoices
   WHERE invoice_type = 'stornorechnung' AND sent_at IS NOT NULL

  UNION ALL
  -- Storno-Dokument ohne Original: die Begründung „der Vorgang ist am Original
  -- verbucht" trägt dann nicht.
  SELECT 'stornorechnung ohne original', id, invoice_number, status, invoice_type
    FROM invoices
   WHERE invoice_type = 'stornorechnung' AND stornierte_rechnung_id IS NULL

  UNION ALL
  -- Storno-Dokument, dessen Original NICHT storniert ist — dann ist der
  -- Vorgang unvollständig verbucht.
  SELECT 'original nicht storniert', s.id, s.invoice_number, s.status, s.invoice_type
    FROM invoices s JOIN invoices o ON o.id = s.stornierte_rechnung_id
   WHERE s.invoice_type = 'stornorechnung' AND o.status <> 'storniert'

  UNION ALL
  -- Eine Zeile, die migriert würde und ein Zahlungsdatum trägt.
  SELECT 'migrationskandidat mit paid_at', id, invoice_number, status, invoice_type
    FROM invoices
   WHERE paid_at IS NOT NULL
     AND (status IN ('avis_erhalten','teilweise_bezahlt')
          OR (invoice_type = 'stornorechnung' AND status = 'entwurf'))
) abweichungen
ORDER BY befund, id;
