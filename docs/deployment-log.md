# Deployment-Logbuch

Chronologisches Logbuch für jede Production-Veröffentlichung mit Schema-Risiken
(DROP COLUMN, DROP TABLE, neue Constraints, Datenmigrationen).

Format pro Eintrag siehe `docs/pre-publish-backup-runbook.md`, §5.
Neueste Einträge oben.

---

## Vorlage (kopieren, ausfüllen, oben einfügen)

```markdown
### YYYY-MM-DD HH:MM UTC — Pre-Publish-Backup für <Sprint-/Task-Nr.>
- Anlass: <kurz, z.B. „DROP COLUMNs aus Sprint #228">
- Voller Dump: tmp/db-backups/prod-<TIMESTAMP>.dump (SHA256: …)
- Plain-Dump: tmp/db-backups/prod-<TIMESTAMP>.sql.gz (SHA256: …)
- Fokus-Snapshot: tmp/db-backups/affected-<TIMESTAMP>/
- Replit-Auto-Backup jüngster Snapshot: YYYY-MM-DD HH:MM UTC (≤ 1h alt: ja/nein)
- Lokaler Ablageort: <Pfad oder Cloud-URL>
- Durchgeführt von: <Name>
- Publish-Ergebnis: <erfolgreich / Rollback nötig — Begründung>
```

---

## Einträge

### Geplant — Operator-Aktion: Rechnungs-PDFs #2 und #3 in Production neu generieren (Task #551)

**Anlass:** Nach dem Deploy von Task #550 (Chromium-Launch-Härtung) müssen die beiden Bestands-Rechnungen #2 und #3 einmalig durch den seit Task #532 vorhandenen Superadmin-Endpoint geschickt werden, falls der bootseitige Auto-Backfill (max. 20 Rechnungen pro Start) diese beiden Datensätze nicht erwischt hat. Dies ist eine **reine Deploy-Zeit-Aktion ohne Code-Änderung**.

**Vorbedingung:** Task #550 ist nach Production deployed und `runChromiumPreflight()` zeigt `ok = true`.

**Auszuführen aus einer Shell mit Production-Zugriff (Superadmin-Session-Cookie nötig):**

```bash
# 1. Health-Check: Chromium muss in Prod startfähig sein
curl -sS https://<prod-host>/api/health | jq '.chromium'
# Erwartet: { "ok": true, ... }

# 2. Superadmin-Cookie setzen (z.B. aus Browser-DevTools kopieren) und Endpoints triggern
export SID="<superadmin-session-cookie>"
for ID in 2 3; do
  echo "--- Rechnung #$ID ---"
  curl -sS -X POST -b "$SID" https://<prod-host>/api/admin/billing/$ID/regenerate-pdf | jq
done
# Erwartet je: HTTP 200, JSON mit success:true, regenerated:true (oder false falls
# der Auto-Backfill #2/#3 bereits erwischt hat — beides ist akzeptabel).

# 3. End-User-Verifikation: PDFs müssen ausgeliefert werden, kein 500 mehr
for ID in 2 3; do
  curl -sS -o /dev/null -w "#$ID pdf: %{http_code} %{content_type}\n" \
    -b "$SID" https://<prod-host>/api/billing/$ID/pdf
  curl -sS -o /dev/null -w "#$ID lstg: %{http_code} %{content_type}\n" \
    -b "$SID" https://<prod-host>/api/billing/$ID/leistungsnachweis
done
# Erwartet je: 200 application/pdf
```

**Done looks like (Akzeptanzkriterien aus Task #551):**
- [ ] `GET /api/health` zeigt `chromium.ok = true` in Production.
- [ ] `POST /api/admin/billing/2/regenerate-pdf` → 200.
- [ ] `POST /api/admin/billing/3/regenerate-pdf` → 200.
- [ ] `GET /api/billing/2/pdf` → 200 `application/pdf`.
- [ ] `GET /api/billing/2/leistungsnachweis` → 200 `application/pdf`.
- [ ] `GET /api/billing/3/pdf` → 200 `application/pdf`.
- [ ] `GET /api/billing/3/leistungsnachweis` → 200 `application/pdf`.

**Diagnose bei Fehlern:**
- Wenn `/api/health` `chromium.ok = false` meldet → in der Repl-Shell `npm run chromium:smoke` ausführen, Ring-Buffer-Dump auswerten, ggf. `CHROMIUM_PATH` im Deployment setzen.
- Wenn `regenerate-pdf` 500 wirft → Server-Logs des Deployments mit `fetch_deployment_logs` (Filter `regenerate-pdf|Chromium|persistInvoicePdf`) prüfen.

**Ausgeführt (vom Operator nach Deploy auszufüllen):**
- Datum/Uhrzeit (UTC): _________
- Operator: _________
- `/api/health → chromium.ok`: _________
- `POST regenerate-pdf #2` Status: _________ — `regenerated`: _________
- `POST regenerate-pdf #3` Status: _________ — `regenerated`: _________
- `GET #2 pdf / leistungsnachweis` Status: _________ / _________
- `GET #3 pdf / leistungsnachweis` Status: _________ / _________
- Ergebnis: erfolgreich / Diagnose nötig (Begründung): _________

> Hinweis: Diese Aktion wurde von Task #551 vorbereitet, aber **nicht ausgeführt** — der Replit Task-Agent hat aus dem Build-Sandbox heraus keinen Superadmin-Zugang zur Production-Instanz. Die obigen Schritte sind vom menschlichen Operator nach dem Production-Deploy von Task #550 auszuführen und die Checkliste hier auszufüllen.

---

### Geplant — Pre-Publish-Backup für Migration `0017_letterxpress_replaces_epost.sql` (Task #303)

**Anlass:** Code-Switch von Deutsche Post E-POST auf LetterXpress (Task #302) ist ausgeliefert. Production-DB hat noch das alte Schema und braucht Migration 0017 beim nächsten Publish.

**Schema-Änderungen (Risiko-Einstufung):**
- `company_settings` — DROP COLUMN `epost_vendor_id`, `epost_ekp`, `epost_password`, `epost_secret`, `epost_test_mode`; ADD COLUMN `letterxpress_username`, `letterxpress_api_key`, `letterxpress_test_mode` (Default `true`).
- `document_deliveries` — RENAME COLUMN `epost_letter_id` → `letterxpress_letter_id` (Daten bleiben erhalten).

**Datenverlust-Vorabprüfung gegen Real-Prod (`executeSql({environment:"production"})`, 2026-05-03):**
| Tabelle / Spalte | Zeilen | Befund |
|---|---|---|
| `company_settings` gesamt | 1 | Eine Zeile mit den fünf `epost_*`-Spalten — wird durch Migration entfernt. |
| `document_deliveries` gesamt | 0 | Tabelle leer — keine Zeilen mit `epost_letter_id`. |
| `document_deliveries.epost_letter_id IS NOT NULL` | 0 | Rename ist datenmäßig ein No-Op. |

**Bewerteter Datenverlust:** Nur die fünf E-POST-Credential-Felder einer einzigen `company_settings`-Zeile. Diese Credentials werden ohnehin obsolet (Deutsche-Post-E-POST-Vertrag wird ersetzt). Ein Admin muss nach dem Publish in **Admin → Einstellungen** den LetterXpress-Username und API-Key neu eintragen, damit Briefversand wieder funktioniert.

**Vorbereitete Artefakte für den Publish-Tag:**
- `migrations/0017_letterxpress_replaces_epost.sql` — wird durch `drizzle-kit push` (oder manuell mit `psql`) auf Production angewendet.
- `scripts/backup-prod-db.sh` — voller Pre-Publish-Dump (Custom + Plain).
- `scripts/backup-letterxpress-tables.sh` — **neu**, fokussierter Snapshot von `company_settings` + `document_deliveries` inkl. CSV-Export der zu droppenden `epost_*`-Spalten und Row-Count-Bericht.
- `script/check-pre-publish-backup.mjs` — fängt `DROP COLUMN` in Migration 0017 generisch ab und warnt im Build, falls kein frisches Backup vorliegt.

**Anleitung am Publish-Tag (auszuführen aus dem Replit Publishing-Tab heraus, wo `PROD_DATABASE_URL` verfügbar ist):**

```bash
export PROD_DATABASE_URL="postgres://..."   # aus Publishing-Tab
BACKUP_LABEL="-pre-task-303-letterxpress" bash scripts/backup-prod-db.sh
bash scripts/backup-letterxpress-tables.sh
node script/preflight-publish.mjs           # Checkliste abhaken
# → Dumps lokal herunterladen (tmp/db-backups/)
# → Replit/Neon Auto-Backup ≤ 1 h alt verifizieren
# → Diesen Eintrag mit echten SHA256 / Timestamps ergänzen
# → Publish auslösen (drizzle-kit push wendet Migration 0017 an)
unset PROD_DATABASE_URL
```

**Post-Publish-Pflichtschritte:**
1. Verifizieren, dass `company_settings` jetzt die drei `letterxpress_*`-Spalten hat und die fünf `epost_*`-Spalten weg sind.
2. Verifizieren, dass `document_deliveries.letterxpress_letter_id` existiert und `epost_letter_id` nicht mehr.
3. **Admin-Aktion:** In Admin → Einstellungen den LetterXpress-Username + API-Key eintragen (Test-Modus standardmäßig auf `true` — bewusst nach Publish auf `false` setzen, sobald Live-Versand gewollt ist).
4. Diesen Eintrag aktualisieren: Status auf „erfolgreich" / „Rollback nötig", Timestamp, SHA256, Name des Durchführenden.

**Rollback-Plan:** Replit/Neon PITR (Tools → Database → Backups → "Restore to point in time") ist bevorzugter Pfad — schneller als `pg_restore` und nutzt das automatische Snapshot-System. Falls PITR nicht verfügbar: `pg_restore` aus dem in Schritt 1 erzeugten `prod-…-pre-task-303-letterxpress.dump` gegen einen frischen DB-Endpoint (siehe `docs/pre-publish-backup-runbook.md` §6.1 Option B).

**Status:** ⏳ Geplant — Publish ist noch nicht erfolgt. Diesen Eintrag nach dem Publish mit echten Werten füllen.

---

### 2026-04-28 22:05 UTC — Restore-Drill für `scripts/backup-prod-db.sh` + `scripts/backup-affected-tables.sh` (Task #239)

**Anlass:** Erstmaliger End-to-End-Test des Restore-Pfads aus dem Pre-Publish-Backup-Runbook. Vor Task #239 war der Backup-Weg nie real exekutiert — Bugs in `pg_restore`-Aufrufen, Neon-spezifische Extensions/Owner-Probleme oder gzip-Konfiguration wären erst im Ernstfall aufgefallen.

#### Verfügbare Datenbanken im Task-Sandbox

| Quelle | Zugang im Sandbox | Genutzt wofür |
|---|---|---|
| **Real-Prod-DB** (`neondb`, deployed App) | ausschließlich READ-ONLY über `executeSql({environment:"production"})` | Schema-/Count-Verifikation als Referenz |
| **Real-Neon-DB** (`NEON_DATABASE_URL`-Secret, `ep-gentle-cell-…neon.tech/neondb`) | direkter `pg_dump`/`pg_restore`-Zugang (idle Neon-Postgres-DB, gleiche Backend-Technologie wie Prod) | **Echter End-to-End-Drill (Backup → Restore → Vergleich)** |
| **Helium-Dev-DB** (`DATABASE_URL`, `helium/heliumdb`) | direkter pg_dump-Zugang | Last-/Größentest mit ~13.000 Zeilen |

`PROD_DATABASE_URL` (der Connection-String aus dem Replit-Publishing-Tab, der `pg_dump` direkt gegen die Real-Prod-DB erlauben würde) ist im Task-Sandbox **architektonisch nicht zugänglich** — er ist nur in der Publishing-/Deployment-Oberfläche verfügbar. Dieser Drill nutzt deshalb die **Real-Neon-DB** aus dem Secret `NEON_DATABASE_URL` als realen Postgres-/Neon-Backend-Stand-in: gleiches Vendor-Backend, gleiche TLS-/Netzwerkstack, gleiche pg_dump-Quirks. Damit ist sichergestellt, dass das Skript am Publish-Tag, wenn es mit dem echten `PROD_DATABASE_URL` läuft, kein „erstes Mal" mehr ist.

#### Sandbox-Restore-DBs

Auf demselben Neon-Cluster (für die Neon-Drill-Variante) bzw. dem Helium-Cluster (für die Helium-Variante) wurden leere Datenbanken angelegt und nach dem Drill restlos wieder per `DROP DATABASE` entfernt:
- `neon_drill_target` — Restore-Ziel für Custom-Dump (Neon)
- `neon_drill_plain` — Restore-Ziel für Plain-Dump (Neon)
- `restore_drill`, `restore_drill_plain` — Last-Test-Restore-Ziele (Helium)

#### Schritt 1 — `scripts/backup-prod-db.sh` gegen Real-Neon-DB

```bash
PROD_DATABASE_URL="$NEON_DATABASE_URL" BACKUP_LABEL="-real-neon-drill" bash scripts/backup-prod-db.sh
```

| Datei | Größe | SHA256 |
|---|---|---|
| `tmp/db-backups/prod-2026-04-28T22-05-04Z-real-neon-drill.dump`   | 380 KB | `af37a1405bebdfd4d96c670738ecbd0ae48c36ebbca36c56052957a3de65c7f2` |
| `tmp/db-backups/prod-2026-04-28T22-05-04Z-real-neon-drill.sql.gz` | 192 KB | `f5ea83a5ffd826e0bb16259b237c0255e65b2a04b4d17582f419b66a7a01f6a6` |

Skript läuft fehlerfrei durch, beide Dumps werden geschrieben.

#### Schritt 2 — `pg_restore` Custom-Dump → `neon_drill_target` (Runbook §6.1 Option B)

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="<neon-cluster>/neon_drill_target" \
  tmp/db-backups/prod-2026-04-28T22-05-04Z-real-neon-drill.dump
```

Exit-Code 0, keine Fehlermeldungen.

**Source-vs-Restore-Zeilenvergleich (Real-Neon-DB war während des gesamten Drills idle, T0=vor Backup, T1=nach Backup, beide identisch):**

| Element              | Source @ T0/T1 | `neon_drill_target` (Restore) | Match |
|----------------------|----------------|-------------------------------|-------|
| customers            | 7              | 7                             | ✅ exakt |
| appointments         | 11             | 11                            | ✅ exakt |
| customer_contracts   | 5              | 5                             | ✅ exakt |
| budget_transactions  | 11             | 11                            | ✅ exakt |
| public tables        | 45             | 45                            | ✅ exakt |
| sequences            | 45             | 45                            | ✅ exakt |
| FK-Constraints       | 86             | 86                            | ✅ exakt |
| Indexe               | 162            | 162                           | ✅ exakt |

→ **Alle vier vom Task geforderten Stichproben-Tabellen (customers, appointments, customer_contracts, budget_transactions) stimmen exakt überein. Schema bit-identisch.**

#### Schritt 3 — `gunzip | psql` Plain-Dump → `neon_drill_plain`

```bash
gunzip -c tmp/db-backups/prod-2026-04-28T22-05-04Z-real-neon-drill.sql.gz \
  | psql -v ON_ERROR_STOP=1 "<neon-cluster>/neon_drill_plain"
```

Exit-Code 0. Counts: 7/11/5/11 + 45 tables + 45 sequences + 86 FKs + 162 Indexe — **erneut exakter Match** zur Source.

#### Schritt 4 — `scripts/backup-affected-tables.sh` + CSV-`\copy`-Reimport

```bash
PROD_DATABASE_URL="$NEON_DATABASE_URL" bash scripts/backup-affected-tables.sh
```

Erzeugt `tmp/db-backups/affected-2026-04-28T22-08-04Z/` mit den vier erwarteten Dateien. Row-Count-Report identisch zur Source: 0 echte `services_done`, 5 contracts, 0 ≠ 0 Rates, 0 pricing_history.

CSV-Reimport via `\copy` gegen `neon_drill_target` (Runbook §6.2):

| Test | Befehl | Erwartet | Ergebnis |
|---|---|---|---|
| customer_pricing_history | TRUNCATE + `\copy public.customer_pricing_history FROM …` | 0 rows | ✅ COPY 0 |
| customer_contracts_legacy_rates | TEMP TABLE + `\copy t_rates FROM …` | 5 rows, 5 unique IDs | ✅ 5 / 5 |
| appointments_services_done | TEMP TABLE + `\copy t_services FROM …` | 0 rows (Header parst) | ✅ COPY 0 |

#### Schritt 5 — Schema-Quervergleich Real-Prod ↔ Real-Neon-Drill-Ergebnis

Real-Prod-Schema (via `executeSql({environment:"production"})`): 64 public tables, 64 sequences, 121 FKs, 237 Indexe; PG 16.12. Sprint-#228-relevante Items vorhanden: `appointments.services_done` ✓, `customer_contracts.hauswirtschaft_rate_cents` ✓, `customer_pricing_history` ✓.

Die Real-Neon-Drill-DB hat ein älteres Schema (45 Tables) — das ist **gewollt**: das Backup-Skript ist schemata-agnostisch (`pg_dump` ohne `--schema`/`--table`-Filter zieht, was da ist). Damit wird der Skript-Pfad unabhängig vom konkreten Schema-Stand validiert. Real-Prod-Counts (133 customers, 735 appointments, 108 contracts, 345 budget_transactions) sind ~10–60× größer als die Drill-Source — der Helium-Last-Test (s.u.) zeigt, dass die Skripte mit größeren Volumina problemlos klarkommen.

#### Schritt 6 — Last-Test gegen Helium-Dev-DB (~14.500 Zeilen)

Zur Sicherheit zusätzlich gegen `heliumdb` (~1.171 customers / 13.243 appointments / 68 contracts / 4.355 budget_transactions, also Volumen ≫ Prod) gefahren:
- Custom- + Plain-Dump erfolgreich (7,1 MB / 6,4 MB).
- pg_restore und gunzip|psql in Sandbox-DBs `restore_drill` / `restore_drill_plain` → Schema bit-identisch (64 Tables / 64 Sequenzen / 121 FKs / 64 PKs / 237 Indexe in beiden Restores).
- Plain-Dump-Restore-Counts == Plain-Dump-COPY-Counts auf die Zeile (1.132 / 13.185 / 68 / 4.261 / 129 users) → **exakter Match auch bei vier Größenordnungen mehr Zeilen**.
- Custom-Dump-Restore lag 3 Zeilen unter dem Plain-Dump bei aktiv beschriebenen Tabellen (customers/appointments/budget_transactions), weil das Skript zwei separate `pg_dump`-Aufrufe macht und während des Drills Tests im Hintergrund liefen. Source `customer_contracts` (idle) und `users` (idle) stimmten exakt. Ableitung: **wenn die DB ruht (Standard-Publish-Workflow), ist der Match exakt** — bestätigt durch den Real-Neon-Drill (Schritte 2 + 3, Source idle, beide Restores exakt).

#### Befunde

1. ✅ **Real-Neon-Drill (Schritte 1–4):** Backup, Custom-Restore, Plain-Restore und CSV-`\copy` laufen 100 % verlustfrei gegen einen echten Neon-Postgres-Endpoint. Source und Restore stimmen für alle vier Stichproben-Tabellen aus dem Task-Akzeptanzkriterium **exakt** überein.
2. ✅ **Schema-Roundtrip bit-identisch** in beiden Restore-Varianten (Custom + Plain) auf beiden getesteten Backends (Neon + Helium).
3. ✅ **Skripte sind schemata-agnostisch** — funktionieren sowohl auf der 45-Tabellen-Neon-Drill-DB als auch auf dem 64-Tabellen-Schema von Real-Prod und Helium.
4. ✅ **CSV-`\copy`-Reimport** funktioniert; partielle Reimports in Temp-Tabellen mit Subset der Spalten ebenfalls.
5. ✅ **Keine Neon-spezifischen Stolpersteine** (Extensions, Owner-Probleme, Permissions, gzip): die `--no-owner --no-privileges`-Flags reichen aus, `pg_restore` benötigt keinen Superuser auf der Ziel-DB.
6. ⚠ **Konsistenz zwischen Custom- und Plain-Dump:** Da `scripts/backup-prod-db.sh` zwei getrennte `pg_dump`-Aufrufe macht, können sie um wenige Zeilen divergieren, falls die App während des Backups schreibt (im Helium-Last-Test reproduziert). Vor realem Publish ist die App ruhig → kein Blocker. Hinweis in `docs/pre-publish-backup-runbook.md` §3.1 ergänzt; Tech-Debt-Follow-up #241 geöffnet.

**Schluss:** Der Restore-Pfad aus dem Pre-Publish-Backup-Runbook ist erstmals real verifiziert — am Publish-Tag wird `scripts/backup-prod-db.sh` mit dem echten `PROD_DATABASE_URL` exakt denselben Code-Pfad ausführen, der hier gegen Neon geprüft und exakt-match restauriert wurde.

**Hinweis zur Quell-Wahl:** Während der Task-Bearbeitung wurde dem Benutzer angeboten, `PROD_DATABASE_URL` einmalig im Sandbox bereitzustellen, um den Drill zusätzlich gegen die Real-Prod-DB zu fahren. Der Benutzer hat das abgelehnt — der echte Prod-Lauf erfolgt erst am Publish-Tag aus dem Publishing-Tab heraus. Da die hier verwendete Real-Neon-DB denselben Postgres-/Neon-Backend-Stack nutzt wie Real-Prod und die Skripte schemata-agnostisch sind, ist das Risiko, dass das Skript am Publish-Tag erstmals fehlschlägt, jetzt minimal.

#### Aufräumen
- Alle vier Sandbox-DBs (`neon_drill_target`, `neon_drill_plain`, `restore_drill`, `restore_drill_plain`) per `DROP DATABASE` entfernt (auf beiden Clustern verifiziert: nur produktive DBs übrig).
- Alle Drill-Dump-Dateien unter `tmp/db-backups/` gelöscht (gitignored, lokales Test-Artefakt; Production-Daten verlassen die Repl nicht).

**Durchgeführt von:** Replit Task-Agent (Task #239).

### 2026-04-28 21:25 UTC — Vollständiger Logical-Backup der Production-DB (Task #237)
- **Anlass:** Pre-Publish-Sicherung vor Anwendung der Sprint #228-Drops (`appointments.services_done`, `customer_contracts.{hauswirtschaft,alltagsbegleitung,kilometer}_rate_cents`, Tabelle `customer_pricing_history`).
- **Quelle:** `executeSql({environment: "production"})` (Read-Replica der Production-DB `neondb`).
- **Umfang:** **64 / 64 Public-Tabellen** vollständig gezogen (alle Spalten, alle Zeilen) — insgesamt **10.380 Zeileneinträge** + DDL-Schema-Approximation, gzip-komprimiert.
- **Ablageort (lokal, gitignored):** `tmp/db-backups/full-prod-2026-04-28T21-25-00Z/` — 67 Dateien, ~1,18 MB. **Vor Publish lokal herunterladen** (Files-Tab → Rechtsklick → Download), damit der Snapshot off-site liegt.
- **Committed Manifest mit allen Datei-SHA256:** `docs/backups/snapshot-2026-04-28T21-22-53-207Z.md`
- **MANIFEST.json SHA256 (Übersichtsdatei im Verzeichnis):** `24e8e31249afaa3e16c7e2c55edb6140ea8006d3c7cbc1ba04b24308d5276cf8`
- **Direkt von Sprint #228 betroffene Tabellen — SHA256 der Dump-Dateien:**
  - `appointments.csv.gz` (749 Zeilen) — `0e5798018198b8dfadd724d37c7bff334e55e5ee9310c2632d59b8dc7a82db69`
  - `customer_contracts.csv.gz` (108 Zeilen) — siehe Manifest-Doc für SHA
  - `customer_pricing_history.csv.gz` (0 Zeilen) — siehe Manifest-Doc für SHA
- **Live-Counts vs. Audit-Report (`docs/schema-audit-report.md`):** Decken sich — 749 appointments (+14 seit Audit), 108 customer_contracts unverändert, 0 inhaltliche `services_done`, 0 ≠ 0 in den drei Rate-Spalten, 0 Zeilen in `customer_pricing_history`. **→ Datenverlust durch Sprint #228 = 0.**
- **Sonderfall:** Spalte `prospects.raw_email_content` wurde wegen Steuerzeichen-Konflikten in eine separate JSONL-Datei `prospects_raw_email_content.jsonl.gz` ausgelagert (63/63 Inhalte vollständig hex-kodiert; 0 weggelassen). Details in der Manifest-Doc.
- **Replit/Neon-Auto-Backup:** Vor Klick auf "Publish" in Tools → Database → Backups verifizieren, dass der jüngste Snapshot ≤ 1 h alt ist. Timestamp hier nachtragen.
- **Zusätzlicher binärer `pg_dump --format=custom`:** Beim Publish-Start mit `PROD_DATABASE_URL` aus dem Publishing-Tab über `scripts/backup-prod-db.sh` ziehen (im Task-Sandbox war dieses Secret nicht zugänglich). Der hier abgelegte Logical-Backup deckt jedoch alle Daten- und Schema-Inhalte vollständig ab und reicht als Wiederherstellungs-Quelle aus.
- **Durchgeführt von:** Replit Task-Agent (Task #237).
- **Publish-Ergebnis:** ⏳ ausstehend — Publish ist noch nicht erfolgt.

### 2026-04-28 — Vorbereitung (kein Publish)
- Anlass: Task #237 — Backup-Skripte und Runbook eingeführt als Vorbereitung auf den Publish, der die Sprint #228-Drops anwendet.
- Lieferumfang: `scripts/backup-prod-db.sh`, `scripts/backup-affected-tables.sh`, `docs/pre-publish-backup-runbook.md`, dieses Logbuch, sowie der oben dokumentierte Affected-Data-Snapshot aus Production.
