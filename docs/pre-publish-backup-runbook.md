# Pre-Publish-Backup-Runbook (Production-DB)

**Zweck:** Sicherstellen, dass vor jedem Publish, das Schema-Drops auf die Production-DB anwendet, ein vollständiger und überprüfbarer Backup-Snapshot existiert. Erstellt als Reaktion auf Task #237 / Sprint #228.

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
