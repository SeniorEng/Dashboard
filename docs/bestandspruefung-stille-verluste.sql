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
--   NUR LESEND — und das ist hier keine Zusage, sondern durchgesetzt: die
--   erste Anweisung setzt `default_transaction_read_only = on`. Ein
--   INSERT/UPDATE/DELETE bricht danach mit einem Fehler ab, statt zu laufen.
--
--   Gegen Prod oder die Prod-Kopie ausführbar.
--
--   Spalten- und Aktionsnamen aus dem Code übernommen, nicht geraten:
--     · `audit_log`            → `shared/schema/audit.ts:185-199`
--     · Aktion `budget_initial_setup` und die Metadaten-Felder
--                             → `server/services/budget-initial-setup.ts:308-315`
--     · `budget_allocations`   → `shared/schema`
--
-- SELBSTPROBE — in `bestandspruefung-stille-verluste-selbstprobe.sql`
--   Sie SCHREIBT (ein konstruierter Audit-Eintrag, danach `ROLLBACK`) und
--   gehört deshalb NICHT in diese Datei. Sie stand hier bis zum 24.09.2026
--   unten drin, während der Kopf „kein INSERT" behauptete — wer dem Kopf
--   glaubte und die Datei gegen Prod fuhr, schrieb in `audit_log`.
--   Zurückgerollt, aber geschrieben, und `audit_log` ist GoBD-relevant.
--
--   Genau die Klasse „Beschreibung, die etwas Falsches behauptet": sie wird
--   als Beleg gelesen, und niemand prüft nach, denn dafür steht sie da.
--
--   Vor dem Prod-Lauf die Selbstprobe einmal gegen die TEST-DB fahren — eine
--   Abfrage, die hier „0 Zeilen" meldet, ist sonst ununterscheidbar von einer,
--   die nichts finden kann.
-- ============================================================================

-- Die Lesesperre. Erste Anweisung, damit sie für alles Folgende gilt.
SET default_transaction_read_only = on;


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
-- Ein Eintrag mit Beträgen und LEEREM `allocationIds` heißt: quittiert, nichts
-- geschrieben. Findet auch Fälle, an die ich beim Bauen nicht gedacht habe.
--
-- ⚠ NICHT jede Zeile hier ist ein Verlust (Gate 2 zum B1-Delta):
--   · Ein `{0, 0}`-Eintrag war vor S5 der NORMALFALL des Onboarding-Aufrufs —
--     beide Beträge wurden auf `null` gefaltet, es entstand nichts, und es ging
--     auch nichts verloren. Solche Zeilen sind harmlos.
--   · Verloren ist etwas, wo ein Betrag > 0 steht. Danach zuerst sortieren.
--
-- Und eine Lücke, die diese Abfrage NICHT schließt: das Audit wird ohne `exec`
-- geschrieben (`budget-initial-setup.ts:308`), läuft also außerhalb der
-- Anlage-Transaktion. Rollt der Anlage-Flow zurück, überlebt der Audit-Eintrag
-- mit NICHT-leerem `allocationIds`, das auf verschwundene Zeilen zeigt — diese
-- Abfrage findet ihn nicht. Wer dem nachgehen will, braucht einen Join von
-- `allocationIds` gegen `budget_allocations.id`.

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
--
-- ── Eingeengt am 24.09.2026, nach dem Gate-4-Lauf ──────────────────────────
-- Die erste Fassung war zu breit. Alle vier geprüften Kandidaten (132, 124,
-- 113, 112) waren **zusammengeführte Dubletten** aus Feb/Mär — inaktiv, per
-- `merged_into_customer_id` auf einen Zielkunden gezeigt. Kein fehlendes
-- Budget, sondern ein Kunde, der aus gutem Grund keines mehr hat.
--
-- **Das Signal ist `merged_into_customer_id`, nicht der Pflegegrad** — dieselbe
-- Lehre wie bei 139/148 im September. Eine Dublette behält ihren Pflegegrad,
-- verliert aber alles, was am aktiven Datensatz hängt; „Pflegegrad ohne
-- §45b-Topf" trifft deshalb jede zusammengeführte Zeile.
--
-- Zusammengeführte sind jetzt ausgeschlossen, und `status`/`inaktiv_ab` stehen
-- in der Ausgabe: ein inaktiver Kunde ohne Topf ist ein anderer Sachverhalt als
-- ein aktiver, und diese Unterscheidung soll man sehen, ohne nachfragen zu
-- müssen.
--
-- (`customers` hat KEINE `is_active`-Spalte — nachgesehen, nicht angenommen;
-- das `isActive` im Schema sitzt auf `customer_contacts`. Der Aktivitäts-Stand
-- steht in `status` mit den Werten `aktiv`/`inaktiv`/`gekuendigt`, das Datum
-- der Deaktivierung in `inaktiv_ab`.)

SELECT
  c.id                                                 AS kunde,
  c.name                                               AS kundenname,
  c.created_at::date                                   AS angelegt_am,
  c.status                                             AS status,
  c.inaktiv_ab                                         AS inaktiv_ab,
  c.pflegegrad,
  c.billing_type                                       AS abrechnungsart,
  -- Bewusst NICHT „kein §45b-Topf": seit Task #1828 ist §45b fuer
  -- Pflegekassen-Kunden default-aktiv OHNE persistierte Zeile
  -- (`hasActiveBudgetPot` ist die SSoT). „Keine Zeile" ist ein brauchbares
  -- Kandidaten-Signal, aber keine Aussage ueber den Topf — das waere ein
  -- Zweitbegriff zur SSoT.
  'KANDIDAT — keine §45b-Einstellungszeile, kein Startwert/Übertrag' AS lesart
FROM customers c
WHERE c.deleted_at IS NULL
  -- Zusammengeführte Dubletten raus: sie haben ihren Pflegegrad behalten und
  -- ihr Budget an den Zielkunden abgegeben. Das ist kein Verlust.
  AND c.merged_into_customer_id IS NULL
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
ORDER BY (c.status = 'aktiv') DESC, c.created_at DESC;
