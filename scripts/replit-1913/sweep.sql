-- ============================================================================
-- SWEEP: Wird die Serien-Datums-Lücke in echten Daten getroffen?
--
-- READ-ONLY. Kein INSERT/UPDATE/DELETE.
--
-- ── Herkunft, damit niemand die Zahlen falsch liest ─────────────────────────
-- Anlass war Replit-#1913: ein Ticket über 13 angeblich rückwirkend abgesagte,
-- bereits geleistete Termine. Die Prüfung gegen Produktion hat das WIDERLEGT —
-- Urlaub, Verlegungen innerhalb desselben Tages, ein Betreuerwechsel und
-- Serien-Änderungen (alter Termin abgesagt, neuer angelegt) erklären alle 13.
-- Die betroffene Mitarbeiterin hat bestätigt, dass kein Besuch fehlt. Es war
-- ein Fehlalarm.
--
-- Die LÜCKE im Code ist davon unberührt und wird separat geschlossen
-- (`seriesBulkFloorDate`). Dieser Sweep beantwortet die verbleibende Frage:
-- hat sie irgendwo sonst zugeschlagen, bevor der Boden greift?
--
-- ERWARTUNG: überwiegend normaler Betrieb. Ein Treffer wäre die Ausnahme.
--
-- ── Warum die Ausschlüsse hier drinstehen ──────────────────────────────────
-- Eine reine Signatur-Suche (cancelled + vergangen + unstartet + unsigniert +
-- kein LN + nicht berechnet) über-meldet massiv: sie trifft jede korrekte
-- Absage gleich mit. Bei den 13 waren 11 von 13 so erklärbar. Die Abfrage
-- rechnet deshalb dieselben drei Ausschlüsse gleich ein, die den Fehlalarm
-- aufgedeckt haben:
--
--   1. Kraft war an dem Tag im Urlaub oder krank
--   2. Kraft war zur selben Zeit bei jemand anderem
--   3. dieselbe Kundin wurde am selben Tag besucht (= verlegt, nicht verloren)
--
-- Was übrig bleibt, ist ein KANDIDAT, kein Urteil. Was die Abfrage nicht sehen
-- kann, ist der Betreuerwechsel — die häufigste unschuldige Erklärung für
-- einen ganzen abgesagten Serien-Block. Block (C) liefert dafür das Indiz.
--
-- ── Stichtage ──────────────────────────────────────────────────────────────
-- Vor dem jeweiligen Stichtag ist der Datenbestand aus dem Altsystem
-- übernommen; Absagen daraus sagen nichts über die Lücke. Ullmann, Wächtler
-- und Fiebag ab 01.05., alle anderen ab 01.06.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (A) KANDIDATEN — Signatur minus die drei Ausschlüsse, je Serie gebündelt
-- ---------------------------------------------------------------------------
WITH stichtag AS (
  SELECT u.id AS user_id,
         CASE
           WHEN u.display_name ILIKE '%Ullmann%'
             OR u.display_name ILIKE '%Wächtler%' OR u.display_name ILIKE '%Waechtler%'
             OR u.display_name ILIKE '%Fiebag%'   THEN DATE '2026-05-01'
           ELSE DATE '2026-06-01'
         END AS ab
  FROM users u
),
kandidat AS (
  SELECT a.*
  FROM appointments a
  JOIN stichtag st ON st.user_id = a.assigned_employee_id
  WHERE a.deleted_at IS NULL
    AND a.series_id IS NOT NULL
    AND a.status = 'cancelled'
    AND a.date >= st.ab
    AND a.date <  CURRENT_DATE
    AND a.actual_start IS NULL
    AND a.actual_end   IS NULL
    AND a.signed_at    IS NULL
    AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_line_items i        WHERE i.appointment_id = a.id)
    -- 1. Kraft abwesend
    AND NOT EXISTS (
      SELECT 1 FROM employee_time_entries e
       WHERE e.deleted_at IS NULL AND e.user_id = a.assigned_employee_id
         AND e.entry_date = a.date AND e.entry_type IN ('urlaub','krankheit'))
    -- 2. Kraft zur selben Zeit anderswo (oder derselbe Besuch unter anderer ID)
    AND NOT EXISTS (
      SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.id <> a.id AND o.status = 'completed'
         AND o.performed_by_employee_id = a.assigned_employee_id AND o.date = a.date
         AND o.scheduled_start < (a.scheduled_start + (a.duration_promised || ' minutes')::interval)
         AND (o.scheduled_start + (o.duration_promised || ' minutes')::interval) > a.scheduled_start)
    -- 3. dieselbe Kundin am selben Tag besucht -> verlegt, nicht verloren
    AND NOT EXISTS (
      SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.id <> a.id AND o.status = 'completed'
         AND o.customer_id = a.customer_id AND o.date = a.date)
    -- Und: die Kraft muss an dem Tag ueberhaupt gearbeitet haben. Sonst ist
    -- "der Termin fehlt" nicht von "sie hatte frei" zu unterscheiden.
    AND EXISTS (
      SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.status = 'completed'
         AND o.performed_by_employee_id = a.assigned_employee_id AND o.date = a.date)
)
SELECT
  k.series_id,
  u.display_name                  AS kraft,
  c.name                          AS kunde,
  count(*)                        AS kandidaten,
  min(k.date)                     AS von,
  max(k.date)                     AS bis,
  sum(k.duration_promised)        AS minuten,
  array_agg(k.id ORDER BY k.date) AS ids
FROM kandidat k
LEFT JOIN users     u ON u.id = k.assigned_employee_id
LEFT JOIN customers c ON c.id = k.customer_id
GROUP BY k.series_id, u.display_name, c.name
ORDER BY count(*) DESC, k.series_id;

-- ---------------------------------------------------------------------------
-- (B) EINE ZEILE — die Antwort auf „wie schlimm ist es?"
-- ---------------------------------------------------------------------------
WITH stichtag AS (
  SELECT u.id AS user_id,
         CASE
           WHEN u.display_name ILIKE '%Ullmann%'
             OR u.display_name ILIKE '%Wächtler%' OR u.display_name ILIKE '%Waechtler%'
             OR u.display_name ILIKE '%Fiebag%'   THEN DATE '2026-05-01'
           ELSE DATE '2026-06-01'
         END AS ab
  FROM users u
)
SELECT
  count(*) FILTER (WHERE roh)        AS signatur_roh,
  count(*) FILTER (WHERE kandidat)   AS nach_ausschluessen,
  sum(a.duration_promised) FILTER (WHERE kandidat) AS minuten_kandidaten
FROM (
  SELECT a.*,
    TRUE AS roh,
    NOT EXISTS (SELECT 1 FROM employee_time_entries e
       WHERE e.deleted_at IS NULL AND e.user_id = a.assigned_employee_id
         AND e.entry_date = a.date AND e.entry_type IN ('urlaub','krankheit'))
    AND NOT EXISTS (SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.id <> a.id AND o.status = 'completed'
         AND o.performed_by_employee_id = a.assigned_employee_id AND o.date = a.date
         AND o.scheduled_start < (a.scheduled_start + (a.duration_promised || ' minutes')::interval)
         AND (o.scheduled_start + (o.duration_promised || ' minutes')::interval) > a.scheduled_start)
    AND NOT EXISTS (SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.id <> a.id AND o.status = 'completed'
         AND o.customer_id = a.customer_id AND o.date = a.date)
    AND EXISTS (SELECT 1 FROM appointments o
       WHERE o.deleted_at IS NULL AND o.status = 'completed'
         AND o.performed_by_employee_id = a.assigned_employee_id AND o.date = a.date)
    AS kandidat
  FROM appointments a
  JOIN stichtag st ON st.user_id = a.assigned_employee_id
  WHERE a.deleted_at IS NULL
    AND a.series_id IS NOT NULL
    AND a.status = 'cancelled'
    AND a.date >= st.ab AND a.date < CURRENT_DATE
    AND a.actual_start IS NULL AND a.actual_end IS NULL AND a.signed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_line_items i        WHERE i.appointment_id = a.id)
) a;

-- ---------------------------------------------------------------------------
-- (C) BETREUERWECHSEL — das Indiz, das (A) nicht sehen kann.
--
--     Für jede Serie mit Kandidaten: betreut heute noch DIESELBE Kraft die
--     Kundin? Wenn nicht, ist der abgesagte Block mit hoher Wahrscheinlichkeit
--     die Folge eines Wechsels und kein Defekt — genau die Erklärung, die den
--     Fehlalarm aufgelöst hat.
-- ---------------------------------------------------------------------------
SELECT DISTINCT
  a.series_id,
  u.display_name  AS kraft_der_serie,
  p.display_name  AS kraft_heute_primaer,
  (a.assigned_employee_id = c.primary_employee_id) AS unveraendert
FROM appointments a
LEFT JOIN customers c ON c.id = a.customer_id
LEFT JOIN users u ON u.id = a.assigned_employee_id
LEFT JOIN users p ON p.id = c.primary_employee_id
WHERE a.deleted_at IS NULL
  AND a.series_id IS NOT NULL
  AND a.status = 'cancelled'
  AND a.date < CURRENT_DATE
ORDER BY a.series_id;
