# Pre-Publish-Backup-Runbook (Production-DB)

**Zweck:** Sicherstellen, dass vor jedem Publish, das Schema-Drops auf die Production-DB anwendet, ein vollständiger und überprüfbarer Backup-Snapshot existiert. Erstellt als Reaktion auf Task #237 / Sprint #228.

> **Abgrenzung:** Dieses Runbook betrifft die **Production-DB** (`PROD_DATABASE_URL`). Für die **Entwicklungs-DB** — Reseed auf eine saubere synthetische Basis (`npm run db:reseed-dev`) und Pre-Phase-Backup (`npm run db:backup-dev`) — siehe [`dev-database-runbook.md`](dev-database-runbook.md).

> **Wichtig:** Replit/Neon liefert für die produktive Datenbank **automatische Point-in-Time-Recovery (PITR)** mit. Dieses Runbook ergänzt PITR um einen lokal kontrollierten `pg_dump`, damit
> 1. ein Restore auch ohne Replit-Support möglich ist und
> 2. die genau betroffenen Spalten/Tabellen einzeln wiederhergestellt werden können.

---

## 1. Wann anwenden?

Vor **jedem** Publish, der mindestens eines der folgenden Risiken trägt:
- `drizzle-kit push` würde Spalten oder Tabellen löschen (`DROP COLUMN`, `DROP TABLE`).
- Migration enthält `ALTER TABLE … DROP …`, `TRUNCATE` oder Datenmigrationen, die nicht idempotent sind.
- Ein neuer Constraint wird hinzugefügt, der bestehende Zeilen ablehnen könnte.

**Aktueller Anlass (Sprint #228):** Drops von
- `appointments.services_done` (~735 Zeilen, 0 davon befüllt)
- `customer_contracts.hauswirtschaft_rate_cents`, `alltagsbegleitung_rate_cents`, `kilometer_rate_cents` (je 108 Zeilen, alle Werte = 0)
- Tabelle `customer_pricing_history` (Prod: leer)

Quelle: `docs/schema-audit-report.md`, §1 + §4.

---

## 2. Voraussetzungen

| Punkt | Wie prüfen |
|---|---|
| `pg_dump` 16+ im PATH | `pg_dump --version` |
| `psql` im PATH | `psql --version` |
| `PROD_DATABASE_URL` gesetzt | Connection-String aus dem **Replit Publishing-Tab → Environment**. Format: `postgres://user:pw@host:5432/dbname` |
| Schreibrecht auf `tmp/db-backups/` | `mkdir -p tmp/db-backups` |
| Genügend Platz | Aktueller Prod-Datenbestand: ~8.400 Zeilen. Dump <50 MB erwartet. |

> **Sicherheits-Hinweis:** `PROD_DATABASE_URL` ist ein Secret. Niemals committen, niemals in Logs schreiben, nach dem Backup `unset PROD_DATABASE_URL`.

---

## 3. Backup-Schritte

### 3.1 Vollständiger pg_dump (Pflicht)

```bash
export PROD_DATABASE_URL="postgres://..."   # aus Publishing-Tab
BACKUP_LABEL="-pre-sprint-228" bash scripts/backup-prod-db.sh
```

Erzeugt zwei Dateien in `tmp/db-backups/`:
- `prod-<TIMESTAMP>-pre-sprint-228.dump` — Custom-Format, restore via `pg_restore`
- `prod-<TIMESTAMP>-pre-sprint-228.sql.gz` — Plain-SQL, gzipped, lesbar/grep-bar

Das Skript gibt am Ende SHA256-Summen aus → für Schritt 4 mitschreiben.

> **Konsistenz-Hinweis (aus Restore-Drill 2026-04-28, Task #239):** Die zwei Dumps werden in **getrennten** `pg_dump`-Aufrufen gezogen. Jeder Dump ist intern transaktional konsistent, aber Custom- und Plain-Dump können sich um wenige Zeilen unterscheiden, falls die App parallel schreibt. **Empfehlung:** Vor `Publish` im Replit-Tab die App pausieren / keine aktiven Workflows laufen lassen, dann starten — beide Dumps stimmen dann auf die Zeile genau überein.

### 3.2 Fokus-Snapshot der betroffenen Daten (Pflicht für Sprint #228)

```bash
bash scripts/backup-affected-tables.sh
```

Erzeugt unter `tmp/db-backups/affected-<TIMESTAMP>/`:
- `affected-tables.sql.gz` — Schema + Daten der drei betroffenen Tabellen
- `appointments_services_done.csv` — Nur Zeilen mit echtem Inhalt (erwartet: 0)
- `customer_contracts_legacy_rates.csv` — Alle Verträge mit Legacy-Rate-Spalten
- `customer_pricing_history.csv` — Tabelle (erwartet: leer)
- `row-count-report.txt` — Zählungen pro Spalte/Tabelle

> **Task #743 (DROP `customer_budgets`)**: Vor dem Publish zusätzlich einen separaten Snapshot der frozen Legacy-Tabelle ziehen, da die Startup-Migration die Tabelle idempotent droppt und sie danach nicht mehr rekonstruierbar ist:
> ```bash
> pg_dump "$DATABASE_URL" --table=customer_budgets --data-only --format=plain \
>   | gzip > tmp/db-backups/customer_budgets-pre-drop-$(date +%Y%m%d_%H%M%S).sql.gz
> psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM customer_budgets;" \
>   >> tmp/db-backups/row-count-report.txt
> ```
> Snapshot mindestens 10 Jahre aufbewahren (GoBD: historische Budget-Stammdaten).

### 3.3 Backup an sicheren Ort kopieren

`tmp/db-backups/` liegt nur in der Repl. Vor dem Publish:
- Inhalte **lokal herunterladen** (rechte Maustaste auf den Ordner im Files-Tab → Download).
- Optional: in den firmeneigenen Cloud-Speicher (z.B. Nextcloud, Google Drive) verschieben.

> **Aufbewahrung:** mindestens 30 Tage nach erfolgreichem Publish. Bei GoBD-Relevanz (Pflegedokumentation): 10 Jahre — derzeit nicht der Fall, da die betroffenen Spalten leer/konstant sind.

---

## 4. Automatisches Replit/Neon-Backup verifizieren

Replit-Postgres (Neon) hält automatisch Point-in-Time-Backups vor.

1. Im Replit-Workspace: **Tools → Database → Backups / History** öffnen.
2. Sicherstellen, dass der jüngste Snapshot **≤ 1 Stunde alt** ist.
3. Falls älter: einen manuellen Snapshot anstoßen (Button im selben Tab) und auf Fertigstellung warten, bevor publish ausgelöst wird.
4. Ergebnis in `docs/deployment-log.md` notieren.

---

## 5. Eintrag in docs/deployment-log.md

Pflicht. Nach dem Backup, vor dem Klick auf „Publish":

```markdown
### YYYY-MM-DD HH:MM UTC — Pre-Publish-Backup für <Sprint-/Task-Nr.>
- Anlass: <kurz, z.B. „DROP COLUMNs aus Sprint #228">
- Voller Dump: tmp/db-backups/prod-<TIMESTAMP>-pre-sprint-228.dump (SHA256: …)
- Plain-Dump: tmp/db-backups/prod-<TIMESTAMP>-pre-sprint-228.sql.gz (SHA256: …)
- Fokus-Snapshot: tmp/db-backups/affected-<TIMESTAMP>/ (Inhalte: <Liste>)
- Replit-Auto-Backup jüngster Snapshot: YYYY-MM-DD HH:MM UTC (≤ 1h alt: ja/nein)
- Lokaler Ablageort: <Pfad oder Cloud-URL>
- Durchgeführt von: <Name>
```

---

## 6. Rollback (falls der Drop fehlerhaft ist)

### 6.1 Komplette DB

```bash
# Option A: Replit/Neon PITR (bevorzugt — schneller, keine lokalen Dateien nötig)
# → Tools → Database → Backups → "Restore to point in time" auswählen,
#   Zeitpunkt unmittelbar vor dem Publish wählen.

# Option B: pg_restore aus lokalem Dump
pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  --dbname="$PROD_DATABASE_URL" \
  tmp/db-backups/prod-<TIMESTAMP>-pre-sprint-228.dump
```

### 6.2 Nur die betroffenen Spalten/Tabelle wiederherstellen

Falls nach dem Drop bemerkt wird, dass doch produktive Daten existierten (sollte laut Audit nicht der Fall sein, aber Safety-Net):

```bash
# 1. Spalten/Tabelle in Prod neu anlegen (Schema aus dem Dump extrahieren)
gunzip -c tmp/db-backups/affected-<TIMESTAMP>/affected-tables.sql.gz \
  | grep -E "^(CREATE TABLE|ALTER TABLE.*ADD COLUMN)" \
  | psql "$PROD_DATABASE_URL"

# 2. Daten zurückspielen (nur die drei Tabellen)
gunzip -c tmp/db-backups/affected-<TIMESTAMP>/affected-tables.sql.gz \
  | psql "$PROD_DATABASE_URL"
```

CSV-Variante (für punktuelle Korrekturen):

```bash
psql "$PROD_DATABASE_URL" \
  -c "\copy public.customer_pricing_history FROM 'tmp/db-backups/affected-<TIMESTAMP>/customer_pricing_history.csv' WITH CSV HEADER"
```

---

## 7. Checkliste vor „Publish" klicken

- [ ] `scripts/backup-prod-db.sh` erfolgreich gelaufen, SHA256 notiert
- [ ] `scripts/backup-affected-tables.sh` erfolgreich gelaufen, Row-Count-Report geprüft
- [ ] `tmp/db-backups/` lokal heruntergeladen / in sicherem Cloud-Storage abgelegt
- [ ] Replit/Neon-Auto-Backup ≤ 1 h alt verifiziert
- [ ] Eintrag in `docs/deployment-log.md` ergänzt
- [ ] `unset PROD_DATABASE_URL` in der aktuellen Shell

Erst danach: Publish.

---

## 8. Automatischer Backup-Gate (Task #240)

Damit der manuelle Schritt nicht vergessen wird, gibt es zwei Sicherheitsnetze:

### 8.1 Build-Warnung

Sowohl `npm run build` (`script/build.ts`) als auch der Deployment-Startup-Check
(`script/check-build.mjs`) führen am Ende `script/check-pre-publish-backup.mjs` aus.
Das Skript scannt die jüngste Datei in `migrations/` auf `DROP COLUMN`/`DROP TABLE`
und prüft `tmp/db-backups/` auf eine Datei, die **jünger als 24 Stunden** ist.

- Keine destruktive Migration → keine Warnung.
- Destruktive Migration + frisches Backup vorhanden → Hinweis mit Pfad und Alter.
- Destruktive Migration + **kein** frisches Backup → deutliche Warnung mit Verweis
  auf dieses Runbook. **Der Build bricht NICHT ab** (Backups werden bewusst nicht
  ins Repo eingecheckt — der Warnhinweis ist ein Reminder, kein Fehler).

### 8.2 Pre-Publish-Checkliste auf der Konsole

Vor dem Klick auf „Publish" empfohlen:

```bash
node script/preflight-publish.mjs
```

Das Skript hakt automatisch ab, was es prüfen kann (Backup-Datei < 24 h alt,
destruktive Statements in der jüngsten Migration), und listet die manuellen
Restpunkte (Replit-Auto-Backup verifizieren, Eintrag in `docs/deployment-log.md`,
`unset PROD_DATABASE_URL`) auf.

---

## 9. Legacy-Rechnungs-/LN-PDF-Restore aus Backup (Task #1050)

### 9.1 Problem

Vor Task #1042 überschrieben Dev-/Test-Läufe im geteilten Object-Storage-Bucket
PRODUKTIONS-PDF-Bytes (kollidierende Rechnungsnummern). Die DB blieb intakt
(`pdf_hash`, `zugferd_xml`, `render_snapshot`). Der Re-Render-Pfad
`server/scripts/regenerate-clobbered-invoice-pdfs.ts` (Task #1043) rendert solche
PDFs aus dem versiegelten Snapshot neu und schreibt sie NUR zurück, wenn der
Re-Render den versiegelten `pdf_hash` byte-genau reproduziert.

Für **Altbestände aus der „Wall-Clock-Ära" (pre-#1047)** gelingt das NIE: Task
#1047 versiegelt den Erzeugungszeitpunkt einmalig im `render_snapshot`
(`pdfCreationDate`) und macht das PDF damit byte-reproduzierbar. PDFs, die VOR
#1047 erzeugt wurden, haben dieses Feld nicht — ihre Original-Bytes trugen eine
verlorene Wall-Clock-`/CreationDate` (+ XMP-Zeitstempel + zufällige Datei-`/ID`).
Der Re-Render-Hash weicht deshalb immer ab, und das Objekt wird (korrekt,
GoBD-sicher) nur **geflaggt** statt überschrieben.

Diese Altbestände lassen sich nur reparieren, indem die ORIGINAL-Bytes aus einem
Backup zurückgeschrieben werden — und auch dann NUR, wenn die Backup-Bytes den
versiegelten `pdf_hash` byte-genau reproduzieren.

### 9.2 Wie viele sind betroffen? (Inventur / Census)

`server/scripts/regenerate-clobbered-invoice-pdfs.ts` beziffert die Altbestände
jetzt direkt: Im Trockenlauf zeigt die Zusammenfassung neben `Geflaggt` zusätzlich
`davon Legacy (pre-#1047, Backup nötig)`. Pro Objekt steht im
`flagReason`, ob es ein Legacy-Bestand ist (`pdfCreationDateSealed === false`).

Reine Legacy-Inventur (kein Backup nötig, schreibt nie):

```bash
tsx server/scripts/restore-legacy-invoice-pdfs-from-backup.ts
```

Census-Ausgabe: `Geprüfte Legacy-Objekte`, `Bereits korrekt`,
`Geflaggt (kein Backup)`. Damit ist quantifizierbar, wie viele Altbestände noch
verklobbert/fehlend sind und warum.

### 9.3 Backup-Original beschaffen

Quelle der Original-Bytes (in Reihenfolge der Präferenz):
1. **Lokal heruntergeladene Object-Storage-Snapshots** aus früheren Pre-Publish-
   Backups (Abschnitt 3.3) — falls die PDFs damals mitgesichert wurden.
2. **Die ursprünglich versendeten PDFs** (E-Mail-Anhänge an Pflegekasse/Kunde,
   postalischer LetterExpress-Versand-Archiv).
3. Replit/Neon-PITR hilft NICHT — Object Storage liegt außerhalb der DB.

Die Original-Dateien in ein lokales Verzeichnis legen, z.B. `tmp/pdf-backup/`.
Pro Objekt werden mehrere Pfade probiert (erster Treffer gewinnt):
- `<backup-dir>/<object-key>` (z.B. `tmp/pdf-backup/invoices/RE-2026-0034.pdf`)
- `<backup-dir>/<basename>` (z.B. `tmp/pdf-backup/RE-2026-0034.pdf`)

Der Leistungsnachweis trägt den Suffix `-leistungsnachweis.pdf` (wie im
Object-Key).

### 9.4 Restore durchführen

```bash
# 1. Trockenlauf mit Backup (read-only, prüft Hash-Reproduktion, schreibt nie):
tsx server/scripts/restore-legacy-invoice-pdfs-from-backup.ts \
  --backup-dir=tmp/pdf-backup

# 2. Scharf (schreibt verbatim die Original-Bytes zurück + Append-only-Audit):
tsx server/scripts/restore-legacy-invoice-pdfs-from-backup.ts \
  --backup-dir=tmp/pdf-backup --apply \
  --user=<superadmin-id> --reason="Legacy-PDF-Restore Task #1050"
```

Optionale Eingrenzung: `--customer=<id,id>` oder `--invoice=<id,id>`.

Die Zusammenfassung beziffert das Ergebnis vollständig:
- `Aus Backup wiederhergestellt` — Backup reproduziert `pdf_hash` byte-genau.
- `Geflaggt (kein Backup)` — kein Original im Backup-Verzeichnis gefunden.
- `Geflaggt (Hash-Mismatch)` — Backup gefunden, reproduziert den `pdf_hash`
  aber NICHT → falsche/abweichende Sicherung, manuelle GoBD-Prüfung nötig.

### 9.5 GoBD-Garantien des Skripts

- `pdf_hash`, `zugferd_xml`, `render_snapshot` und alle anderen versiegelten
  Rechnungs-Felder werden NIE mutiert. Geschrieben werden ausschließlich
  Object-Storage-Bytes (verbatim auf den gespeicherten `pdf_path`) und ein
  Append-only-Audit-Eintrag (`invoice_pdf_restored_from_backup`).
- Harter Hash-Gate: ein Backup-Original wird NUR akzeptiert, wenn es den
  versiegelten `pdf_hash` byte-genau reproduziert. Fehlendes/abweichendes Backup
  führt NIE zu einem stillen Überschreiben.
- Trockenlauf ist Default; `--apply` erfordert `--backup-dir`, einen aktiven
  Superadmin (`--user`) und eine Begründung (`--reason`, ≥10 Zeichen) für den
  Audit-Log.
- Der Restore schreibt verbatim auf den gespeicherten `pdf_path`. In Produktion
  ist das der nackte `invoices/…`-Key; aus einer Nicht-Produktions-Umgebung bricht
  `assertInvoicePdfWriteKeyAllowed` einen Schreibzugriff auf den Produktions-
  Key-Space hart ab.

### 9.6 Wenn kein byte-genaues Backup existiert

Bleibt ein Legacy-Objekt nach allen Backup-Quellen `Geflaggt (kein Backup)` oder
`Geflaggt (Hash-Mismatch)`, ist es NICHT automatisch reparierbar. Optionen:
- Den verbleibenden Bestand dokumentieren (Census-Ausgabe + Begründung) und als
  bekannten Restposten im `docs/deployment-log.md` festhalten.
- Das versiegelte ZUGFeRD-XML (`zugferd_xml`) bleibt in der DB als
  GoBD-konformer, maschinenlesbarer Beleg erhalten — der `pdf_hash` belegt
  weiterhin die Integrität des ursprünglichen Belegs, auch wenn die PDF-Bytes
  selbst nicht mehr beschaffbar sind.
