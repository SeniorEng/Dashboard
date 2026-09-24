-- ============================================================================
-- Gate-4-Abfrage: liegen in Prod `setup_pending_payloads` mit Budget-Block?
-- ============================================================================
--
-- ZWECK
--   Entscheidet, ob der Blocker B1 aus Gate 2 zu #186 ein AKUTER Fall ist oder
--   eine scharfe Kante ohne Bestand.
--
--   Hintergrund: der Banner „Startbudgets erneut versuchen"
--   (`client/src/features/customers/components/admin/customer-detail-sections.tsx:67`)
--   spielt einen gespeicherten Payload gegen `POST /budget/:id/initial-budget`
--   ab. Sein Kontrakt (`server/routes/admin/customers.ts`) verlangt beide
--   Beträge als `z.number()` — „keine Angabe" ist darin nicht ausdrückbar.
--
--   Gemessen am 24.09.2026: `{currentMonthAmountCents: 0,
--   carryoverAmountCents: 0}` erzeugt nach S5 **201 und zwei 0-€-Zeilen**
--   statt einer Ablehnung. Die `initial_balance`-Zeile setzt einen Reset-Anker;
--   ein bestehender Startwert desselben Monats würde per UPDATE auf 0 gesetzt.
--
-- AUSFÜHRUNG
--   NUR LESEND — durchgesetzt, nicht zugesagt: die erste Anweisung setzt
--   `default_transaction_read_only = on`. Ein Schreibversuch bricht danach mit
--   `cannot execute INSERT in a read-only transaction` ab.
--
--   (Die Selbstprobe zu dieser Datei liegt bewusst NICHT hier — sie schreibt.
--   Muster wie bei `bestandspruefung-stille-verluste-selbstprobe.sql`.)
--
--   Gegen die Prod-Kopie oder Prod ausführbar.
--   Spaltennamen aus `shared/schema/customers.ts:71-76` übernommen, nicht
--   geraten.
--
-- ERWARTUNG / LESART
--   Abfrage 1 = 0 Zeilen  → B1 ist eine scharfe Kante ohne Bestand.
--                           Der Fix bleibt nötig (der Weg existiert), aber es
--                           gibt nichts nachzuarbeiten.
--   Abfrage 1 > 0 Zeilen  → Abfrage 2 und 3 ansehen: sie zeigen, WELCHE Werte
--                           die Payloads tragen und ob ein Retry echte Daten
--                           überschreiben würde.
-- ============================================================================


-- Die Lesesperre. Erste Anweisung, damit sie für alles Folgende gilt.
SET default_transaction_read_only = on;


-- ── 1. Gibt es überhaupt Kunden mit einem Budget-Block im Pending-Payload? ──
--
-- `setup_budgets_pending` ist das Flag, das den Banner zeigt; der Payload kann
-- unabhängig davon vorhanden sein. Beide getrennt ausgewiesen, damit „Banner
-- sichtbar" und „Payload vorhanden" nicht verwechselt werden.

SELECT
  count(*) FILTER (WHERE setup_pending_payloads ? 'budgets')          AS mit_budget_payload,
  count(*) FILTER (WHERE setup_budgets_pending)                       AS flag_gesetzt,
  count(*) FILTER (WHERE setup_budgets_pending
                     AND setup_pending_payloads ? 'budgets')          AS banner_und_payload,
  count(*)                                                            AS kunden_gesamt
FROM customers
WHERE deleted_at IS NULL;


-- ── 2. Welche Werte tragen die Payloads? ────────────────────────────────────
--
-- Eine Zeile je Budget-Eintrag. `form` benennt die Kombination, um die es in
-- B1 geht:
--   {0,0}   → schreibt nach S5 ZWEI 0-€-Zeilen (Reset-Anker + Übertrag)
--   {0,>0}  → wird vom Entweder-oder abgelehnt (400), nichts geschrieben
--   {>0,0}  → schreibt Startwert + zusätzliche 0-€-Übertragszeile
--   {>0,>0} → wird vom Entweder-oder abgelehnt (400)

SELECT
  c.id                                                   AS kunde,
  c.setup_budgets_pending                                AS banner_sichtbar,
  b ->> 'budgetType'                                     AS topf,
  (b ->> 'currentMonthAmountCents')::bigint              AS startwert_cents,
  (b ->> 'carryoverAmountCents')::bigint                 AS uebertrag_cents,
  b ->> 'budgetStartDate'                                AS start_datum,
  CASE
    WHEN (b ->> 'currentMonthAmountCents')::bigint = 0
     AND (b ->> 'carryoverAmountCents')::bigint = 0      THEN '{0,0} → 2 Null-Zeilen'
    WHEN (b ->> 'currentMonthAmountCents')::bigint = 0
     AND (b ->> 'carryoverAmountCents')::bigint > 0      THEN '{0,>0} → 400'
    WHEN (b ->> 'currentMonthAmountCents')::bigint > 0
     AND (b ->> 'carryoverAmountCents')::bigint = 0      THEN '{>0,0} → Startwert + Null-Uebertrag'
    ELSE                                                      '{>0,>0} → 400'
  END                                                    AS form
FROM customers c
CROSS JOIN LATERAL jsonb_array_elements(c.setup_pending_payloads -> 'budgets' -> 'items') AS b
WHERE c.deleted_at IS NULL
  AND c.setup_pending_payloads ? 'budgets'
ORDER BY c.id;


-- ── 3. Würde ein Retry echte Daten überschreiben? ───────────────────────────
--
-- Der kritische Fall: der Payload nennt `(budgetType, Jahr, Monat)`, für das
-- bereits eine AKTIVE `initial_balance`-Zeile mit einem Betrag > 0 existiert.
-- `upsertInitialBalanceAllocation` macht daraus ein
-- `UPDATE … SET amount_cents = <payload-Wert>` — bei einem 0-Payload also
-- eine stille Nullsetzung eines erfassten Startwerts.
--
-- Jahr/Monat werden aus `budgetStartDate` abgeleitet, weil der Schreibpfad
-- genau das tut.

SELECT
  c.id                                            AS kunde,
  b ->> 'budgetType'                              AS topf,
  (b ->> 'budgetStartDate')::date                 AS payload_start,
  (b ->> 'currentMonthAmountCents')::bigint       AS payload_startwert_cents,
  a.id                                            AS bestehende_allocation,
  a.amount_cents                                  AS bestehender_betrag_cents,
  a.valid_from                                    AS bestehend_ab,
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
  AND a.amount_cents IS DISTINCT FROM (b ->> 'currentMonthAmountCents')::bigint
ORDER BY abs(a.amount_cents - (b ->> 'currentMonthAmountCents')::bigint) DESC;


-- ============================================================================
-- Was diese Abfrage NICHT beantwortet
-- ============================================================================
--   • Ob der Banner je GEKLICKT wird. Sie misst den Bestand, nicht das
--     Verhalten.
--   • Ob ein Payload ohne `items`-Schlüssel existiert (Abfrage 2 und 3 laufen
--     dann leer, Abfrage 1 zählt ihn trotzdem) — deshalb Abfrage 1 zuerst
--     lesen und die Zahlen gegeneinander halten.
--   • Historische Payloads, die inzwischen per `/setup-pending/:step/clear`
--     entfernt wurden.
