-- =====================================================================
-- MESSUNG (read-only) — die offenen Datenfragen zur Umsatz-Kachel
-- Ticket 6hWgVqw2C8442hcG · Stand 17.09.2026
--
-- Alle Struktur- und Filterfragen (a–n) sind am Code beantwortet. Fünf
-- Fragen brauchen Daten. Sie entscheiden, ob die Kachel gebaut werden
-- kann wie entworfen — nicht nur, wie sie aussieht.
--
-- Block 1  Sind geplante Lohnkosten ueberhaupt vollstaendig rechenbar?
-- Block 2  Heisst „Bezahlt = 0" wirklich „nichts bezahlt"?
-- Block 3  Ausfallquote (v1 faehrt ohne, aber die Zahl ist billig)
-- Block 4  Die Betraege je Verlust-Kategorie
-- Block 5  Selbsttest: geht die Kaskade auf?
-- Block 6  km getrennt: abrechenbar (Termin) vs. nur-Kosten (Zeiterfassung)
-- Block 7  Lohnmodell: welche Saetze sind ueberhaupt hinterlegt?
-- Block 8  DAS MIX-PROBLEM: Stunden je Leistungsart nach Rolle
--
-- Die Fragen 6, 8 und 9 der Zehnerliste sind am CODE beantwortet und stehen
-- nicht hier — die Antworten im Ticket. Kurz:
--   • Zeiterfassungs-km liegen in der km-ZEILE, nicht in den Gemeinkosten.
--     Deren Kosten und Menge sind dadurch gemischt; nur das Satz-LABEL ist
--     sauber (Task #1752). Die ausgewiesene km-Marge ist also verduennt.
--   • Personen-Overrides gibt es NICHT: `role_wage_rates` hat kein `user_id`.
--     Das Modell ist Rolle x Leistung x Datum.
--   • Die Saetze KOENNEN je Leistung verschieden sein — ob sie es sind, ist
--     eine Datenfrage und steht in Block 7.
--
-- Sozialabgaben sind gestrichen (Alrik, 17.09.2026): die Kachel rechnet mit
-- BRUTTO. Dieses Skript misst deshalb keine Personalnebenkosten.
--
-- ── Art und Aufruf ───────────────────────────────────────────────────
-- AUSSCHLIESSLICH LESEND. Nur SELECT, read only, ROLLBACK.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$PROD_DATABASE_URL" -f docs/check-umsatz-kachel-daten.sql
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset border 2
\timing off

\set MONAT_START '2026-09-01'
\set MONAT_ENDE  '2026-09-30'

BEGIN;
SET TRANSACTION READ ONLY;

\echo ''
\echo '=== 0 — GUARD ======================================================='
-- Abbruch statt plausibler Null: ein leerer Monat liest sich wie ein Befund.
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM appointments
    WHERE deleted_at IS NULL
      AND date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE')
    THEN 'ABBRUCH: keine Termine im Messmonat — Zeitraum pruefen'
  ELSE 'OK'
END AS guard;

\echo ''
\echo '=== 1 — Sind geplante Lohnkosten vollstaendig rechenbar? ============'
\echo '--- `assigned_employee_id` ist NULLABLE. Ohne MA kein geplanter Lohn -'
SELECT a.status,
       count(*)                                                   AS termine,
       count(*) FILTER (WHERE a.assigned_employee_id IS NULL)      AS ohne_mitarbeiter,
       count(*) FILTER (WHERE a.performed_by_employee_id IS NULL
                          AND a.assigned_employee_id IS NULL)      AS ohne_jeden_mitarbeiter
FROM appointments a
WHERE a.deleted_at IS NULL
  AND a.date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
GROUP BY a.status
ORDER BY 2 DESC;

\echo ''
\echo '--- Und der Anteil an den GEPLANTEN, um die es geht ----------------'
SELECT count(*)                                              AS geplante_termine,
       count(*) FILTER (WHERE assigned_employee_id IS NULL)   AS davon_ohne_mitarbeiter,
       round(100.0 * count(*) FILTER (WHERE assigned_employee_id IS NULL)
             / NULLIF(count(*), 0), 1)                        AS prozent_ohne
FROM appointments
WHERE deleted_at IS NULL
  AND date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
  AND status IN ('scheduled', 'documenting');

\echo ''
\echo '=== 2 — Heisst „Bezahlt = 0" wirklich „nichts bezahlt"? ============='
\echo '--- Wenn es NIE eine bezahlte Rechnung gab, kommt der Status nicht an'
SELECT status,
       count(*)                       AS rechnungen,
       min(created_at)::date          AS aelteste,
       max(created_at)::date          AS juengste,
       count(*) FILTER (WHERE issued_at IS NOT NULL) AS je_ausgegeben,
       sum(net_amount_cents) / 100.0  AS netto_eur
FROM invoices
WHERE invoice_type <> 'stornorechnung'
GROUP BY status
ORDER BY 2 DESC;

\echo ''
\echo '--- Gegenprobe ueber ALLE Zeit: existiert der Status ueberhaupt? ---'
SELECT count(*) FILTER (WHERE status = 'bezahlt')             AS je_bezahlt_gesamt,
       count(*) FILTER (WHERE status = 'bezahlt'
                          AND billing_year = 2026)            AS davon_2026,
       max(created_at) FILTER (WHERE status = 'bezahlt')      AS zuletzt_bezahlt_markiert
FROM invoices;

\echo ''
\echo '=== 3 — Ausfallquote: letzte drei Monate ============================'
\echo '--- Nur Kontext. v1 der Kachel faehrt laut Weiche ohne Quote -------'
SELECT to_char(date::date, 'YYYY-MM')                            AS monat,
       count(*)                                                  AS termine,
       count(*) FILTER (WHERE status = 'completed')               AS durchgefuehrt,
       count(*) FILTER (WHERE status = 'cancelled')               AS abgesagt,
       count(*) FILTER (WHERE status = 'customer_no_show')        AS nicht_angetroffen,
       round(100.0 * count(*) FILTER (WHERE status IN ('cancelled','customer_no_show'))
             / NULLIF(count(*), 0), 1)                            AS ausfall_prozent
FROM appointments
WHERE deleted_at IS NULL
  AND date::date >= (date_trunc('month', :'MONAT_START'::date) - interval '3 months')::date
  AND date::date <= :'MONAT_ENDE'
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '=== 4 — Die Verlust-Kategorien in EURO =============================='
\echo '--- Entscheidet, ob der Abzugs-Block relevant ist oder eine Fussnote '
-- Dieselbe Umsatz-Formel wie der Pipeline-Reader: kundenspezifischer Preis
-- gueltig am Termindatum, sonst Katalogpreis; nur `unit_type = 'hours'`.
WITH appt_rev AS (
  SELECT a.id, a.status,
    SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
      COALESCE(
        (SELECT csp.cents FROM prices csp
         WHERE csp.scope = 'customer' AND csp.origin = 'customer_service_prices'
           AND csp.customer_id = a.customer_id AND csp.service_id = s.id
           AND csp.deleted_at IS NULL
           AND csp.valid_from::date <= a.date::date
           AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
         ORDER BY csp.valid_from DESC LIMIT 1),
        s.default_price_cents
      )))::bigint AS cents
  FROM appointments a
  JOIN appointment_services asvc ON asvc.appointment_id = a.id
  JOIN services s ON s.id = asvc.service_id
  WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
    AND a.date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
  GROUP BY a.id, a.status
)
SELECT CASE status
         WHEN 'cancelled'        THEN 'storniert (Lohn faellt NICHT an)'
         WHEN 'customer_no_show' THEN 'Kunde nicht angetroffen (Lohn faellt an)'
         WHEN 'expired_unsigned' THEN 'Frist abgelaufen (Lohn faellt an)'
         ELSE 'in der erwarteten Summe enthalten: ' || status
       END                            AS kategorie,
       count(*)                       AS termine,
       sum(cents) / 100.0             AS eur
FROM appt_rev
GROUP BY 1
ORDER BY 3 DESC NULLS LAST;

\echo ''
\echo '=== 5 — SELBSTTEST: geht die Kaskade auf? =========================='
\echo '--- erwartet + nicht-erwartbar + abgerechnet = alle Stunden-Leistungen'
-- Der Punkt aus der Kaskaden-Diskussion: die Verluste sind in der
-- angezeigten Summe NICHT enthalten. Dieser Block weist die Zerlegung aus,
-- damit die Darstellung auf einer Zahl steht statt auf einer Annahme.
WITH appt_rev AS (
  SELECT a.id, a.status,
    EXISTS (
      SELECT 1 FROM invoice_line_items li
      JOIN invoices i ON i.id = li.invoice_id
      WHERE li.appointment_id = a.id
        AND i.status <> 'storniert' AND i.invoice_type <> 'stornorechnung'
    ) AS ist_abgerechnet,
    SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
      COALESCE(
        (SELECT csp.cents FROM prices csp
         WHERE csp.scope = 'customer' AND csp.origin = 'customer_service_prices'
           AND csp.customer_id = a.customer_id AND csp.service_id = s.id
           AND csp.deleted_at IS NULL
           AND csp.valid_from::date <= a.date::date
           AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
         ORDER BY csp.valid_from DESC LIMIT 1),
        s.default_price_cents
      )))::bigint AS cents
  FROM appointments a
  JOIN appointment_services asvc ON asvc.appointment_id = a.id
  JOIN services s ON s.id = asvc.service_id
  WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
    AND a.date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
  GROUP BY a.id, a.status
)
SELECT
  sum(cents) FILTER (WHERE status NOT IN ('cancelled','customer_no_show','expired_unsigned')
                       AND NOT ist_abgerechnet) / 100.0  AS a_termin_stufen_eur,
  sum(cents) FILTER (WHERE status NOT IN ('cancelled','customer_no_show','expired_unsigned')
                       AND ist_abgerechnet) / 100.0      AS b_auf_rechnung_gewandert_eur,
  sum(cents) FILTER (WHERE status IN ('cancelled','customer_no_show','expired_unsigned'))
             / 100.0                                     AS c_nicht_erwartbar_eur,
  sum(cents) / 100.0                                     AS summe_alle_stunden_eur
FROM appt_rev;

\echo ''
\echo '--- Lesehilfe -------------------------------------------------------'
\echo '  a + b  ~ die angezeigten 15.676,21 EUR (b als Rechnungs-Netto, nicht'
\echo '           als Termin-Umsatz — kleine Differenz ist normal und KEIN Fehler)'
\echo '  c      = der Abzugs-/Verlust-Block, heute NICHT in der Summe enthalten'
\echo '  a+b+c  = alle Stunden-Leistungen des Monats (die Brutto-Zahl aus Weg 2)'

\echo ''
\echo '=== 6 — KILOMETER getrennt: abrechenbar vs. nur Kosten ============='
\echo '--- Heute stecken BEIDE in EINER Zeile — die km-Marge ist verduennt -'
-- Abrechenbare km kommen aus TERMINEN (Anfahrt + Kunden-km), nicht
-- abrechenbare aus der ZEITERFASSUNG. Nur Erstere erzeugen Erloes; beide
-- erzeugen Kosten. Die Saetze kommen aus dem Leistungs-Katalog.
WITH saetze AS (
  SELECT
    max(CASE WHEN code = 'travel_km'   THEN COALESCE(default_price_cents, 0) END) AS travel_preis,
    max(CASE WHEN code = 'travel_km'   THEN COALESCE(employee_rate_cents, 0) END) AS travel_lohn,
    max(CASE WHEN code = 'customer_km' THEN COALESCE(default_price_cents, 0) END) AS kunden_preis,
    max(CASE WHEN code = 'customer_km' THEN COALESCE(employee_rate_cents, 0) END) AS kunden_lohn
  FROM services WHERE code IN ('travel_km','customer_km')
), termin_km AS (
  SELECT COALESCE(sum(a.travel_kilometers), 0)   AS travel_km,
         COALESCE(sum(a.customer_kilometers), 0) AS kunden_km
  FROM appointments a
  WHERE a.deleted_at IS NULL
    AND a.status = 'completed'
    AND a.date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
), te_km AS (
  SELECT COALESCE(sum(t.kilometers), 0) AS km
  FROM employee_time_entries t
  WHERE t.deleted_at IS NULL
    AND t.entry_date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
)
SELECT 'abrechenbar (Anfahrt + Kunden-km aus Terminen)' AS art,
       round((tk.travel_km + tk.kunden_km)::numeric, 1) AS km,
       round((tk.travel_km * s.travel_preis + tk.kunden_km * s.kunden_preis) / 100.0, 2) AS umsatz_eur,
       round((tk.travel_km * s.travel_lohn  + tk.kunden_km * s.kunden_lohn)  / 100.0, 2) AS kosten_eur
FROM termin_km tk, saetze s
UNION ALL
SELECT 'nur Kosten (Zeiterfassung: Vertrieb, Buero, ...)',
       round(te.km::numeric, 1),
       0.00,
       round(te.km * s.travel_lohn / 100.0, 2)
FROM te_km te, saetze s;

\echo ''
\echo '=== 7 — LOHNMODELL: welche Saetze sind hinterlegt? =================='
\echo '--- Leere Tabelle ⇒ ALLE zahlen den Katalog-Default je Leistung -----'
-- `role_wage_rates` hat KEIN `user_id` — Personen-Overrides sind strukturell
-- unmoeglich. Gemessen wird hier nur, OB und WIE die Rollen-Saetze belegt
-- sind, und ob sie je Leistung auseinandergehen (Frage 9).
SELECT w.role,
       s.code                              AS leistung,
       w.cents / 100.0                     AS eur_pro_stunde,
       w.valid_from,
       w.valid_to
FROM role_wage_rates w
JOIN services s ON s.id = w.service_id
WHERE w.deleted_at IS NULL
ORDER BY s.code, w.role, w.valid_from DESC;

\echo ''
\echo '--- Gegenprobe: die Katalog-Defaults (greifen ohne Rollen-Zeile) ----'
SELECT code, COALESCE(employee_rate_cents, 0) / 100.0 AS lohn_eur,
       COALESCE(default_price_cents, 0) / 100.0       AS preis_eur
FROM services
WHERE code IN ('hauswirtschaft','alltagsbegleitung','erstberatung','travel_km','customer_km')
ORDER BY code;

\echo ''
\echo '=== 8 — DAS MIX-PROBLEM: Stunden je Leistungsart nach Rolle ========='
\echo '--- Weicht der Mix ab, sind die Margen von HW und AB NICHT vergleichbar'
-- Rolle exakt wie `wageRoleSql`: admin > teamLead > employee, abgeleitet aus
-- den Flags des LEISTENDEN Mitarbeiters. Keine zweite Definition.
WITH je_termin AS (
  SELECT s.code AS leistung,
         CASE
           WHEN u.is_admin OR u.is_super_admin THEN 'admin'
           WHEN u.is_team_lead AND u.is_active AND NOT COALESCE(u.is_anonymized, false) THEN 'teamLead'
           ELSE 'employee'
         END AS rolle,
         COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) AS minuten
  FROM appointments a
  JOIN appointment_services asvc ON asvc.appointment_id = a.id
  JOIN services s ON s.id = asvc.service_id
  LEFT JOIN users u ON u.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
  WHERE a.deleted_at IS NULL
    AND a.status = 'completed'
    AND s.unit_type = 'hours'
    AND s.code IN ('hauswirtschaft','alltagsbegleitung')
    AND a.date::date BETWEEN :'MONAT_START' AND :'MONAT_ENDE'
)
SELECT leistung,
       rolle,
       round(sum(minuten) / 60.0, 1)                                          AS stunden,
       round(100.0 * sum(minuten) / NULLIF(sum(sum(minuten)) OVER (PARTITION BY leistung), 0), 1)
                                                                              AS prozent_der_leistungsart
FROM je_termin
GROUP BY leistung, rolle
ORDER BY leistung, stunden DESC;

\echo ''
\echo '--- Lesehilfe -------------------------------------------------------'
\echo '  Aehnlicher Prozent-Mix in beiden Leistungsarten ⇒ die Margen sind'
\echo '  vergleichbar, das Thema ist erledigt.'
\echo '  Deutlich abweichender Mix ⇒ die Marge je Leistungsart zeigt einen'
\echo '  Personalplan-Effekt, nicht die Wirtschaftlichkeit der Leistung.'

ROLLBACK;

\echo ''
\echo '=== FERTIG — Transaktion zurueckgerollt, nichts geschrieben ========='
