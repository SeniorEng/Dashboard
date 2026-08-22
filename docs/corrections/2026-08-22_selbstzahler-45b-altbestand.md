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

Zwei Eingriffe, beide auditiert, beide über den regulären Schreibpfad statt per
rohem SQL:

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

Die Topf-Erkennung lief ausschließlich über den SSoT-Validator
(`validateSelbstzahlerBudget` mit `billingType:"selbstzahler"`), nicht über eine
zweite Liste im Skript — mit einer Konsistenzprüfung, die abbricht, falls die
lokale Liste und der Validator auseinanderlaufen.

## Vorher/Nachher

**Die konkreten Zahlen sind aus dem Repository nicht rekonstruierbar** und
werden hier bewusst nicht geschätzt. Das Skript archivierte seinen Report unter
`docs/task-1235-selbstzahler-statutory-cleanup-<env>-<zeitstempel>.md`; eine
solche Datei liegt **nicht** im Repo (weder eingecheckt noch in der Historie).

Der vollständige Nachweis liegt damit im **DB-Audit-Log**, und zwar
zeilengenau — dort sind beide Aktionen mit Kunden-, Topf- und Allokations-IDs
protokolliert:

```sql
-- Rückbau-Umfang, nachträglich aus dem Audit-Log
SELECT action, count(*), min(created_at), max(created_at)
FROM audit_log
WHERE details->>'reason' LIKE 'T1235:%'
   OR (action = 'budget_type_settings_updated' AND created_at BETWEEN <von> AND <bis>)
GROUP BY action;
```

Der Endzustand ist dagegen aus der Invariante prüfbar und braucht keine
historischen Zahlen: **kein Selbstzahler hält einen aktivierten gesetzlichen
Topf oder eine aktive gesetzliche Allokation.** Ein erneuter Lauf des Skripts
hätte „nichts zu tun" gemeldet — es war idempotent gebaut, genau damit dieser
Zustand nachprüfbar bleibt, ohne das Skript aufzubewahren.

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
