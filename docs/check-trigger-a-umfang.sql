-- =====================================================================
-- MESSUNG (read-only) — Umfang von Trigger A des Deaktivierungs-Guards
-- Ticket 6hWcjpm3Q4V95Xwp · Weiche W2 (Alrik, 16.09.2026)
--
-- ── Die Frage ────────────────────────────────────────────────────────
-- Wie viele AKTIVE Kunden wuerden beim Deaktivieren an Trigger A
-- haengen? Trigger A ist der EINZIGE harte Riegel des Guards; B und C
-- sind nur Hinweise. Die Zahl entscheidet, ob der Riegel ein
-- Sicherheitsnetz ist oder eine Bremse.
--
-- STOPP-GRENZE: 20. Darueber nicht scharfschalten, sondern zurueck an
-- Alrik.
--
-- ── Was Trigger A ist ────────────────────────────────────────────────
--   Leistungsnachweis mit `status IN ('pending','employee_signed')`
--   UND `customer_signed_at IS NULL`
--
-- KEIN Kundenklassen-Filter. Weiche W2: die Kundenunterschrift ist
-- nicht nur Kassen-Compliance, sondern auch operatives Kunden-Review —
-- der Kunde bestaetigt die erhaltene Leistung, unabhaengig vom
-- Zahlungsweg. Selbstzahler zaehlen also mit, obwohl ihr
-- `employee_signed`-Nachweis bereits abrechenbar waere.
--
-- Block 3 weist die Aufteilung nach Zahler trotzdem aus — nicht als
-- Filter, sondern damit sichtbar ist, welcher Anteil der Zahl aus der
-- Entscheidung W2 kommt und welcher ohnehin angefallen waere.
--
-- ── Art und Aufruf ───────────────────────────────────────────────────
-- AUSSCHLIESSLICH LESEND. Nur SELECT, read only, ROLLBACK am Ende.
-- Doppelt abgesichert: PGOPTIONS beim Aufruf + SET TRANSACTION READ ONLY.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$PROD_DATABASE_URL" -f docs/check-trigger-a-umfang.sql
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset border 2
\timing off

BEGIN;
SET TRANSACTION READ ONLY;

\echo ''
\echo '=== 0 — GUARD: deckt diese DB die Frage ueberhaupt ab? ==============='
-- Abbruch statt einer plausibel aussehenden Null: eine DB ohne
-- Leistungsnachweise liefert „0 betroffene Kunden", und das liest sich
-- wie eine Freigabe.
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM monthly_service_records WHERE deleted_at IS NULL)
    THEN 'ABBRUCH: keine Leistungsnachweise — diese DB deckt die Klasse nicht ab'
  WHEN NOT EXISTS (SELECT 1 FROM customers WHERE deleted_at IS NULL AND status = 'aktiv')
    THEN 'ABBRUCH: keine aktiven Kunden — Grundmenge leer'
  ELSE 'OK — Praemissen erfuellt'
END AS guard;

\echo ''
\echo '=== 1 — DIE ZAHL: aktive Kunden mit Trigger A ======================='
\echo '--- STOPP, wenn betroffen > 20 -------------------------------------'
SELECT
  count(*)                                                AS aktive_kunden_gesamt,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM monthly_service_records r
    WHERE r.customer_id = c.id
      AND r.deleted_at IS NULL
      AND r.status IN ('pending', 'employee_signed')
      AND r.customer_signed_at IS NULL
  ))                                                      AS betroffen_trigger_a,
  round(100.0 * count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM monthly_service_records r
    WHERE r.customer_id = c.id
      AND r.deleted_at IS NULL
      AND r.status IN ('pending', 'employee_signed')
      AND r.customer_signed_at IS NULL
  )) / NULLIF(count(*), 0), 1)                             AS prozent
FROM customers c
WHERE c.deleted_at IS NULL
  AND c.status = 'aktiv';

\echo ''
\echo '=== 2 — JE KUNDE: wer haengt dran, mit wie vielen Nachweisen ========'
\echo '--- Keine Namen, nur IDs — die Liste ist Arbeitsvorrat, kein Bericht -'
SELECT c.id                                               AS kunde_id,
       c.billing_type,
       count(r.id)                                        AS nachweise_offen,
       min(make_date(r.year, r.month, 1))                 AS aeltester_monat,
       max(make_date(r.year, r.month, 1))                 AS juengster_monat,
       count(*) FILTER (WHERE r.status = 'pending')        AS davon_pending,
       count(*) FILTER (WHERE r.status = 'employee_signed') AS davon_employee_signed
FROM customers c
JOIN monthly_service_records r
  ON r.customer_id = c.id
 AND r.deleted_at IS NULL
 AND r.status IN ('pending', 'employee_signed')
 AND r.customer_signed_at IS NULL
WHERE c.deleted_at IS NULL
  AND c.status = 'aktiv'
GROUP BY c.id, c.billing_type
ORDER BY count(r.id) DESC, c.id;

\echo ''
\echo '=== 3 — HERKUNFT DER ZAHL: welcher Anteil kommt aus Weiche W2? ======'
\echo '--- Selbstzahler zaehlen laut W2 MIT. Kein Filter, nur Ausweis. -----'
SELECT CASE
         WHEN c.billing_type IN ('pflegekasse_gesetzlich', 'pflegekasse_privat')
           THEN 'Pflegekasse (haette ohnehin geblockt)'
         ELSE 'Selbstzahler o.ae. (zaehlt erst durch W2 mit)'
       END                                                AS klasse,
       count(DISTINCT c.id)                               AS kunden
FROM customers c
JOIN monthly_service_records r
  ON r.customer_id = c.id
 AND r.deleted_at IS NULL
 AND r.status IN ('pending', 'employee_signed')
 AND r.customer_signed_at IS NULL
WHERE c.deleted_at IS NULL
  AND c.status = 'aktiv'
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 4 — GEGENPROBE: Altbestand `completed` ohne Zeitstempel ========='
\echo '--- Erwartet 0. Ist es nicht 0, ist Trigger A zu eng gefasst. ------'
-- Offener Befund aus dem Gate-2-Review: Trigger A ist die Schnittmenge
-- aus Status UND fehlendem Zeitstempel. Ein `completed`-Nachweis ohne
-- `customer_signed_at` faellt durch. Laut Schreibpfad kann das nicht
-- entstehen (`completed` wird nur mit Zeitstempel gesetzt) — hier wird
-- es gemessen statt geglaubt.
SELECT count(*)                       AS completed_ohne_zeitstempel,
       count(DISTINCT r.customer_id)  AS betroffene_kunden
FROM monthly_service_records r
WHERE r.deleted_at IS NULL
  AND r.status = 'completed'
  AND r.customer_signed_at IS NULL;

\echo ''
\echo '=== 5 — KONTEXT: dieselbe Frage fuer INAKTIVE Kunden ================'
\echo '--- Der Altbestand, den der Guard rueckwirkend nicht einfaengt ------'
SELECT count(DISTINCT c.id) AS inaktive_kunden_mit_trigger_a
FROM customers c
JOIN monthly_service_records r
  ON r.customer_id = c.id
 AND r.deleted_at IS NULL
 AND r.status IN ('pending', 'employee_signed')
 AND r.customer_signed_at IS NULL
WHERE c.deleted_at IS NULL
  AND c.status <> 'aktiv';

ROLLBACK;

\echo ''
\echo '=== FERTIG — Transaktion zurueckgerollt, nichts geschrieben ========='
