-- ============================================================================
-- Replit-#1913 — VERIFIKATION der 13 rückwirkend stornierten Termine
--
-- READ-ONLY. Kein INSERT/UPDATE/DELETE, keine Transaktion nötig.
-- Ausführen auf PRODUKTIV (Replit), Ergebnis zurück an die Box.
--
-- ZWECK: Die 13 IDs stammen aus der pseudonymisierten Referenz-DB und wurden
-- dort NUR über Anzahl, Datum und Dauer zugeordnet — die Namen sind
-- gescrubbt. Bevor irgendein Reparatur-Skript geschrieben wird, muss auf
-- Prod bestätigt sein, dass es dieselben Termine sind: gleiche Kraft,
-- gleicher Kunde, gleicher Zustand.
--
-- ERWARTUNG laut Ticket (wenn eine Zeile davon abweicht, NICHT reparieren):
--   * 13 Zeilen
--   * status = 'cancelled', deleted_at IS NULL
--   * actual_start IS NULL, actual_end IS NULL, signed_at IS NULL
--   * in KEINEM Leistungsnachweis, auf KEINER Rechnung
--   * 1080 Minuten, 684,00 EUR Leistungswert
--   * 3 Serien: 9 Termine (13.05.–29.07.), 3 Termine (13.07./20.07./27.07.),
--     1 Termin (20.05.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (A) ZEILE FÜR ZEILE — der eigentliche Abgleich
-- ---------------------------------------------------------------------------
SELECT
  a.id,
  a.date,
  a.scheduled_start,
  a.duration_promised                                   AS minuten,
  a.status,
  a.series_id,
  u.display_name                                        AS kraft,
  c.name                                                AS kunde,
  (a.actual_start IS NOT NULL)                          AS gestartet,
  (a.actual_end   IS NOT NULL)                          AS beendet,
  (a.signed_at    IS NOT NULL)                          AS signiert,
  (a.deleted_at   IS NOT NULL)                          AS geloescht,
  EXISTS (SELECT 1 FROM service_record_appointments s
           WHERE s.appointment_id = a.id)               AS im_leistungsnachweis,
  EXISTS (SELECT 1 FROM service_record_appointments s
            JOIN monthly_service_records m ON m.id = s.service_record_id
           WHERE s.appointment_id = a.id
             AND m.deleted_at IS NULL
             AND m.status IN ('employee_signed','completed'))  AS ln_gesperrt,
  EXISTS (SELECT 1 FROM invoice_line_items i
           WHERE i.appointment_id = a.id)               AS berechnet,
  EXISTS (SELECT 1 FROM budget_transactions t
           WHERE t.appointment_id = a.id)               AS budget_gebucht,
  EXISTS (SELECT 1 FROM budget_reservations r
           WHERE r.appointment_id = a.id AND r.state = 'hold') AS haelt_reservierung
FROM appointments a
LEFT JOIN users     u ON u.id = a.assigned_employee_id
LEFT JOIN customers c ON c.id = a.customer_id
WHERE a.id IN (915, 917, 918, 919, 922, 923, 924, 925, 926,   -- Serie 6,  9 Termine
               1123,                                          -- Serie 12, 1 Termin
               1754, 1755, 1756)                              -- Serie 18, 3 Termine
ORDER BY a.series_id, a.date;

-- ---------------------------------------------------------------------------
-- (B) SUMMENPROBE — muss die Ticket-Zahlen treffen
--     Erwartet: anzahl = 13, minuten = 1080, serien = 3
-- ---------------------------------------------------------------------------
SELECT
  count(*)                                              AS anzahl,
  sum(a.duration_promised)                              AS minuten,
  count(DISTINCT a.series_id)                           AS serien,
  count(*) FILTER (WHERE a.status <> 'cancelled')       AS nicht_storniert_ABWEICHUNG,
  count(*) FILTER (WHERE a.deleted_at IS NOT NULL)      AS geloescht_ABWEICHUNG,
  count(*) FILTER (WHERE a.actual_start IS NOT NULL
                      OR a.actual_end   IS NOT NULL
                      OR a.signed_at    IS NOT NULL)    AS angefasst_ABWEICHUNG
FROM appointments a
WHERE a.id IN (915,917,918,919,922,923,924,925,926,1123,1754,1755,1756);

-- ---------------------------------------------------------------------------
-- (C) GEGENPROBE — findet die Abfrage dieselben 13, wenn man sie NICHT über
--     IDs sucht, sondern über die Ticket-Beschreibung?
--
--     Wenn (C) mehr oder andere Zeilen liefert als (A), ist die ID-Liste
--     unvollständig oder falsch — dann NICHT reparieren, sondern zurück an
--     die Box.
--
--     ACHTUNG — GRENZE dieser Abfrage, im Trockenlauf gegen die Referenz-DB
--     gemessen: sie ueberzeichnet stark (dort 18 Gruppen statt 3). Grund: das
--     unterscheidende Merkmal ist "war der Termin ZUM ZEITPUNKT DER ABSAGE
--     bereits vergangen" — nicht "liegt heute in der Vergangenheit". Ein im
--     Juni beendetes Serien-Abo storniert Juli-/August-Termine voellig
--     korrekt; die sind heute ebenfalls vergangen und tauchen hier mit auf.
--
--     Der Absage-ZEITPUNKT ist nicht rekonstruierbar: einen Audit-Eintrag
--     (`appointment_cancelled`) gibt es erst ab PR #100, die 13 sind aelter.
--     Diese Abfrage ist deshalb KEIN Beweis fuer die Vollstaendigkeit der
--     ID-Liste, sondern nur ein Suchraum: sie zeigt, WO ueberall rueckwirkend
--     storniert wurde. Die Zuordnung zu den 13 macht der Mensch anhand von
--     Kraft + Kundin + Zeitraum aus dem Ticket.
-- ---------------------------------------------------------------------------
SELECT
  a.series_id,
  u.display_name          AS kraft,
  c.name                  AS kunde,
  count(*)                AS termine,
  min(a.date)             AS von,
  max(a.date)             AS bis,
  sum(a.duration_promised) AS minuten,
  array_agg(a.id ORDER BY a.date) AS ids
FROM appointments a
LEFT JOIN users     u ON u.id = a.assigned_employee_id
LEFT JOIN customers c ON c.id = a.customer_id
WHERE a.deleted_at IS NULL
  AND a.series_id IS NOT NULL
  AND a.status = 'cancelled'
  AND a.actual_start IS NULL
  AND a.actual_end   IS NULL
  AND a.signed_at    IS NULL
  AND a.date < CURRENT_DATE                    -- rückwirkend storniert
  AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_line_items i WHERE i.appointment_id = a.id)
GROUP BY 1, 2, 3
ORDER BY 4 DESC, 1;

-- ---------------------------------------------------------------------------
-- (D) SPERR-VORPRÜFUNG — genau die Guards, die das Reparatur-Skript später
--     anwenden wird. Alles hier MUSS leer sein; jede Zeile ist ein Termin,
--     den das Skript überspringen müsste.
-- ---------------------------------------------------------------------------
SELECT a.id, a.date,
       CASE
         WHEN a.deleted_at IS NOT NULL                              THEN 'geloescht'
         WHEN a.status <> 'cancelled'                               THEN 'nicht mehr storniert: ' || a.status
         WHEN EXISTS (SELECT 1 FROM service_record_appointments s
                        JOIN monthly_service_records m ON m.id = s.service_record_id
                       WHERE s.appointment_id = a.id AND m.deleted_at IS NULL
                         AND m.status IN ('employee_signed','completed'))
                                                                    THEN 'auf unterschriebenem Leistungsnachweis'
         WHEN EXISTS (SELECT 1 FROM invoice_line_items i WHERE i.appointment_id = a.id)
                                                                    THEN 'abgerechnet'
       END AS blocker
FROM appointments a
WHERE a.id IN (915,917,918,919,922,923,924,925,926,1123,1754,1755,1756)
  AND (
    a.deleted_at IS NOT NULL
    OR a.status <> 'cancelled'
    OR EXISTS (SELECT 1 FROM service_record_appointments s
                 JOIN monthly_service_records m ON m.id = s.service_record_id
                WHERE s.appointment_id = a.id AND m.deleted_at IS NULL
                  AND m.status IN ('employee_signed','completed'))
    OR EXISTS (SELECT 1 FROM invoice_line_items i WHERE i.appointment_id = a.id)
  );

-- ---------------------------------------------------------------------------
-- (E) MONATSABSCHLUSS — das Skript darf einen geschlossenen Monat nicht
--     aufbrechen. Zeigt je Termin, ob sein Monat fuer seine Kraft zu ist.
--
--     BEFUND aus dem Trockenlauf gegen die Referenz-DB: dort sind ALLE 13 in
--     einem geschlossenen Monat. Wenn das auf Prod genauso ist, wuerde ein
--     Undo, das den Monatsabschluss respektiert (so will es das Ticket),
--     saemtliche 13 ueberspringen — die Reparatur liefe ins Leere.
--
--     ENTSCHIEDEN (Alrik, 17.08.2026): die betroffenen Mitarbeiter-Monate
--     werden von der GF FORMAL wieder geoeffnet — auditierbar. KEIN Override
--     im Skript. Ein Skript, das sich still ueber einen Monatsabschluss
--     hinwegsetzt, waere genau die stille Schreiboperation, gegen die der
--     ganze Vorgang laeuft.
--
--     Diese Abfrage sagt also, WELCHE Monate zu oeffnen sind. Erwartet nach
--     dem Trockenlauf gegen die Referenz-Kopie: Kraft 11 Mai+Juni+Juli,
--     Kraft 24 Mai, Kraft 21 Juli. Weicht Prod davon ab, gilt Prod.
--
--     Ablauf danach: Monate oeffnen -> Trockenlauf -> Freigabe -> --apply ->
--     Mitarbeiterinnen dokumentieren -> Monate wieder schliessen.
-- ---------------------------------------------------------------------------
SELECT a.id, a.date, a.assigned_employee_id,
       EXISTS (SELECT 1 FROM employee_month_closings mc
                WHERE mc.user_id = a.assigned_employee_id
                  AND mc.year  = EXTRACT(YEAR  FROM a.date)::int
                  AND mc.month = EXTRACT(MONTH FROM a.date)::int
                  AND mc.reopened_at IS NULL)                     AS monat_geschlossen
FROM appointments a
WHERE a.id IN (915,917,918,919,922,923,924,925,926,1123,1754,1755,1756)
ORDER BY a.date;

-- ---------------------------------------------------------------------------
-- (F) SIND ES ÜBERHAUPT 13? — Gegenprüfung gegen Abwesenheit und Kollision
--
--     Diese Abfrage ist NACHTRÄGLICH entstanden, aus der Lohn-Frage heraus, und
--     sie stellt die Prämisse des Tickets in Frage. Gegen die Referenz-Kopie
--     gemessen sind von den 13 nur drei eindeutig „geleistet und verloren".
--
--     Zwei Ausschluss-Gründe, beide hier geprüft:
--
--     1. ABWESEND. War die Kraft an dem Tag im Urlaub oder krank, kann der
--        Termin nicht stattgefunden haben. Die Absage war dann richtig, und ein
--        Zurückholen erzeugte einen Termin, den niemand dokumentieren kann.
--
--     2. KOLLISION mit einem GELEISTETEN Termin zur selben Zeit. Die Kraft kann
--        nicht an zwei Orten sein. Zwei Unterfälle, und der Unterschied
--        entscheidet:
--          - SELBER Kunde  -> der Besuch HAT stattgefunden, nur unter einer
--            anderen Termin-ID. Das ist die Handschrift einer Serien-ÄNDERUNG
--            (alter Termin abgesagt, neuer angelegt), nicht die eines Verlusts.
--            Zurückholen wäre hier aktiv schädlich: doppelte Leistung, bei
--            Abrechnung doppelte Belastung der Kundin.
--          - ANDERER Kunde -> die Kraft war anderswo. Der abgesagte Besuch fand
--            nicht statt.
--
--     Nur was WEDER abwesend NOCH kollidierend ist und wo die Kraft an dem Tag
--     nachweislich gearbeitet hat, ist ein Opfer im Sinne des Tickets.
-- ---------------------------------------------------------------------------
SELECT
  a.id, a.date, a.assigned_employee_id AS kraft, a.scheduled_start, a.customer_id AS kunde,
  (SELECT e.entry_type FROM employee_time_entries e
    WHERE e.deleted_at IS NULL AND e.user_id = a.assigned_employee_id
      AND e.entry_date = a.date AND e.entry_type IN ('urlaub','krankheit') LIMIT 1) AS abwesend,
  k.id            AS kollidiert_mit,
  k.customer_id   AS kunde_der_kollision,
  (a.customer_id = k.customer_id) AS selber_kunde,
  (SELECT count(*) FROM appointments o
    WHERE o.deleted_at IS NULL AND o.performed_by_employee_id = a.assigned_employee_id
      AND o.date = a.date AND o.status = 'completed') AS geleistet_am_tag,
  -- Besuch bei DERSELBEN Kundin am selben Tag, egal zu welcher Uhrzeit.
  -- Diese Spalte fehlte zuerst, und ohne sie war der Befund falsch: Termin 919
  -- (Mi 15:00) galt als Opfer, obwohl dieselbe Kundin am selben Tag um 11:00
  -- besucht wurde. Die Absage war die FOLGE einer Verlegung, kein Verlust.
  -- Eine reine Zeit-Ueberlappungspruefung sieht das nicht — 11:00-11:45
  -- ueberlappt 15:00-16:30 nicht.
  (SELECT o.id FROM appointments o
    WHERE o.deleted_at IS NULL AND o.id <> a.id
      AND o.customer_id = a.customer_id AND o.date = a.date
      AND o.status = 'completed' LIMIT 1) AS besuch_selber_tag,
  CASE
    WHEN (SELECT 1 FROM employee_time_entries e
           WHERE e.deleted_at IS NULL AND e.user_id = a.assigned_employee_id
             AND e.entry_date = a.date AND e.entry_type IN ('urlaub','krankheit') LIMIT 1) IS NOT NULL
      THEN 'KEIN OPFER — Kraft war abwesend'
    WHEN k.id IS NOT NULL AND a.customer_id = k.customer_id
      THEN 'KEIN OPFER — Besuch fand statt, andere Termin-ID (Serien-Aenderung)'
    WHEN k.id IS NOT NULL
      THEN 'KEIN OPFER — Kraft war zur selben Zeit bei anderer Kundin'
    WHEN (SELECT 1 FROM appointments o
           WHERE o.deleted_at IS NULL AND o.id <> a.id
             AND o.customer_id = a.customer_id AND o.date = a.date
             AND o.status = 'completed' LIMIT 1) IS NOT NULL
      THEN 'KEIN OPFER — Kundin wurde am selben Tag besucht (verlegt)'
    WHEN (SELECT count(*) FROM appointments o
           WHERE o.deleted_at IS NULL AND o.performed_by_employee_id = a.assigned_employee_id
             AND o.date = a.date AND o.status = 'completed') > 0
      THEN 'OPFER — Kraft arbeitete an dem Tag, dieser Termin verschwand'
    ELSE 'UNKLAR — an dem Tag ist gar nichts geleistet worden'
  END AS befund
FROM appointments a
LEFT JOIN LATERAL (
  SELECT o.id, o.customer_id FROM appointments o
   WHERE o.deleted_at IS NULL AND o.id <> a.id
     AND o.performed_by_employee_id = a.assigned_employee_id AND o.date = a.date
     AND o.status = 'completed'
     AND o.scheduled_start < (a.scheduled_start + (a.duration_promised || ' minutes')::interval)
     AND (o.scheduled_start + (o.duration_promised || ' minutes')::interval) > a.scheduled_start
   LIMIT 1
) k ON true
WHERE a.id IN (915,917,918,919,922,923,924,925,926,1123,1754,1755,1756)
ORDER BY a.assigned_employee_id, a.date;
