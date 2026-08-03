# `migrations/` — die generierte Schema-Baseline

## Was hier liegt

| Datei | Was |
|---|---|
| `0000_*.sql` | Baseline: alle Tabellen, Spalten, Indizes und die im Drizzle-Modell ausgedrückten Constraints. **Generiert** aus `shared/schema.ts` per `npx drizzle-kit generate`. |
| `meta/` | Journal + Snapshots von `drizzle-kit`. Maßgeblich für Reihenfolge und Diff-Basis. |
| `manual/` | Objekte, die Drizzle nicht ausdrücken kann (Trigger, Funktionen). Eigene README dort. |

Die alte, kaputte Historie liegt inaktiv unter `../migrations_legacy/`.

## Diese Datei ist zum STEMPELN da, nicht zum Ausführen

Das ist der wichtigste Satz hier. Die Baseline beschreibt den Zustand, den
**bestehende Datenbanken bereits haben**. Sie wird beim Cutover als „angewendet"
im Migrator-Ledger vermerkt, **ohne ausgeführt zu werden** — das Schema ist ja
schon da.

Wer sie versehentlich gegen eine bestehende DB fährt, bricht beim ersten
`CREATE TABLE` ab (kein `IF NOT EXISTS`); transaktional gefahren bleibt das
folgenlos. Zerstören kann sie nichts — sie enthält kein `DROP`, `DELETE`,
`UPDATE` oder `TRUNCATE`, nur additive Statements. Trotzdem: **nicht** das
`psql -f`-Muster aus `manual/README.md` hierher übertragen. Das gilt dort für
eine handgeführte Migration, nicht für die Baseline.

Ausgeführt wird sie nur auf einer **leeren** DB — beim Neuaufbau von Null, etwa
im Struktur-Inventar-Test (`tests/startup/baseline-structure-inventory.test.ts`).

## Neu erzeugen

```bash
npx drizzle-kit generate      # braucht eine DATABASE_URL, siehe unten
```

`drizzle.config.ts` ruft beim Config-Load `assertEphemeralDbForWrite()` — der
Aufruf bricht auf einer Nicht-Wegwerf-DB ab, auch bei `generate`. Also gegen die
Test-DB laufen lassen:

```bash
set -a; . ./.env.test.local; set +a
npx drizzle-kit generate
```

Ändert sich am Modell nichts, meldet der Aufruf „No schema changes, nothing to
migrate".

## Was die Baseline NICHT enthält

- Trigger und Trigger-Funktionen → `manual/0001_gobd_triggers.sql`
- Zwei Constraints, die nur der Startup-Pfad anlegt und die im Drizzle-Modell
  fehlen. Sie sind gemessen und dokumentiert:
  `docs/schema-baseline-inventory.md`.
