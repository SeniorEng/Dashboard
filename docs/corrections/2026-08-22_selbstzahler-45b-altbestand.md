# Selbstzahler mit gesetzlichen Pflegekassen-Töpfen — Altbestand-Rückbau

- **Datum des Protokolls:** 22.08.2026
- **Task:** #1235 (Schwester zu #1234)
- **Skript (gelöscht nach Anwendung):** `server/scripts/cleanup-selbstzahler-statutory-budgets.ts`
- **Anwendung + Verifikation:** von Alrik bestätigt (Gate-1, 22.08.2026)

## Problem

Kunden mit `billing_type='selbstzahler'` dürfen **keine** gesetzlichen
Pflegekassen-Töpfe halten — §45b Entlastungsbetrag, §45a Umwandlungsanspruch,
§39/§42a gemeinsamer Jahresbetrag. Ein Selbstzahler hat keinen Kostenträger,
gegen den diese Töpfe abgerechnet würden; eine aktivierte Einstellung oder eine
aktive Allokation dort ist ein Widerspruch in sich und verfälscht jede
Budget-Rechnung, die den Topf mitzählt.

Die Tasks #1233/#1234 haben die **Schreibpfade** gesperrt
(`upsertBudgetTypeSettings` und die Allokations-Schreibpfade lehnen den Fall
seither ab). Ein Guard auf dem Schreibpfad wirkt aber nur nach vorne — der
**Altbestand aus der Zeit vor dem Guard** blieb unberührt und wäre dort
unbegrenzt liegen geblieben.

Betroffen waren zwei Ablagen:

1. `customer_budget_type_settings` — offene Phase (`valid_to IS NULL`),
   `enabled = true`, gesetzlicher Topf.
2. `budget_allocations` — aktiv (`deleted_at IS NULL`), gesetzlicher Topf.

## Maßnahme

Zwei Eingriffe, beide auditiert — aber **auf verschiedenen Wegen**: Maßnahme 1
lief über den regulären Schreibpfad, Maßnahme 2 über einen bewussten
GoBD-Trigger-Bypass. Das ist der Unterschied, auf den es in einem
GoBD-Nachweis ankommt:

1. **Aktivierte gesetzliche Topf-Einstellungen geschlossen.** Nicht per
   `UPDATE`, sondern über `upsertBudgetTypeSettings`: alle *anderen* offenen
   Töpfe unverändert ins Payload zurück, die gesetzlichen weggelassen — der
   reguläre Pfad setzt daraufhin `valid_to = heute`. Das hält die
   Append-only-Historie der Budget-Phasen intakt (kein rückwirkendes
   Überschreiben). Nötig war dabei der Escape-Hatch
   `allowStatutoryForSelbstzahler: true`, sonst hätte der Defense-in-Depth-Guard
   aus #1233/#1234 den *Rückbau* selbst blockiert.
   Audit-Action: `budget_type_settings_updated`.

2. **Aktive gesetzliche Allokationen soft-gelöscht** (`deleted_at = now()`),
   in einer Transaktion mit `SET LOCAL app.allow_gobd_mutation = 'on'` — der
   GoBD-Trigger verbietet sonst das `UPDATE` auf `deleted_at`. Ein Audit-Eintrag
   **pro Zeile**, mit `allocationId`, `budgetType`, `source` und `amountCents`.
   Audit-Action: `budget_allocation_soft_deleted`, Begründungstext
   `"T1235: Selbstzahler darf keine gesetzliche Allokation halten
   (Altbestand-Rückbau)."`

**Nicht angefasst:** bestehende `budget_transactions` (gebuchter Verbrauch).
Die sind GoBD-immutabel; eine Korrektur dort liefe über Storno. Das Skript hat
solche Buchungen im Report nur **warnend** ausgewiesen, damit ein Mensch den
Einzelfall prüfen kann.

**Zur Topf-Erkennung, genau:** das Skript hatte sehr wohl eine lokale Liste
(`STATUTORY_POTS` mit den drei Töpfen) und benutzte **sie** für die beiden
DB-Abfragen auf `budget_allocations` und `budget_transactions`. Nur die
Settings-Seite lief über den SSoT-Validator `validateSelbstzahlerBudget`.

Eine Konsistenzprüfung gab es, aber nur in **eine** Richtung: jeder Topf der
lokalen Liste musste vom Validator als gesetzlich erkannt werden. Die
Gegenrichtung — der Validator kennt einen gesetzlichen Topf, der in der Liste
fehlt — war trotz gegenteiligem Kommentar **nicht** implementiert.

Praktisch entstand daraus kein Datenfehler: Liste und Validator waren
deckungsgleich (dieselben drei Töpfe). Aber die Zusage unten gilt streng
genommen für **diese drei Töpfe**, nicht für „alles, was der Validator sperrt".

## Vorher/Nachher

**Die konkreten Zahlen sind aus dem Repository nicht rekonstruierbar** und
werden hier bewusst nicht geschätzt. Das Skript archivierte seinen Report unter
`docs/task-1235-selbstzahler-statutory-cleanup-<env>-<zeitstempel>.md`; eine
solche Datei liegt **nicht** im Repo (weder eingecheckt noch in der Historie).

Der vollständige Nachweis liegt damit im **DB-Audit-Log**, und zwar
zeilengenau — dort sind beide Aktionen mit Kunden-, Topf- und Allokations-IDs
protokolliert:

```sql
-- Rückbau-Umfang, nachträglich aus dem Audit-Log.
-- Spalte heißt `metadata` (jsonb), nicht `details`.
-- Die beiden Aktionen tragen VERSCHIEDENE Marker:
--   budget_type_settings_updated   -> metadata->>'task'   = 'T1235'
--   budget_allocation_soft_deleted -> metadata->>'reason' LIKE 'T1235:%'
SELECT action, count(*), min(created_at), max(created_at)
FROM audit_log
WHERE metadata->>'task' = 'T1235'
   OR metadata->>'reason' LIKE 'T1235:%'
GROUP BY action;
```

Die **per-Topf-Details** liegen nicht unter diesen beiden Aktionen, sondern
unter `budget_type_settings_transition` — die schreibt der reguläre
Schreibpfad selbst (`upsertBudgetTypeSettings`), mit `kind`, `previous`,
`next` und `closedAt`. Wer den Rückbau im Detail nachvollziehen will, findet
ihn dort, zeitlich um die obigen Einträge herum.

### Akteur im Audit-Log

**Der Urheber der Einträge ist NICHT die handelnde Person.** Das Skript wählte
ihn per `SELECT id FROM users WHERE is_super_admin = true LIMIT 1` — ohne
`ORDER BY`, also einen beliebigen aktiven Superadmin. Wer die Einträge später
liest, darf daraus keinen Rückschluss auf den Auslöser ziehen.

Ergänzend zur Beweiskraft: die Audit-Einträge zu Maßnahme 2 wurden **außerhalb**
der Transaktion und über den Legacy-Pfad von `auditService.log` geschrieben —
der fängt Insert-Fehler und meldet sie nur auf stderr. Ein fehlgeschlagener
Audit-Insert hätte die Soft-Deletes also nicht verhindert. Rückwirkend nicht
mehr änderbar, aber der Nachweis ist damit best-effort und nicht garantiert.

### Endzustand: die Invariante, direkt prüfbar

Der Endzustand braucht keine historischen Zahlen: **kein Selbstzahler hält
einen aktivierten gesetzlichen Topf oder eine aktive gesetzliche Allokation.**

Der bisherige Prüfweg war der idempotente Re-Lauf des Skripts („nichts zu
tun"). Der fällt mit der Löschung weg — deshalb hier der Ersatz, der die
einzige echte Fähigkeit der Datei erhält:

```sql
-- Muss 0 Zeilen liefern. Beide Hälften der Invariante in einer Abfrage.
SELECT 'setting' AS art, s.customer_id, s.budget_type
FROM customer_budget_type_settings s
JOIN customers c ON c.id = s.customer_id
WHERE c.billing_type = 'selbstzahler'
  AND s.valid_to IS NULL
  AND s.enabled
  AND s.budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a')
UNION ALL
SELECT 'allocation', a.customer_id, a.budget_type
FROM budget_allocations a
JOIN customers c ON c.id = a.customer_id
WHERE c.billing_type = 'selbstzahler'
  AND a.deleted_at IS NULL
  AND a.budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a');
```

### Offen geblieben: gesetzliche `budget_transactions` bei Selbstzahlern

Das Skript wies Kunden mit vorhandenen gesetzlichen **Buchungen** nur warnend
aus — sie sind GoBD-immutabel, eine Korrektur liefe über Storno und war
ausdrücklich als **manuelle Einzelfallprüfung** vorgesehen. **Ob es solche
Fälle gab, stand nur im nicht existierenden Report.** Mit der Löschung ist die
Frage sonst nicht mehr auffindbar, deshalb steht sie hier:

```sql
-- Gab/gibt es gesetzliche Buchungen bei Selbstzahlern? -> Einzelfallprüfung.
SELECT t.customer_id, t.budget_type, count(*), sum(t.amount_cents)
FROM budget_transactions t
JOIN customers c ON c.id = t.customer_id
WHERE c.billing_type = 'selbstzahler'
  AND t.budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a')
GROUP BY t.customer_id, t.budget_type;
```

Liefert sie Zeilen, ist das **kein** Widerspruch zum Rückbau oben — die
Buchungen waren nie Teil davon.

## Warum das Skript jetzt weg ist

CLAUDE.md: Einmal-Korrekturskripte sind temporäre Werkzeuge. Nach „angewendet +
verifiziert" wird das `.ts` gelöscht und durch ein Protokoll ersetzt — der
vollständige Nachweis ist git-Historie + DB-Audit-Log + diese Datei. Ein
liegengebliebenes Skript bricht `tsc`/CI, sobald sich Signaturen ändern, und
suggeriert einen wiederholbaren Vorgang, den es nicht gibt.

Hier kam ein zweiter Grund dazu, aus der Guard-Welle W1–W4: das Skript trug als
einziges im Repo eine **stehende Freigabe-Env**
(`SELBSTZAHLER_STATUTORY_CLEANUP_APPROVED=1`) — genau die Bauform, die
CLAUDE.md für `PUBLISH_ACK_DROPS` ausdrücklich verworfen hat, weil sie gesetzt
bleibt und still jeden weiteren Lauf genehmigt. Dazu einen GoBD-Bypass. Beides
verschwindet mit der Datei, ohne dass ein Ersatzmechanismus gebaut werden
musste.

Der zugehörige Eintrag in der Altlast-Liste des Prod-Gate-Wächters
(`tests/architecture/prod-write-gate-coverage.test.ts`) entfällt ebenfalls:
15 → 14. Die Liste schrumpft damit, wie vorgesehen — sie wächst nie.

## Wirkende Guards (das, was den Fall künftig verhindert)

- `validateSelbstzahlerBudget` (`shared/domain/budget-selbstzahler-validator.ts`)
  — die SSoT der Frage „darf dieser Kunde diesen Topf halten?".
- Die Schreibpfad-Sperren aus #1233/#1234 in `upsertBudgetTypeSettings` und den
  Allokations-Schreibpfaden.

Der Altbestand konnte nur entstehen, weil diese Guards zum Zeitpunkt der
Datenerfassung noch nicht existierten. Er kann nicht neu entstehen.
