-- ============================================================================
-- Replit-#1913 — SWEEP: gibt es mehr als die 13?
--
-- READ-ONLY. Kein INSERT/UPDATE/DELETE.
-- Ausführen auf PRODUKTIV (Replit), Ergebnis zurück an die Box.
--
-- ZWECK: Die 13 sind über das Ticket gefunden worden — also über eine
-- Beschwerde. Wer sich nicht beschwert hat, steht nicht im Ticket. Dieser
-- Sweep sucht dieselbe Opfer-Signatur über ALLE Serien, Kunden und
-- Kostenträger, bevor der Datums-Boden deployt und die Spur einfriert.
--
-- OPFER-SIGNATUR (aus den 13 abgeleitet):
--   status = 'cancelled'  ·  date < heute  ·  nie gestartet  ·  nie
--   unterschrieben  ·  in keinem Leistungsnachweis  ·  auf keiner Rechnung
--
-- ── DIE GRENZE, DIE MAN KENNEN MUSS ────────────────────────────────────────
-- Diese Signatur trifft AUCH völlig korrekte Absagen. Ein im Juni beendetes
-- Abo storniert Juli-Termine richtig; die sind heute vergangen und sehen
-- hinterher genauso aus. Das unterscheidende Merkmal wäre „war der Termin ZUM
-- ZEITPUNKT DER ABSAGE bereits vergangen" — und das ist nicht rekonstruierbar:
-- den Audit-Eintrag `appointment_cancelled` gibt es erst seit PR #100, alle
-- Altfälle sind älter.
--
-- Der Sweep liefert deshalb KEINE Opferliste, sondern einen nach Verdacht
-- SORTIERTEN Suchraum. Block (B) ist der eigentliche Filter: er sucht die
-- `this_and_future`-Handschrift — einen zusammenhängenden Lauf abgesagter
-- Termine, der über „heute" hinweg von der Vergangenheit in die Zukunft
-- reicht. Eine korrekte Absage kann das nicht erzeugen: sie beginnt frühestens
-- heute. Ein rückwirkendes `this_and_future` erzeugt genau das.
--
-- Serie 6 (die 13) muss in (B) auftauchen. Tut sie es nicht, stimmt die
-- Abfrage nicht — dann NICHT weiterlesen, sondern zurück an die Box.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (A) GESAMTBILD — wie groß ist der Suchraum überhaupt?
--     Eine Zeile. Sagt, ob wir über Dutzende oder über Tausende reden.
-- ---------------------------------------------------------------------------
SELECT
  count(*)                                   AS verdaechtige_termine,
  count(DISTINCT a.series_id)                AS serien,
  count(DISTINCT a.customer_id)              AS kunden,
  count(DISTINCT a.assigned_employee_id)     AS kraefte,
  sum(a.duration_promised)                   AS minuten,
  min(a.date)                                AS aeltester,
  max(a.date)                                AS juengster
FROM appointments a
WHERE a.deleted_at IS NULL
  AND a.status = 'cancelled'
  AND a.date < CURRENT_DATE
  AND a.actual_start IS NULL
  AND a.actual_end   IS NULL
  AND a.signed_at    IS NULL
  AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_line_items i        WHERE i.appointment_id = a.id);

-- ---------------------------------------------------------------------------
-- (B) DER EIGENTLICHE FILTER — die `this_and_future`-Handschrift
--
--     Je Serie: liegen verdächtige Termine SOWOHL vor als AUCH nach dem
--     jüngsten NICHT abgesagten Termin der Serie? Anders gesagt: wurde mitten
--     in einen laufenden Betrieb hinein rückwirkend abgesagt?
--
--     `letzter_aktiver` = der jüngste Termin der Serie, der NICHT abgesagt ist
--     (also geleistet, dokumentiert oder geplant). Verdächtige Termine, die
--     VOR diesem Datum liegen, sind das Verdachtsmoment: dort wurde abgesagt,
--     obwohl der Betrieb danach weiterlief. Eine korrekte Absage („ab jetzt
--     nicht mehr") lässt hinter sich nichts Aktives stehen.
--
--     RANG:
--       1 = verdächtige VOR dem letzten aktiven Termin  -> starker Verdacht
--       2 = alles danach abgesagt / Serie ganz beendet  -> NICHT unterscheidbar
--
--     ACHTUNG, gegen die naheliegende Fehllesung: Rang 2 heißt NICHT
--     „vermutlich korrekt". Am Trockenlauf gegen die Referenz-Kopie gemessen
--     landet Serie 12 — die den bestätigten Opfer-Termin 1123 enthält — in
--     RANG 2, weil dort einfach ALLES abgesagt wurde und kein aktiver Termin
--     als Bezugspunkt übrig blieb. Wer Rang 2 wegsortiert, sortiert eines der
--     13 mit weg.
--
--     Rang 2 ist also „kein Signal", nicht „Entwarnung". Diese Serien müssen
--     einzeln angesehen werden: hat die Kundin dort weiter Leistungen bezogen?
--     Steht eine Kündigung im System? Das beantwortet kein SQL.
-- ---------------------------------------------------------------------------
WITH verdaechtig AS (
  SELECT a.*
  FROM appointments a
  WHERE a.deleted_at IS NULL
    AND a.series_id IS NOT NULL
    AND a.status = 'cancelled'
    AND a.date < CURRENT_DATE
    AND a.actual_start IS NULL
    AND a.actual_end   IS NULL
    AND a.signed_at    IS NULL
    AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_line_items i        WHERE i.appointment_id = a.id)
),
aktiv AS (
  SELECT a.series_id, max(a.date) AS letzter_aktiver
  FROM appointments a
  WHERE a.deleted_at IS NULL
    AND a.series_id IS NOT NULL
    AND a.status <> 'cancelled'
  GROUP BY a.series_id
)
SELECT
  v.series_id,
  u.display_name                                      AS kraft,
  c.name                                              AS kunde,
  -- Kostentraeger ZEITRAUMGENAU zum Termindatum, nicht "der aktuelle".
  -- `customers` traegt gar keine Kassen-Spalte; die Zuordnung liegt in
  -- `customer_insurance_history` mit `valid_from`/`valid_to`. Ein Direkt-Join
  -- auf "die Kasse des Kunden" waere die `todayISO()`-statt-`asOf`-Falle, vor
  -- der CLAUDE.md warnt — bei einem Kassenwechsel stuende hier die falsche.
  -- Stichtag ist das Datum des JUENGSTEN verdaechtigen Termins der Gruppe.
  (SELECT ip.name
     FROM customer_insurance_history h
     JOIN insurance_providers ip ON ip.id = h.insurance_provider_id
    WHERE h.customer_id = v.customer_id
      AND h.valid_from <= max(v.date)
      AND (h.valid_to IS NULL OR h.valid_to >= max(v.date))
    ORDER BY h.valid_from DESC
    LIMIT 1)                                          AS kostentraeger,
  count(*)                                            AS verdaechtige,
  min(v.date)                                         AS von,
  max(v.date)                                         AS bis,
  sum(v.duration_promised)                            AS minuten,
  ak.letzter_aktiver,
  count(*) FILTER (WHERE ak.letzter_aktiver IS NOT NULL
                     AND v.date < ak.letzter_aktiver) AS vor_dem_letzten_aktiven,
  CASE
    WHEN ak.letzter_aktiver IS NOT NULL
     AND min(v.date) < ak.letzter_aktiver THEN 1
    ELSE 2
  END                                                 AS rang,
  array_agg(v.id ORDER BY v.date)                     AS ids
FROM verdaechtig v
LEFT JOIN aktiv     ak ON ak.series_id = v.series_id
LEFT JOIN users     u  ON u.id = v.assigned_employee_id
LEFT JOIN customers c  ON c.id = v.customer_id
GROUP BY v.series_id, u.display_name, c.name, v.customer_id, ak.letzter_aktiver
ORDER BY rang, count(*) DESC, v.series_id;

-- ---------------------------------------------------------------------------
-- (C) DIE 13 ALS EICHUNG — wo landen die BESTÄTIGTEN Opfer in (B)?
--
--     Gegen die Referenz-Kopie gemessen: Serie 6 und Serie 18 in Rang 1,
--     Serie 12 in RANG 2. Das ist der Beleg für die Warnung oben — der Filter
--     erkennt zwei der drei bestätigten Fälle, den dritten nicht.
--
--     Fällt eine dieser drei Serien auf Prod ganz aus (B) heraus, ist (B)
--     falsch gebaut. Dann NICHT weiterlesen, sondern zurück an die Box.
-- ---------------------------------------------------------------------------
SELECT
  a.series_id,
  count(*) FILTER (WHERE a.status = 'cancelled')  AS abgesagt,
  count(*) FILTER (WHERE a.status <> 'cancelled') AS aktiv,
  max(a.date) FILTER (WHERE a.status <> 'cancelled') AS letzter_aktiver,
  min(a.date) FILTER (WHERE a.status = 'cancelled')  AS erste_absage
FROM appointments a
WHERE a.deleted_at IS NULL
  AND a.series_id IN (
    SELECT DISTINCT series_id FROM appointments
     WHERE id IN (915,917,918,919,922,923,924,925,926,1123,1754,1755,1756)
  )
GROUP BY a.series_id
ORDER BY a.series_id;

-- ---------------------------------------------------------------------------
-- (D) EINZELTERMINE OHNE SERIE — die andere Hälfte des Suchraums.
--
--     Die 13 kamen alle aus Serien, weil der Defekt in der Serien-Route sitzt.
--     Ein vergangener, abgesagter Einzeltermin mit derselben Signatur ist
--     dagegen meist eine bewusste Handlung (jemand hat abgesagt und nie
--     dokumentiert). Hier nur zur Vollständigkeit, mit ausdrücklich SCHWACHEM
--     Verdacht — nicht als Reparatur-Kandidaten lesen.
-- ---------------------------------------------------------------------------
SELECT
  count(*)                       AS einzeltermine,
  count(DISTINCT a.customer_id)  AS kunden,
  sum(a.duration_promised)       AS minuten,
  min(a.date)                    AS aeltester,
  max(a.date)                    AS juengster
FROM appointments a
WHERE a.deleted_at IS NULL
  AND a.series_id IS NULL
  AND a.status = 'cancelled'
  AND a.date < CURRENT_DATE
  AND a.actual_start IS NULL
  AND a.actual_end   IS NULL
  AND a.signed_at    IS NULL
  AND NOT EXISTS (SELECT 1 FROM service_record_appointments s WHERE s.appointment_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_line_items i        WHERE i.appointment_id = a.id);

-- ---------------------------------------------------------------------------
-- (E) WAISEN-HOLDS AUF DEN VERDÄCHTIGEN — Geld, das nirgends hingehört.
--
--     Termin 923 hielt 57,00 €: `sweepOrphanHolds` meldet „storniert + Hold"
--     seit jeher als Waise, die URSACHE blieb. Wo dieselbe Kombination sonst
--     noch steht, ist derselbe Vorfall wahrscheinlich — und es ist reserviertes
--     Budget, das dem Kunden fehlt, ohne dass eine Leistung dagegensteht.
-- ---------------------------------------------------------------------------
SELECT
  a.series_id,
  u.display_name              AS kraft,
  c.name                      AS kunde,
  count(*)                    AS termine_mit_hold,
  sum(r.amount_cents) / 100.0 AS gehaltene_euro,
  array_agg(a.id ORDER BY a.date) AS ids
FROM appointments a
JOIN budget_reservations r ON r.appointment_id = a.id AND r.state = 'hold'
LEFT JOIN users     u ON u.id = a.assigned_employee_id
LEFT JOIN customers c ON c.id = a.customer_id
WHERE a.deleted_at IS NULL
  AND a.status = 'cancelled'
  AND a.date < CURRENT_DATE
GROUP BY a.series_id, u.display_name, c.name
ORDER BY sum(r.amount_cents) DESC;
