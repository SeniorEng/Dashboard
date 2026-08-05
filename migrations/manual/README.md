# `migrations/manual/`

Handgeführte Migrationen für Schema-Objekte, die **Drizzle nicht ausdrücken
kann** — heute die GoBD-/Unveränderlichkeits-Trigger und ihre Funktionen.

## Warum ein eigener Ordner

Nicht aus Ordnungsliebe, sondern weil der Nachbarordner eine Falle ist:

- `migrations/` ist das `out`-Verzeichnis von `drizzle-kit`. Sein
  `meta/_journal.json` ist kaputt (kennt `0020`–`0022` nicht, verweist auf eine
  gelöschte `0011`, neuester Snapshot ist `0014`) und wird beim Baselining (A2)
  neu gebaut.
- Ein `drizzle-kit generate` vergäbe dort als nächsten Index `20` und
  kollidierte mit dem vorhandenen `0020_*`.
- A2 archiviert `migrations/` — eine Datei darin ginge mit.

Dieser Ordner wird von `drizzle-kit` **nicht** angefasst. Er ist die
handgeführte Hälfte des Schema-Bauplans neben der generierten Baseline.

## Inhalt

| Datei | Quelle | Neu erzeugen |
|---|---|---|
| `0001_gobd_triggers.sql` | `server/startup/trigger-registry.ts` | `npx tsx scripts/generate-trigger-migration.ts` |
| `0002_cutover_cleanup.sql` | handgeschrieben (A3) | — |

`0002` entfernt Objekte, die in Prod existieren, aber in keiner Quelle des
Repos stehen, und gleicht zwei Indizes an `main` an. Was darin steht, ist am
Prod-Dump gemessen, nicht aus dem Code geschlossen — Begründung im Datei-Kopf
und in `docs/schema-cutover.md`.

**`0001` nicht von Hand bearbeiten.** Die Datei ist eine Projektion der SSoT;
`tests/startup/trigger-migration.test.ts` pinnt die Übereinstimmung und prüft
zusätzlich, dass die Migration objektweise dasselbe baut wie der
Laufzeit-Renderer.

## Ausführung

Nur transaktional und mit Abbruch bei Fehler:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f migrations/manual/0001_gobd_triggers.sql
```

Ohne `-1`/`ON_ERROR_STOP` läuft `psql` nach einem Fehler weiter und endet mit
Exit 0 — die Fail-fast-Zusage der Drop-Blöcke wäre dann wirkungslos. Der
programmatische Migrator (A3) fährt jede Migration ohnehin in einer Transaktion.

**Seit A3 gibt es den Runner**: `scripts/migrate-schema.ts` wendet diesen Ordner
explizit an — nach der journaled Baseline, in lexikalischer Reihenfolge, je in
einer Transaktion, mit Buchführung in `drizzle.__manual_migrations`.

Das ist kein Detail: `migrations/meta/_journal.json` kennt **nur `0000`**.
Ein Runner, der bloss drizzles `migrate()` aufruft, überspränge diesen Ordner
**still** — ohne Fehler, ohne Hinweis. Deshalb der zweite, eigene Schritt.

Noch NICHT umgestellt ist der Deploy: `scripts/migrate.sh` fährt weiter
`drizzle-kit push`. Ablauf und Stand: `docs/schema-cutover.md`.
