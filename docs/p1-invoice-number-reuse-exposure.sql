-- ===========================================================================
-- P1-EXPOSURE-ABFRAGE — AUSSCHLIESSLICH LESEND
-- Nur SELECT/WITH. Kein INSERT/UPDATE/DELETE, keine DDL. Auf Prod gefahrlos.
-- Syntaktisch gegen das echte Schema geprueft (Wegwerf-DB), nicht auf Prod gefahren.
-- ===========================================================================

-- --------------------------------------------------------------------- A ---
WITH geloescht AS (
  SELECT a.id AS audit_id, a.created_at AS geloescht_am, a.user_id AS geloescht_von,
         a.entity_id AS geloeschte_rechnung_id,
         a.metadata ->> 'invoiceNumber' AS belegnummer,
         (a.metadata ->> 'grossAmountCents')::bigint AS betrag_cents_alt,
         a.metadata ->> 'reason' AS loesch_grund
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action      = 'invoice_draft_discarded'
    AND a.metadata ->> 'invoiceNumber' IS NOT NULL
)
SELECT g.belegnummer, g.geloescht_am, g.geloescht_von, g.loesch_grund,
       g.geloeschte_rechnung_id, g.betrag_cents_alt,
       i.id AS heutige_rechnung_id, i.created_at AS heute_erzeugt_am,
       i.gross_amount_cents AS betrag_cents_neu, i.status AS heutiger_status,
       i.customer_id,
       i.gross_amount_cents - g.betrag_cents_alt AS differenz_cents
FROM geloescht g
JOIN invoices i
  ON i.invoice_number = g.belegnummer
 AND i.id <> g.geloeschte_rechnung_id
ORDER BY g.geloescht_am DESC;

-- --------------------------------------------------------------------- B ---
WITH versendet AS (
  SELECT a.entity_id AS rechnung_id, MIN(a.created_at) AS erstversand_am,
         bool_or(a.action = 'invoice_sent') AS echter_versand
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action IN ('invoice_sent', 'invoice_marked_sent_manually')
  GROUP BY a.entity_id
),
zurueckgesetzt AS (
  SELECT a.entity_id AS rechnung_id, a.created_at AS zurueckgesetzt_am,
         a.user_id AS zurueckgesetzt_von,
         COALESCE(a.metadata ->> 'previousStatus', a.metadata ->> 'oldStatus') AS vorher,
         a.metadata ->> 'reason' AS pfad
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action      = 'invoice_status_changed'
    AND a.metadata ->> 'newStatus' = 'entwurf'
)
SELECT z.rechnung_id, i.invoice_number, v.erstversand_am, v.echter_versand,
       z.zurueckgesetzt_am, z.zurueckgesetzt_von, z.vorher,
       COALESCE(z.pfad, 'einzel_patch') AS pfad,
       (i.id IS NOT NULL) AS rechnung_existiert_noch,
       i.status AS heutiger_status, i.sent_at AS heutiges_sent_at
FROM zurueckgesetzt z
JOIN versendet v
  ON v.rechnung_id = z.rechnung_id
 AND z.zurueckgesetzt_am > v.erstversand_am
LEFT JOIN invoices i ON i.id = z.rechnung_id
ORDER BY z.zurueckgesetzt_am DESC;

-- --------------------------------------------------------------------- C ---
WITH versendet AS (
  SELECT a.entity_id AS rechnung_id, MIN(a.created_at) AS erstversand_am,
         bool_or(a.action = 'invoice_sent') AS echter_versand
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action IN ('invoice_sent', 'invoice_marked_sent_manually')
  GROUP BY a.entity_id
),
zurueckgesetzt AS (
  SELECT a.entity_id AS rechnung_id, a.created_at AS zurueckgesetzt_am
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action      = 'invoice_status_changed'
    AND a.metadata ->> 'newStatus' = 'entwurf'
),
geloescht AS (
  SELECT a.entity_id AS rechnung_id, a.created_at AS geloescht_am,
         a.user_id AS geloescht_von,
         a.metadata ->> 'invoiceNumber' AS belegnummer,
         (a.metadata ->> 'grossAmountCents')::bigint AS betrag_cents_alt,
         a.metadata ->> 'reason' AS loesch_grund
  FROM audit_log a
  WHERE a.entity_type = 'invoice'
    AND a.action      = 'invoice_draft_discarded'
)
SELECT d.belegnummer, d.rechnung_id AS urspruengliche_rechnung_id,
       v.erstversand_am, v.echter_versand, z.zurueckgesetzt_am,
       d.geloescht_am, d.geloescht_von, d.loesch_grund, d.betrag_cents_alt,
       EXISTS (SELECT 1 FROM invoices i2
               WHERE i2.invoice_number = d.belegnummer
                 AND i2.id <> d.rechnung_id) AS nummer_wiedervergeben
FROM geloescht d
JOIN versendet      v ON v.rechnung_id = d.rechnung_id
JOIN zurueckgesetzt z ON z.rechnung_id = d.rechnung_id
                      AND z.zurueckgesetzt_am > v.erstversand_am
                      AND z.zurueckgesetzt_am < d.geloescht_am
ORDER BY d.geloescht_am DESC;

-- --------------------------------------------------------------------- D ---
SELECT
  (SELECT count(*) FROM audit_log
     WHERE entity_type='invoice' AND action='invoice_draft_discarded')  AS loeschungen_gesamt,
  (SELECT count(*) FROM audit_log
     WHERE entity_type='invoice'
       AND action IN ('invoice_sent','invoice_marked_sent_manually'))   AS versand_ereignisse,
  (SELECT count(*) FROM audit_log
     WHERE entity_type='invoice' AND action='invoice_status_changed'
       AND metadata->>'newStatus'='entwurf')                            AS ruecksetzungen_auf_entwurf,
  (SELECT count(*) FROM invoices)                                       AS rechnungen_aktuell,
  (SELECT min(created_at) FROM audit_log)                               AS audit_log_beginnt_am;
