# §45b — doppelte Carryover-Allokationen neben manuellem Startwert

- **Datum des Protokolls:** 23.08.2026
- **Task:** #101
- **Skript (gelöscht nach Anwendung):** `server/scripts/cleanup-duplicate-carryovers.ts`
- **Anwendung + Verifikation:** von Alrik bestätigt (Gate-1, 23.08.2026)

## Problem

Ein manuell gesetzter **Startwert** (`source = 'initial_balance'`) für ein Jahr Y
bildet das Restguthaben ab seinem Stichmonat bereits vollständig ab. Existierte
daneben noch die **automatische Carryover-Allokation** für Y+1, zählte derselbe
Betrag zweimal — einmal im Startwert, einmal im Übertrag.

Der Fehler ist rein additiv: er lässt das Budget größer erscheinen, als es ist.

**Wie weit er sich ausgewirkt hat, ist offen** — und wird hier nicht behauptet.
Der Doppelzähl-Schutz in `server/storage/budget/allocation-storage.ts`
(Schritt 5) benutzt **dasselbe Prädikat** wie das Rückbau-Skript. Solange er
da war, hatten die doppelten Zeilen auf `calculateAllocatedCents` keine
Wirkung, und der Rückbau war Hygiene. Für die Zeit *davor* konnten Termine
gebucht worden sein, die am Monatscap oder Jahresbetrag hätten scheitern
müssen; belegen lässt sich das aus dem Repository nicht.

## Maßnahme

Die obsoleten Carryover-Allokationen wurden **soft-gelöscht**
(`budget_allocations.deleted_at = now()`), nicht hart entfernt — die Zeile
bleibt für die Nachvollziehbarkeit erhalten und verschwindet nur aus jeder
Budget-Rechnung.

Ein Audit-Eintrag pro Zeile, Action `budget_carryover_cleanup_soft_deleted`,
mit `allocationId`, `carryoverYear`, `carryoverAmountCents`,
`initialBalanceYear`, `initialBalanceAmountCents` und der Begründung
„Manueller Startwert für Jahr Y überlagert automatischen Carryover (Task #101)".

**Achtung beim Suchen:** der Begründungstext liegt unter dem Schlüssel
`obsoleteReason`, **nicht** `reason` — wer nach `metadata->>'reason'` filtert,
findet nichts.

**Nicht betroffen:** `budget_transactions`. Der gebuchte Verbrauch blieb
unverändert — korrigiert wurde die verfügbare Menge, nicht der Verbrauch.

## Vorher/Nachher

**Die konkreten Zahlen sind aus dem Repository nicht rekonstruierbar** und
werden hier nicht geschätzt. Das Skript schrieb keinen archivierten Report; der
Nachweis liegt zeilengenau im DB-Audit-Log:

```sql
-- Umfang des Rückbaus. Spalte heißt `metadata` (jsonb).
SELECT count(*)                                   AS zeilen,
       count(DISTINCT (metadata->>'customerId'))  AS kunden,
       sum((metadata->>'carryoverAmountCents')::bigint) AS summe_cents,
       min(created_at), max(created_at)
FROM audit_log
WHERE action = 'budget_carryover_cleanup_soft_deleted';
```

### Akteur im Audit-Log

Der Urheber ist **nicht die handelnde Person**: das Skript wählte den
niedrigsten `is_admin`-User (`ORDER BY id ASC LIMIT 1`). Deterministisch, aber
kein Rückschluss auf den Auslöser.

**Und ein Loch, das mit dem Skript verschwindet:** fand es *keinen*
`is_admin`-User, warnte es nur auf der Konsole — die Soft-Deletes liefen dann
trotzdem, der Audit-Eintrag wurde per `if (auditUserId == null) continue`
übersprungen. Der Zweig war erreichbar, weil `is_admin` und `is_super_admin`
unabhängige Spalten sind (beide `default false`). Ob er je gegriffen hat, lässt
sich nur an einer Lücke zwischen betroffenen Zeilen und Audit-Einträgen ablesen.

### Endzustand: die Invariante, direkt prüfbar

```sql
-- Muss 0 Zeilen liefern: kein lebender Carryover für Y+1, wenn für Y ein
-- Startwert existiert.
SELECT c.customer_id, c.year AS carryover_jahr, i.year AS startwert_jahr
FROM budget_allocations c
JOIN budget_allocations i
  ON i.customer_id = c.customer_id
 AND i.budget_type = c.budget_type
 AND i.source      = 'initial_balance'
 AND i.deleted_at IS NULL
 AND i.year        = c.year - 1
WHERE c.source = 'carryover'
  AND c.deleted_at IS NULL
  AND c.budget_type = 'entlastungsbetrag_45b';
```

## Warum das Skript jetzt weg ist

CLAUDE.md: Einmal-Korrekturskripte sind temporäre Werkzeuge. Nach „angewendet +
verifiziert" ersetzt ein Protokoll das `.ts`; der vollständige Nachweis ist
git-Historie + DB-Audit-Log + diese Datei.

Hier kommt dazu, dass das Skript **selbst ein Loch trug** (der Audit-Skip oben)
und **keinen einzigen Ziel-Guard** hatte — ein `--apply` in einer Shell mit
geerbter `DATABASE_URL` hätte gegen die getroffene Datenbank soft-gelöscht.
Beides verschwindet mit der Datei, ohne dass ein Ersatz gebaut werden musste.
Der Altlast-Eintrag im Prod-Gate-Wächter entfällt ebenfalls.
