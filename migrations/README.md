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

**Beim Neu-Erzeugen der Baseline zwei Handgriffe nicht vergessen**: `generate`
vergibt jedes Mal einen neuen Zufallsnamen (`0000_good_prism.sql` o.ä.). Datei
zurück auf `0000_neat_brood.sql` benennen und den `tag` in
`meta/_journal.json` mitziehen — sonst ist der Diff Datei-weg/Datei-neu statt
einer Zeile, und der Journal-Tag zeigt ins Leere.

**Ab A3 ist `0000` eingefroren.** Sobald der programmatische Migrator die
Baseline in `__drizzle_migrations` stempelt, vergleicht drizzles `migrate()` den
gespeicherten `created_at` gegen das `when` aus dem Journal. Ein Neu-Generieren
von `0000` bumpt dieses `when` — die Baseline gälte dann als neuer als der
Stempel und würde auf einer bestehenden DB **erneut angewendet**, mit Abbruch am
ersten `CREATE TABLE`. Heute folgenlos (kein Runner wendet das an), ab A3 nicht
mehr: dann gehören Modelländerungen in eine Folge-Migration `0001…`, nicht in
eine neue `0000`.

## Was die Baseline NICHT enthält

- Trigger und Trigger-Funktionen → `manual/0001_gobd_triggers.sql`
- **Einen** Constraint, den nur der Startup-Pfad anlegt und der im Drizzle-Modell
  bewusst fehlt (`appointments_prospect_or_customer_check` — Prod hat ihn nicht).
  Gemessen und begründet in `docs/schema-baseline-inventory.md`.
