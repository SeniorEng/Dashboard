# LN-Signatur-Constraint direkt in Prod angelegt — Deploy-Deadlock aufgelöst

- **Datum:** 17.09.2026, ~20:25 Uhr
- **Ausgeführt von:** Alrik, in der Replit-Shell gegen `PROD_DATABASE_URL`
- **Skript:** einmalig, `cc-prod-constraint.mjs` (nach dem Lauf gelöscht; Wortlaut
  unten vollständig, siehe „Das Statement")
- **Ticket:** `6hWgVqw2C8442hcG` · **Folge-Tickets:** `6hWvMvpxpJFFjwQG` (P1),
  `6hWvrJgff5xr9hfp` (P1)
- **Gate 4:** Trockenlauf zuerst, dann ausdrückliche Freigabe je Schritt.

---

## Problem

PR #145 führt die Invariante „ein `monthly_service_records`-Eintrag mit
`status = 'completed'` trägt eine Kundenunterschrift" als CHECK-Constraint ein.
Er wird bewusst **nicht** über das Drizzle-Modell angelegt, sondern als
idempotente Startup-DDL beim Container-Boot — weil er `NOT VALID` sein muss
(42 Bestandszeilen aus dem Altdaten-Import verletzen ihn; Alriks Weiche vom
17.09.2026: „Bestandsbehandlung entfällt", Protokoll
`2026-09-17_42er-unsignierte-nachweise-kassenbelege.md`).

**Der Publish scheiterte daran fünfmal.** Replits Plattform-Diff vergleicht
**Dev-DB ↔ Prod-DB** (nicht Modell ↔ Prod). In der Dev-DB hatte die Startup-DDL
den Constraint beim Boot längst angelegt; der Diff wollte ihn also nach Prod
übertragen und rekonstruierte das Statement per `pg_get_constraintdef()`. Dabei
entsteht eine Klammer zu viel:

```
CHECK ((status <> 'completed'::text) OR (customer_signed_at IS NOT NULL))) NOT VALID;
                                                                        ^ drei auf, vier zu
```

`syntax error at or near ")"`. **Das Statement war gegen keine Datenbank
lauffähig** — ein Generator-Fehler bei Replit, nicht bei uns.

### Warum kein Weg aus dem System heraus führte

| Versuch | warum er im Kreis lief |
|---|---|
| Startup-DDL (der Entwurf) | braucht einen Boot → braucht einen erfolgreichen Deploy → scheitert am fehlenden Constraint |
| Constraint in Dev droppen | die Startup-DDL legt ihn beim nächsten Dev-Boot wieder an — ein Wettlauf, kein Zustand |
| Constraint ins Drizzle-Modell | Drizzle kennt keine `NOT VALID`-Stufe (`check(name, value)`) ⇒ validierter Constraint ⇒ Scan ⇒ schlägt an den 42 Zeilen fehl |
| #145 revertieren | der Constraint steht trotzdem in der Dev-DB und müsste dort gedroppt werden — plus Verlust der Invariante |

**Der Deadlock hatte genau eine Stelle außerhalb des Deploy-Zyklus: ein direkter
Schreibvorgang auf Prod.**

Ein zweiter Weg wurde geprüft und ist versperrt: **Replits SQL-Oberfläche
gegen die Produktions-Datenbank ist read-only** (`Cannot run modification
statements in read-only mode`). Eine DDL gegen Prod braucht dort zwingend die
Connection-URL und eine Shell — das gehört ins Deploy-Memo.

---

## Maßnahme

Ein einmaliges Skript, das **genau das Statement ausführt, das die Startup-DDL
ohnehin ausgeführt hätte** — vorgezogen im Zeitpunkt, unverändert im Inhalt.
Von Hand formuliert, nicht aus einer Introspektion rekonstruiert.

### Das Statement

```sql
ALTER TABLE monthly_service_records
  ADD CONSTRAINT monthly_service_records_completed_requires_signature_check
  CHECK (status <> 'completed' OR customer_signed_at IS NOT NULL)
  NOT VALID
```

Wortgleich mit `SERVICE_RECORD_SIGNED_CHECK_SQL` in
`server/startup/ensure-service-record-signed-invariant.ts`.

### Die Riegel des Skripts

Jeder davon ist aus einem Fehler desselben Abends entstanden:

| Riegel | Anlass |
|---|---|
| Identitätsprüfung **vor** dem Verbinden (aus der URL) und **danach** (aus der offenen Verbindung, `current_database()`) | eine erste Fassung prüfte erst nach dem Connect und war bei kaputter URL nie erreicht |
| Klammerbilanz des Statements wird **gerechnet**, nicht gezählt | „Klammern ausgeglichen" war an diesem Abend von Hand ermittelt worden und falsch |
| Trockenlauf ist der Standard, `--apply` der bewusste zweite Aufruf | Gate 4 |
| Idempotent — ist der Constraint da, passiert nichts | der Startup-Pfad legt ihn später erneut an |
| Nachkontrolle im selben Lauf: `convalidated = false` | ein versehentlich **validierter** Constraint hätte die 42 Zeilen getroffen |
| gequoteter Heredoc statt `node -e "…"` | `!` in doppelten Quotes löste in der interaktiven Shell History-Expansion aus |

Vor dem Prod-Lauf gegen eine Wegwerf-DB mit **600** verletzenden Zeilen
durchgespielt: `ADD CONSTRAINT … NOT VALID` ging durch, ohne eine davon
anzufassen.

---

## Vorher / Nachher

**Vorher** (gemessen über Replits SQL-Oberfläche, read-only):

```
current_database | verletzende_zeilen
neondb           | 42
```

**Nachher** (Ausgabe des Skripts):

```
DB: neondb
convalidated: false        (false = NOT VALID)
```

**Keine Datenzeile wurde verändert.** Ein Constraint ändert keinen Datensatz;
`NOT VALID` unterdrückt zusätzlich den Prüf-Scan über den Bestand. Die 42
Zeilen sind unverändert vorhanden — so, wie Alriks Weiche es vorsieht.

**Wirkung ab sofort:** neue Verletzungen sind ausgeschlossen (Postgres prüft
`NOT VALID`-Constraints bei INSERT und UPDATE), der Altbestand bleibt
unberührt. Das ist genau die Zusage aus #145.

---

## Audit-Referenz

**Es gibt keinen `audit_log`-Eintrag** — DDL läuft nicht über den
Anwendungspfad und wird von der GoBD-Audit-Kette nicht erfasst. Der Nachweis
ist deshalb dreiteilig:

1. dieses Protokoll,
2. die Kommentar-Kette in Ticket `6hWgVqw2C8442hcG` (Entscheidung, Skript,
   Ausgaben beider Läufe),
3. der Constraint selbst, jederzeit prüfbar:

```sql
SELECT conname, convalidated
FROM pg_constraint
WHERE conname = 'monthly_service_records_completed_requires_signature_check';
```

Erwartung: eine Zeile, `convalidated = false`.

---

## Was daraus folgt

**Der Zustand ist jetzt stabil, nicht flüchtig.** Dev und Prod tragen den
Constraint, Replits Diff findet dort nichts mehr zu generieren, und der
Generator-Bug wird an dieser Stelle nie wieder berührt.

**Aber die Ursache ist nicht behoben, nur dieser eine Fall.** Jeder künftige
NEUE startup-only Constraint trifft denselben Deadlock: er entsteht in der
Dev-DB, Replits Diff will ihn nach Prod tragen, und wenn er `NOT VALID` ist,
scheitert die Rekonstruktion wieder. Die beiden älteren Einträge in
`KNOWN_STARTUP_ONLY_CONSTRAINTS` waren unauffällig, weil sie auf beiden Seiten
schon standen.

`KNOWN_STARTUP_ONLY_CONSTRAINTS` schützt vor dem eigenen Drift-Wächter. Es
schützt **nicht** vor Replits Publish-Diff — der kennt unsere Konventionen
nicht, er liest `pg_constraint`.

Offen in `6hWvMvpxpJFFjwQG`: dass es auf Replit überhaupt **drei** Wege gibt,
auf denen Schema nach Prod kommt (Plattform-Diff, `migrate.sh` push,
Startup-DDL) — und dass unser Gate nur den zweiten kennt.
