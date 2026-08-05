# Schema-Cutover: von `drizzle-kit push` auf den programmatischen Migrator

Stand 05.08.2026 (A3). **Der Cutover ist noch nicht vollzogen** — dieses
Dokument beschreibt den geprüften Weg, nicht einen erfolgten Vorgang.
`scripts/migrate.sh` fährt weiterhin `drizzle-kit push`.

## Warum überhaupt

`push` leitet die Änderung selbst aus dem Modell-Ist-Vergleich ab. Es gibt keine
versionierte, reviewbare Liste dessen, was auf der Datenbank passiert ist, und
`--force` darf destruktiv werden. Der Migrator (`scripts/migrate-schema.ts`)
führt stattdessen genau die Dateien im Repo aus, in fester Reihenfolge, je in
einer Transaktion, und schreibt mit, was gelaufen ist.

## Die zwei Quellen — und warum `manual/` extra behandelt wird

| Quelle | Geführt über | Wer wendet an |
|---|---|---|
| `migrations/0000_*.sql` | `migrations/meta/_journal.json` | drizzles eigener Migrator |
| `migrations/manual/*.sql` | **nichts** — bewusst ausserhalb des Journals | dieser Migrator, explizit |

Der Journal-Hinweis ist wichtig genug für einen eigenen Absatz: **`_journal.json`
kennt ausschliesslich `0000`.** `drizzle-kit` fasst den Ordner `manual/` nicht
an, und drizzles `migrate()` liest nur das Journal. Ein Runner, der bloss
`migrate()` aufruft, würde die GoBD-Trigger und die Cutover-Aufräumung **still
überspringen** — ohne Fehler, ohne Hinweis. Deshalb wendet
`scripts/migrate-schema.ts` sie in einem zweiten, eigenen Schritt an und führt
dafür eine eigene Buchführung in `drizzle.__manual_migrations`.

Reihenfolge ist immer Baseline → manual: die Trigger hängen an Tabellen, die die
Baseline anlegt.

## Buchführung liegt ausserhalb von `public`

`drizzle.__drizzle_migrations` (von drizzle) und `drizzle.__manual_migrations`
(vom Migrator) stehen beide im Schema `drizzle`. Das ist Absicht: das
Vergleichs-Rezept unten dumpt nur `public`, sieht die Buchführung also nicht.
Buchführung darf den Schema-Vergleich nicht verfälschen.

Bewusst NICHT die vorhandene Tabelle `budget_migrations` mitbenutzt — die liegt
in `public`, ist im Drizzle-Modell deklariert und beantwortet eine andere Frage
(einmalige Budget-**Daten**-Migrationen, `server/startup/ensure-migration-ledger.ts`).

## Die zwei Modi

```bash
# Leere DB und jeder Folge-Deploy: journaled ausführen, dann manual
DATABASE_URL=… npx tsx scripts/migrate-schema.ts

# GENAU EINMAL beim Cutover einer BESTEHENDEN Datenbank:
# Baseline stempeln (nicht ausführen), dann manual anwenden
DATABASE_URL=… npx tsx scripts/migrate-schema.ts --stamp-baseline
```

Die Baseline beschreibt den Zustand, den eine bestehende DB schon hat
(`migrations/README.md`: „zum STEMPELN da, nicht zum Ausführen"). Ausgeführt
bräche sie am ersten `CREATE TABLE` — kein `IF NOT EXISTS`.

Der Stempel ist nicht geschätzt: `hash` und `created_at` kommen aus drizzles
eigenem `readMigrationFiles()`. Das zählt, weil drizzles Applied-Prüfung
**ausschliesslich `created_at`** vergleicht (`pg-core/dialect.js`: `order by
created_at desc limit 1`) — ein falscher Zeitstempel würde die Baseline später
erneut anwenden.

## Dump-Rezept für den Vergleich

```bash
pg_dump "$DATABASE_URL" --schema=public --schema-only --no-owner --no-acl
```

`--schema-only` ist nicht optional: ohne es schreibt `pg_dump` `COPY`-Zeilen mit
der **physischen** Spaltenreihenfolge, und die unterscheidet sich zwischen einer
historisch gewachsenen (`ALTER TABLE ADD COLUMN` hängt hinten an) und einer
frisch aus der Baseline gebauten Datenbank — ein Textvergleich wäre damit wertlos.

`--no-owner --no-acl` schneidet Eigentümer und Rechte weg; auf Neon kommen sonst
`neondb_owner`/`cloud_admin`/`neon_superuser` als Rauschen mit.

Für einen Vergleich müssen beide Seiten zusätzlich normalisiert werden
(Spaltenreihenfolge in `CREATE TABLE`, Statement-Reihenfolge, `_system`-Schema,
`COMMENT ON SCHEMA public`, zwei gleichwertige DEFAULT-Schreibweisen). Das
Normalisierungs-Skript des Konvergenz-Beweises liegt nicht im Repo — es ist
Beweismittel, kein Betriebsmittel; das Ergebnis steht unten.

## Konvergenz-Beweis (05.08.2026)

Die Frage: kommt eine **frisch gebaute** DB am selben Schema an wie eine
**restaurierte Prod-DB nach dem Cutover**?

| Pfad | Vorgehen |
|---|---|
| **A** | leere DB → `migrate-schema.ts` (Baseline ausführen + manual) |
| **B** | `~/prod-schema.sql` restaurieren → `migrate-schema.ts --stamp-baseline` (stempeln + manual) |

Beide Seiten mit dem Rezept oben gedumpt und normalisiert:

> **A == B, Diff 0** (je 689 Statements)

### Sanity gegen den rohen Prod-Dump

A gegen `~/prod-schema.sql` reduziert sich auf **genau sechs** Statements — alle
erklärt, keines unerwartet:

| Residual | Klasse |
|---|---|
| `audit_log_parent_deletion_id_fkey` | Cruft, gedroppt von `0002` |
| `budget_ledger_prevent_delete/update/truncate` | Cruft, gedroppt von `0001` |
| `customer_insurance_history_valid_idx` (2 statt 3 Spalten) | Prod hängt hinter `main` |
| `invoice_line_items_appointment_id_idx` (fehlt) | Prod hängt hinter `main` |

Der `appointments_prospect_or_customer_check` taucht **nicht** auf: Prod hat ihn
nicht, das Modell auch nicht.

## Der Befund, der Aufmerksamkeit braucht

Die letzten zwei Residual-Zeilen sind kein Schönheitsfehler. Sie zeigen, dass
**Stempeln eine Behauptung ist, die heute nicht stimmt**: `--stamp-baseline`
sagt „diese DB hat den Zustand, den `0000` beschreibt", aber Prod hängt hinter
`main` — seit #1893 (`88f3d3da`, Index-Spalten geändert) und #30 (`938459eb`,
Index ergänzt) wurde nicht deployt.

Ohne Gegenmassnahme würden beide Abweichungen den Cutover **überleben**: der
Stempel sagt „angewendet", der Migrator fasst die Baseline nie wieder an, und
`push` — das sie bisher stillschweigend nachgezogen hätte — ist ja gerade
abgeschafft. `migrations/manual/0002_cutover_cleanup.sql` gleicht sie deshalb
vorwärts an.

**Das ist eine Momentaufnahme, kein Mechanismus.** Die tragfähige Lösung ist ein
Preflight, der vor dem Stempeln prüft, ob die Ziel-DB der Baseline entspricht,
statt es zu unterstellen — und der abbricht, wenn nicht. Das ist bewusst nicht
Teil von A3.

## Reihenfolge beim echten Cutover

1. Prod-Schema-Dump ziehen und wegsichern (Rezept oben).
2. Dump in eine Wegwerf-DB restaurieren, Pfad B dort fahren, gegen einen frisch
   gebauten Pfad A diffen — also diesen Beweis mit **tagesaktuellem** Dump
   wiederholen. Die Residual-Liste oben ist datiert und altert.
3. Erst dann `--stamp-baseline` gegen die echte Datenbank.
4. `scripts/migrate.sh` von `push` auf den Migrator umstellen (eigener Vorgang).
