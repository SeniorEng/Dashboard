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
