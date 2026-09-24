-- ============================================================================
-- Bestandsprüfung: zwei still verlorene Eingaben
-- ============================================================================
--
-- ZWECK
--   Zwei Befunde aus der Aufarbeitung zu #186 haben Daten verloren, ohne eine
--   Fehlermeldung zu erzeugen. Beide sind nach vorn behoben — ein Fix nach vorn
--   repariert den BESTAND aber nicht. Diese Abfragen sagen, ob und wo etwas
--   nachzuarbeiten ist.
--
-- AUSFÜHRUNG
--   Nur LESEND. Kein INSERT/UPDATE/DELETE, kein DDL. Gegen Prod oder die
--   Prod-Kopie ausführbar.
--   Spalten- und Aktionsnamen aus dem Code übernommen, nicht geraten:
--     · `audit_log`            → `shared/schema/audit.ts:185-199`
--     · Aktion `budget_initial_setup` und die Metadaten-Felder
--                             → `server/services/budget-initial-setup.ts:308-315`
--     · `budget_allocations`   → `shared/schema`
--
-- SELBSTPROBE
--   Am Ende steht ein Block, der einen Fall KONSTRUIERT und prüft, dass beide
--   Abfragen ihn finden — in einer Transaktion mit `ROLLBACK`. Eine Abfrage,
--   die „0" meldet, muss vorher gezeigt haben, dass sie überhaupt etwas findet.
--   Sonst ist ihre Null keine Aussage.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- FALL 1 — §45a/§39-Übertrag: 201 + Audit, aber keine Zeile
-- ════════════════════════════════════════════════════════════════════════════
--
-- `applyInitialBudget` schreibt eine `carryover`-Zeile AUSSCHLIESSLICH für
-- §45b (`budgetType === "entlastungsbetrag_45b"`). Für §45a und §39/§42a lief
-- ein Body mit `carryoverAmountCents` bis zum 24.09.2026 durch die Validierung,
-- schrieb nichts — und quittierte mit `201` samt Audit-Eintrag über den Betrag.
--
-- Der Audit-Eintrag ist damit der einzige Beleg, dass der Betrag je eingegeben
-- wurde. Genau deshalb ist er hier die Quelle.

SELECT
  a.created_at::date                                   AS datum,
  a.entity_id                                          AS kunde,
  a.metadata ->> 'budgetType'                          AS topf,
  (a.metadata ->> 'carryoverAmountCents')::bigint      AS verlorener_uebertrag_cents,
  round((a.metadata ->> 'carryoverAmountCents')::bigint / 100.0, 2) AS verlorener_uebertrag_eur,
  (a.metadata ->> 'currentMonthAmountCents')::bigint   AS startwert_cents,
  a.metadata ->> 'budgetStartDate'                     AS start_datum,
  a.user_id                                            AS erfasst_von,
  a.id                                                 AS audit_id
FROM audit_log a
WHERE a.action = 'budget_initial_setup'
  AND a.metadata ->> 'budgetType' <> 'entlastungsbetrag_45b'
  AND a.metadata -> 'carryoverAmountCents' IS NOT NULL
  AND a.metadata ->> 'carryoverAmountCents' <> 'null'
  AND (a.metadata ->> 'carryoverAmountCents')::bigint > 0
  -- Gegenprobe: es gibt für diesen Kunden/Topf auch WIRKLICH keine
  -- Uebertragszeile. Ohne sie beruht der Befund auf meiner Lesart des Codes
  -- statt auf dem Bestand.
  AND NOT EXISTS (
    SELECT 1 FROM budget_allocations b
    WHERE b.customer_id = a.entity_id
      AND b.budget_type = a.metadata ->> 'budgetType'
      AND b.source      = 'carryover'
  )
ORDER BY (a.metadata ->> 'carryoverAmountCents')::bigint DESC, a.created_at DESC;


-- ── 1b. Die allgemeinere Form: Audit behauptet Beträge, `allocationIds` ist leer ──
--
-- `budget_initial_setup` trägt die IDs der tatsächlich geschriebenen Zeilen.
-- Ein Eintrag mit Beträgen und LEEREM `allocationIds` ist per Konstruktion ein
-- „angenommen, quittiert, verworfen" — unabhängig davon, welcher Topf und aus
-- welchem Grund. Findet auch Fälle, an die ich beim Bauen nicht gedacht habe.

SELECT
  a.created_at::date                                   AS datum,
  a.entity_id                                          AS kunde,
  a.metadata ->> 'budgetType'                          AS topf,
  (a.metadata ->> 'currentMonthAmountCents')::bigint   AS startwert_cents,
  (a.metadata ->> 'carryoverAmountCents')::bigint      AS uebertrag_cents,
  a.metadata ->> 'budgetStartDate'                     AS start_datum,
  a.id                                                 AS audit_id
FROM audit_log a
WHERE a.action = 'budget_initial_setup'
  AND jsonb_array_length(coalesce(a.metadata -> 'allocationIds', '[]'::jsonb)) = 0
  AND (
       (a.metadata ->> 'currentMonthAmountCents') IS NOT NULL
         AND a.metadata ->> 'currentMonthAmountCents' <> 'null'
    OR (a.metadata ->> 'carryoverAmountCents') IS NOT NULL
         AND a.metadata ->> 'carryoverAmountCents' <> 'null'
  )
ORDER BY a.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- FALL 2 — Monatsbetrag 0: der `budgets`-Block fiel ganz weg
-- ════════════════════════════════════════════════════════════════════════════
--
-- ⚠ ES GIBT KEINE SPUR. Das ist der Befund, nicht das Ergebnis der Abfrage.
--
-- Gemessen am 24.09.2026 (Wizard-Hook gefahren, Aufruf abgefangen): war der
-- §45b-Monatsbetrag 0, ließ der Assistent den GANZEN `budgets`-Block weg. Damit
-- erreichte NICHTS über §45b den Server:
--
--   · kein `applyInitialBudget`-Aufruf   → kein `budget_initial_setup`-Audit
--   · keine Typ-Einstellungen            → `customer_budget_type_settings` leer
--     (`customer-creation-helpers.ts:231` — alles hängt an `if (input.budgets)`)
--   · `customer_created` trägt nur `{customerName, billingType}`
--     (`server/services/audit.ts:251-259`) — nicht den Payload
--   · `setup_pending_payloads` wird nur bei FEHLGESCHLAGENEN Schritten
--     geschrieben; hier ist nichts fehlgeschlagen
--
-- Ein eingegebener Übertrag ist in diesem Fall **nicht rekonstruierbar**. Die
-- Abfrage unten ist deshalb KEIN Nachweis, sondern eine KANDIDATENLISTE: sie
-- findet Kunden, bei denen der Block plausibel weggefallen ist. Ob dort ein
-- Übertrag eingegeben wurde, kann nur Alrik aus der Kassenauskunft sagen.
--
-- Die Unterscheidung ist wichtig: „X tritt auf" ist keine Aussage über die
-- Ursache. Wer diese Liste als Verlustliste liest, behauptet mehr, als gemessen
-- ist.

SELECT
  c.id                                                 AS kunde,
  c.name                                               AS kundenname,
  c.created_at::date                                   AS angelegt_am,
  c.pflegegrad,
  c.billing_type                                       AS abrechnungsart,
  'KANDIDAT — kein §45b-Topf trotz Pflegegrad'         AS lesart
FROM customers c
WHERE c.deleted_at IS NULL
  AND c.pflegegrad IS NOT NULL
  AND c.billing_type IN ('pflegekasse_gesetzlich', 'pflegekasse_privat')
  -- Kein §45b-Typ-Setting: der Block ist nie angekommen.
  AND NOT EXISTS (
    SELECT 1 FROM customer_budget_type_settings s
    WHERE s.customer_id = c.id
      AND s.budget_type = 'entlastungsbetrag_45b'
  )
  -- Und auch keine Zeile, die auf einem anderen Weg entstanden wäre.
  AND NOT EXISTS (
    SELECT 1 FROM budget_allocations b
    WHERE b.customer_id = c.id
      AND b.budget_type = 'entlastungsbetrag_45b'
      AND b.deleted_at IS NULL
  )
ORDER BY c.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- SELBSTPROBE — findet Fall 1 überhaupt etwas?
-- ════════════════════════════════════════════════════════════════════════════
--
-- In einer Transaktion, die am Ende zurückgerollt wird. Konstruiert wird der
-- §45a-Fall: ein Audit-Eintrag mit 500,00 € Übertrag und leerem
-- `allocationIds`, ohne zugehörige Zeile. Beide Abfragen müssen ihn melden.
--
-- Wer sie überspringt und unten „0 Zeilen" liest, weiß nicht, ob es keinen
-- Fall gibt oder ob die Abfrage blind ist.

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
