-- ============================================================================
-- SELBSTPROBE zu `gate4-abfrage-setup-pending-budgets.sql`
--
-- ⚠ NUR TEST-DB — DIESE DATEI SCHREIBT.
--
--   Sie setzt bei einem Kunden `setup_pending_payloads` und legt eine
--   `budget_allocations`-Zeile an, dann `ROLLBACK`. Gegen Prod gehört sie
--   nicht; die Abfrage-Datei daneben setzt `default_transaction_read_only = on`
--   und würde diese Anweisungen ablehnen. Das ist Absicht.
--
-- WOZU
--   Die Gate-4-Abfrage meldet auf einem sauberen Bestand „0". Das kann heißen:
--   es gibt keinen Fall — oder sie findet keinen. Von außen sehen beide gleich
--   aus. Diese Probe konstruiert den kritischen Fall und prüft, dass alle drei
--   Abfragen ihn melden.
--
--   Konstruiert wird die Form `{0, 0}` neben einem bereits erfassten Startwert
--   von 184,60 €. Erwartet:
--     Abfrage 1 → 1 / 1 / 1
--     Abfrage 2 → Form „{0,0} -> 2 Null-Zeilen"
--     Abfrage 3 → Differenz 18460 (die drohende Überschreibung)
--
-- AUSFÜHRUNG
--   set -a; . ./.env.test.local; set +a
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/gate4-abfrage-setup-pending-budgets-selbstprobe.sql
-- ============================================================================

BEGIN;

-- Ein Kunde mit Pending-Payload in der Form {0,0} + ein bestehender Startwert
-- von 184,60 EUR im selben Monat — also genau der Fall, den Abfrage 3 finden muss.
WITH k AS (
  SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 1
)
UPDATE customers c SET
  setup_budgets_pending = true,
  setup_pending_payloads = jsonb_build_object(
    'budgets', jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object(
        'budgetType', 'entlastungsbetrag_45b',
        'currentMonthAmountCents', 0,
        'carryoverAmountCents', 0,
        'budgetStartDate', '2026-06-01'
      )
    ))
  )
FROM k WHERE c.id = k.id;

INSERT INTO budget_allocations
  (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at, notes)
SELECT id, 'entlastungsbetrag_45b', 2026, 6, 18460, 'initial_balance', '2026-06-01', NULL, 'selbstprobe'
FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 1;

\echo '=== Abfrage 1 muss jetzt 1 melden ==='
SELECT
  count(*) FILTER (WHERE setup_pending_payloads ? 'budgets')          AS mit_budget_payload,
  count(*) FILTER (WHERE setup_budgets_pending)                       AS flag_gesetzt,
  count(*) FILTER (WHERE setup_budgets_pending
                     AND setup_pending_payloads ? 'budgets')          AS banner_und_payload
FROM customers WHERE deleted_at IS NULL;

\echo '=== Abfrage 2 muss die Form {0,0} benennen ==='
SELECT
  c.id AS kunde,
  (b ->> 'currentMonthAmountCents')::bigint AS startwert_cents,
  (b ->> 'carryoverAmountCents')::bigint    AS uebertrag_cents,
  CASE
    WHEN (b ->> 'currentMonthAmountCents')::bigint = 0
     AND (b ->> 'carryoverAmountCents')::bigint = 0      THEN '{0,0} -> 2 Null-Zeilen'
    WHEN (b ->> 'currentMonthAmountCents')::bigint = 0
     AND (b ->> 'carryoverAmountCents')::bigint > 0      THEN '{0,>0} -> 400'
    WHEN (b ->> 'currentMonthAmountCents')::bigint > 0
     AND (b ->> 'carryoverAmountCents')::bigint = 0      THEN '{>0,0} -> Startwert + Null-Uebertrag'
    ELSE                                                      '{>0,>0} -> 400'
  END AS form
FROM customers c
CROSS JOIN LATERAL jsonb_array_elements(c.setup_pending_payloads -> 'budgets' -> 'items') AS b
WHERE c.deleted_at IS NULL AND c.setup_pending_payloads ? 'budgets';

\echo '=== Abfrage 3 muss die drohende Ueberschreibung zeigen (Differenz 18460) ==='
SELECT
  c.id AS kunde,
  (b ->> 'currentMonthAmountCents')::bigint AS payload_startwert_cents,
  a.amount_cents AS bestehender_betrag_cents,
  a.amount_cents - (b ->> 'currentMonthAmountCents')::bigint AS differenz_cents
FROM customers c
CROSS JOIN LATERAL jsonb_array_elements(c.setup_pending_payloads -> 'budgets' -> 'items') AS b
JOIN budget_allocations a
  ON  a.customer_id = c.id
  AND a.budget_type = b ->> 'budgetType'
  AND a.source      = 'initial_balance'
  AND a.deleted_at  IS NULL
  AND a.year        = EXTRACT(YEAR  FROM (b ->> 'budgetStartDate')::date)::int
  AND a.month       = EXTRACT(MONTH FROM (b ->> 'budgetStartDate')::date)::int
WHERE c.deleted_at IS NULL
  AND c.setup_pending_payloads ? 'budgets'
  AND a.amount_cents IS DISTINCT FROM (b ->> 'currentMonthAmountCents')::bigint;

ROLLBACK;
