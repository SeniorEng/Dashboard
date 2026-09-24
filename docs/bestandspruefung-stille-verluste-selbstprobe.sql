-- ============================================================================
-- SELBSTPROBE zu `bestandspruefung-stille-verluste.sql`
--
-- ⚠ NUR TEST-DB — DIESE DATEI SCHREIBT.
--
--   Sie legt einen Audit-Eintrag an (`INSERT INTO audit_log`) und rollt ihn
--   zurück. Zurückgerollt ist nicht ungeschrieben: die Sequenz springt weiter,
--   und `audit_log` ist GoBD-relevant. Gegen Prod gehört sie nicht, auch nicht
--   „kurz zum Ausprobieren".
--
--   Die Prod-Datei daneben setzt `default_transaction_read_only = on` und
--   würde diese Anweisungen ablehnen. Das ist Absicht.
--
-- WOZU
--   Eine Abfrage, die „0 Zeilen" meldet, kann zweierlei heißen: es gibt keinen
--   Fall, oder sie findet keinen. Von außen sehen beide gleich aus. Diese
--   Probe konstruiert einen Fall und prüft, dass beide Abfragen ihn melden.
--
--   Erwartet: Selbstprobe 1 meldet GENAU eine Zeile mit 500,00 €,
--   Selbstprobe 1b denselben Eintrag über leeres `allocationIds`.
--
-- AUSFÜHRUNG
--   set -a; . ./.env.test.local; set +a
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/bestandspruefung-stille-verluste-selbstprobe.sql
-- ============================================================================

BEGIN;

INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, created_at)
SELECT
  (SELECT id FROM users ORDER BY id LIMIT 1),
  'budget_initial_setup',
  'budget',
  (SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 1),
  jsonb_build_object(
    'customerId', (SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 1),
    'budgetType', 'umwandlung_45a',
    'currentMonthAmountCents', NULL,
    'carryoverAmountCents', 50000,
    'budgetStartDate', '2026-05-15',
    'allocationIds', '[]'::jsonb
  ),
  now();

\echo '=== Selbstprobe 1: muss GENAU 1 Zeile mit 500,00 EUR melden ==='
SELECT
  a.entity_id AS kunde,
  a.metadata ->> 'budgetType' AS topf,
  round((a.metadata ->> 'carryoverAmountCents')::bigint / 100.0, 2) AS verlorener_uebertrag_eur
FROM audit_log a
WHERE a.action = 'budget_initial_setup'
  AND a.metadata ->> 'budgetType' <> 'entlastungsbetrag_45b'
  AND a.metadata -> 'carryoverAmountCents' IS NOT NULL
  AND a.metadata ->> 'carryoverAmountCents' <> 'null'
  AND (a.metadata ->> 'carryoverAmountCents')::bigint > 0
  AND NOT EXISTS (
    SELECT 1 FROM budget_allocations b
    WHERE b.customer_id = a.entity_id
      AND b.budget_type = a.metadata ->> 'budgetType'
      AND b.source      = 'carryover'
  );

\echo '=== Selbstprobe 1b: muss denselben Eintrag ueber leeres allocationIds finden ==='
SELECT
  a.entity_id AS kunde,
  a.metadata ->> 'budgetType' AS topf,
  (a.metadata ->> 'carryoverAmountCents')::bigint AS uebertrag_cents
FROM audit_log a
WHERE a.action = 'budget_initial_setup'
  AND jsonb_array_length(coalesce(a.metadata -> 'allocationIds', '[]'::jsonb)) = 0
  AND (
       (a.metadata ->> 'currentMonthAmountCents') IS NOT NULL
         AND a.metadata ->> 'currentMonthAmountCents' <> 'null'
    OR (a.metadata ->> 'carryoverAmountCents') IS NOT NULL
         AND a.metadata ->> 'carryoverAmountCents' <> 'null'
  );

ROLLBACK;

-- Für Fall 2 gibt es keine Selbstprobe, weil es keinen Beleg gibt, den man
-- konstruieren könnte. Genau das ist der Befund.


-- ════════════════════════════════════════════════════════════════════════════
-- SELBSTPROBE 2 — trennt die Fall-2-Abfrage richtig?
-- ════════════════════════════════════════════════════════════════════════════
--
-- Nach dem Gate-4-Lauf vom 24.09.2026 schliesst die Kandidatenliste
-- zusammengefuehrte Dubletten aus (`merged_into_customer_id IS NOT NULL`) —
-- alle vier geprueften Kandidaten waren solche.
--
-- Eine Einengung ist ein Filter, und ein falscher Filter faellt nicht auf: er
-- liefert einfach weniger. Diese Probe baut BEIDE Seiten und prueft, dass genau
-- eine uebrig bleibt.
--
-- Erwartet: GENAU eine Zeile, der NICHT zusammengefuehrte Kunde.

BEGIN;

-- Zwei Kunden ohne §45b-Topf: einer zusammengefuehrt, einer nicht.
INSERT INTO customers (name, address, pflegegrad, billing_type, accepts_private_payment, status)
VALUES ('Probe NICHT zusammengefuehrt', 'Teststr. 1', 3, 'pflegekasse_gesetzlich', false, 'aktiv');

INSERT INTO customers (name, address, pflegegrad, billing_type, accepts_private_payment, status,
                       merged_into_customer_id, inaktiv_ab)
VALUES ('Probe ZUSAMMENGEFUEHRT', 'Teststr. 2', 3, 'pflegekasse_gesetzlich', false, 'inaktiv',
        (SELECT id FROM customers WHERE name = 'Probe NICHT zusammengefuehrt'), '2026-03-01');

\echo '=== Muss GENAU die nicht zusammengefuehrte Zeile melden ==='
SELECT
  c.name                                               AS kundenname,
  c.status                                             AS status,
  c.inaktiv_ab                                         AS inaktiv_ab
FROM customers c
WHERE c.deleted_at IS NULL
  AND c.merged_into_customer_id IS NULL
  AND c.pflegegrad IS NOT NULL
  AND c.billing_type IN ('pflegekasse_gesetzlich', 'pflegekasse_privat')
  AND c.name LIKE 'Probe %'
  AND NOT EXISTS (
    SELECT 1 FROM customer_budget_type_settings s
    WHERE s.customer_id = c.id AND s.budget_type = 'entlastungsbetrag_45b'
  )
  AND NOT EXISTS (
    SELECT 1 FROM budget_allocations b
    WHERE b.customer_id = c.id AND b.budget_type = 'entlastungsbetrag_45b' AND b.deleted_at IS NULL
  );

\echo '=== Gegenprobe: OHNE die Einengung waeren es zwei ==='
SELECT count(*) AS ohne_einengung
FROM customers c
WHERE c.deleted_at IS NULL
  AND c.pflegegrad IS NOT NULL
  AND c.billing_type IN ('pflegekasse_gesetzlich', 'pflegekasse_privat')
  AND c.name LIKE 'Probe %'
  AND NOT EXISTS (
    SELECT 1 FROM customer_budget_type_settings s
    WHERE s.customer_id = c.id AND s.budget_type = 'entlastungsbetrag_45b'
  )
  AND NOT EXISTS (
    SELECT 1 FROM budget_allocations b
    WHERE b.customer_id = c.id AND b.budget_type = 'entlastungsbetrag_45b' AND b.deleted_at IS NULL
  );

ROLLBACK;
