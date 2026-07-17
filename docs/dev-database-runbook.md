# Dev-Datenbank-Runbook (Reseed, Backup & Test-Daten-Sweep)

**Zweck:** Die langlebige **Entwicklungs-DB** (`DATABASE_URL`) reproduzierbar auf eine
saubere, **synthetische** Basis zurücksetzen und vor jeder Vereinfachungs-Phase einen
überprüfbaren Backup-Snapshot ziehen. Erstellt für Task #1239 (Phase 0.4).

> **Abgrenzung:** Dieses Runbook betrifft ausschließlich die **Dev-DB**. Für
> Produktions-Backups vor einem Publish gilt **[`pre-publish-backup-runbook.md`](pre-publish-backup-runbook.md)**
> (`scripts/backup-prod-db.sh`, `PROD_DATABASE_URL`). Die hier beschriebenen Skripte
> verweigern die Ausführung, wenn `NODE_ENV=production` ist oder der DB-Host nach
> Produktion aussieht.

---

## 1. Strategie: synthetisch statt Prod-Import

Die Dev-DB wird **geseedet** (synthetische Basis), **nicht** aus Produktion kopiert.

- **DSGVO/GoBD:** Pflegedaten (Kunden, Mitarbeiter, Leads, Dokumente) sind hochsensible
  echte PII. Ein Prod→Dev-Kopieren — auch „anonymisiert" — trägt Re-Identifikations-,
  Datenschutz- und GoBD-Risiko und ist für die tägliche Entwicklung nicht nötig.
- **Reproduzierbarkeit:** Die saubere Basis entsteht deterministisch aus gepflegten
  Seedern (denselben, die auch die Test-Wegwerf-DBs füllen), nicht aus einem einmaligen,
  veraltenden Import.
- **Ersetzungs-Regel:** Diese Routine ERSETZT den veralteten großen Import-Datensatz in
  der Dev-DB sowie das gelöschte Ad-hoc-Skript `script/seed.ts`.

Demo-/Beispieldaten (Kunden, Termine) werden bei Bedarf **über die UI** angelegt — die
atomare Kundenanlage erzeugt Vertrag + Budget-Töpfe konsistent. Ein dedizierter
Demo-Seeder existiert bewusst **nicht** (additive Komplexität ohne aktuellen Bedarf).

---

## 2. Voraussetzungen

| Punkt | Wie prüfen |
|---|---|
| `pg_dump` / `psql` 16+ im PATH | `pg_dump --version` / `psql --version` |
| `DATABASE_URL` gesetzt (Dev-DB) | Replit-Runtime setzt das automatisch |
| `TEST_USER_EMAIL` gesetzt | Login-E-Mail des Superadmins nach dem Reseed |
| `TEST_USER_PASSWORD` **oder** `TEST_USER_PASSWORD_INTERNAL` gesetzt | Login-Passwort; der Reseed bricht **vor** jedem Löschen ab, wenn beide fehlen |
| Schreibrecht auf `tmp/db-backups/dev/` | Wird automatisch angelegt (gitignored) |

---

## 3. Backup-Routine (`npm run db:backup-dev`)

Vor **jeder** Vereinfachungs-Phase (und automatisch vor jedem Reseed):

```bash
npm run db:backup-dev
# oder mit Label:
BACKUP_LABEL="-pre-phase-1" npm run db:backup-dev
```

Erzeugt zwei Dateien in `tmp/db-backups/dev/`:

- `dev-<TIMESTAMP><label>.dump` — Custom-Format, restore via `pg_restore`
- `dev-<TIMESTAMP><label>.sql.gz` — Plain-SQL, gzipped, lesbar/grep-bar

Das Skript gibt SHA256-Summen aus und hält automatisch die **letzten 5 Backups pro
Format** vor (ältere werden gelöscht, `BACKUP_KEEP` überschreibbar).

| Env-Var | Default | Zweck |
|---|---|---|
| `BACKUP_DIR` | `tmp/db-backups/dev` | Zielverzeichnis |
| `BACKUP_LABEL` | leer | Suffix im Dateinamen (z.B. `-pre-phase-1`) |
| `BACKUP_KEEP` | `5` | Anzahl vorzuhaltender Backups pro Format |

---

## 4. Reseed-Routine (`npm run db:reseed-dev`)

### 4.1 Trockenlauf (Default — verändert nichts)

```bash
npm run db:reseed-dev
```

Zeigt Ziel-Host, aktuelle Zeilenzahlen und den geplanten Ablauf. Warnt, wenn weitere
aktive DB-Verbindungen (z.B. der laufende Dev-Server) erkannt werden.

### 4.2 Scharf ausführen

1. **`Start application`-Workflow stoppen** (im Workspace), damit der Dev-Server nicht
   mitten im Wipe auf gedroppte Tabellen zugreift und neu startet. (Idle-Pool-
   Verbindungen blockieren das `DROP` nicht, aber ein aktiver Zugriff während des Wipes
   kann den Server in einen Shutdown/Neustart treiben.)
2. Reseed ausführen:
   ```bash
   npm run db:reseed-dev -- --apply            # fragt zur Bestätigung "RESEED" ab
   npm run db:reseed-dev -- --apply --yes       # ohne interaktive Rückfrage
   npm run db:reseed-dev -- --apply --no-backup # ohne Pre-Reseed-Backup
   ```
   Ablauf mit `--apply`:
   1. Backup der aktuellen Dev-DB (Label `-pre-reseed`), außer `--no-backup`.
   2. `DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
   3. `drizzle-kit push --force` (Schema neu anlegen).
   4. `scripts/ci-seed-superadmin.ts` (Superadmin-Login-Konto).
   5. `scripts/seed-test-reference-data.ts` (Basis-Leistungen + Firmenidentität).
3. **`Start application`-Workflow neu starten.** Erst der Server-Boot
   (`runStartupTasks()` in `server/index.ts`) legt die GoBD-/Audit-Trigger und die
   idempotenten Spalten-/Daten-Migrationen an. Verifikation: `/api/health` →
   `startupComplete: true`.

### 4.3 Saubere Basis nach dem Reseed

- **1 Superadmin** — Login: `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`
  (Fallback `TEST_USER_PASSWORD_INTERNAL`). `SUPER_ADMIN_EMAIL` flaggt beim Boot nur eine
  **bestehende** Zeile, legt **keinen** User an.
- **2 Basis-Leistungen** (Hauswirtschaft, Alltagsbegleitung) mit je 3 Budget-Töpfen.
- **company_settings** Test-Firmenidentität.
- **Keine** Kunden/Termine (über die UI anlegen).

---

## 5. Test-Daten-Sweep (`npm run db:sweep-dev`)

**Zweck:** Den auf der langlebigen Dev-DB angesammelten **Test-Pattern-Backlog**
(Test-Kunden/-Interessenten/-User) periodisch wieder abräumen, damit der in
Task #1427 einmalig entfernte Rückstau (3281 Test-Kunden) nicht erneut anwächst.
Anders als der Reseed (Abschnitt 4) wird die DB **nicht** geleert/neu aufgebaut —
echte Daten und die `ZZ-Test`-Whitelist bleiben unangetastet.

> **Ersetzungs-Regel:** Dieses Skript ERSETZT den wiederkehrenden manuellen Lauf
> von `npm run cleanup:test-data -- --apply` für den Kunden-/Interessenten-/
> User-Backlog. Es ist ein dünner Wrapper um den existierenden SSoT-Runner
> `runTestDataCleanup()` (`server/services/test-data-cleanup.ts`) und nutzt den
> schnellen **set-based Bulk-Purge** (`purgeTestCustomersBulk`) statt des
> langsamen per-Kunde-Cascades in `cleanup-test-data.ts`.

### 5.1 Trockenlauf (Default — verändert nichts)

```bash
npm run db:sweep-dev
```

Zählt die Test-Pattern-Kunden/-Interessenten/-User, die ein scharfer Lauf
entfernen würde. Löscht **nichts**.

### 5.2 Scharf ausführen

```bash
npm run db:sweep-dev -- --apply
```

Führt `runTestDataCleanup()` aus: Bulk-Purge der Test-Kunden (in Batches),
Backlog-Purge der Test-Interessenten und Batch-Purge der Test-User. Gibt am Ende
eine Zusammenfassung (gelöscht/fehlgeschlagen/abgelehnt) aus.

### 5.3 Periodisch automatisieren (Scheduled Deployment)

Für den **automatischen** Sweep eine **Scheduled Deployment** anlegen (Replit →
Deployments → Scheduled), die in gewünschtem Intervall (z.B. wöchentlich) den
scharfen Befehl ausführt:

```bash
npm run db:sweep-dev -- --apply
```

Wichtig: Die Scheduled Deployment muss gegen die **Dev-DB** (`DATABASE_URL`)
laufen, nicht gegen Produktion — die Guards (Abschnitt 7) brechen sonst ab.

### 5.4 Whitelist & Schutz

- Erhalten bleibt jeder Kunde mit `vorname`-Präfix `ZZ-Test`
  (`CUSTOMER_PRESERVE_VORNAME_PREFIX`) — der Ausschluss steckt im
  `CUSTOMER_TEST_FILTER` und greift automatisch.
- Test-User, die mit **echten** Kunden verflochten sind, werden vom Runner
  entkoppelt bzw. (im Notfall) geblockt statt echte Daten zu zerstören.
- In `NODE_ENV=production` ist der Runner zusätzlich ein No-op.

### 5.5 Ephemere Test-DB-Waisen (`cc_test_*`) — crash-unabhängige Reklamation (Task #1807)

Jeder Integration/e2e-Lauf legt über `scripts/with-ephemeral-db.ts` Wegwerf-DBs
mit Präfix `cc_test_` an und droppt sie beim Teardown. Wird ein Lauf **hart**
abgebrochen (SIGKILL, Container-Crash), läuft kein Teardown → die DB bleibt als
Waise auf der Neon-Instanz liegen und **kostet Storage**. Bislang wurden solche
Waisen ausschließlich beim **Start des nächsten Testlaufs** aufgeräumt — laufen
längere Zeit **keine** Tests, kriecht der Storage nach oben.

Der Dev-Sweep hängt diese Reklamation deshalb **zusätzlich** an seinen bereits
crash-unabhängigen Trigger (Abschnitt 5.3, Scheduled Deployment):

- **Dry-Run** (`npm run db:sweep-dev`) zählt die Waisen mit (`Ephemere Test-DB-Waisen (cc_test_*): würde droppen: N`).
- **Apply** (`npm run db:sweep-dev -- --apply`) reklamiert sie nach dem Test-Daten-Purge.

> **Ersetzungs-Regel:** KEINE neue Sweep-Logik — dünner Wrapper um die eine SSoT
> `sweepOrphans()` (`scripts/lib/ephemeral-db-sweep.ts`), identisch zum
> Orchestrator. Es werden **nur** verbindungslose, **>15 Min alte** `cc_test_`-DBs
> gedroppt; ein aktiv laufender Schwester-Testlauf hält seine DBs verbunden bzw.
> sie sind zu frisch → unberührt. Die langlebige Cache-Template-DB
> (`cc_test_tmpl_cache`) bleibt **immer** geschützt (wird auf dem nächsten Lauf
> wiederverwendet, nur ~12 MB). Fail-safe: bricht den Dev-Daten-Sweep nie ab.

**Retention-Garantie:** Solange die Scheduled Deployment läuft, wird jede Waise
spätestens im nächsten Intervall reklamiert — **unabhängig davon, ob überhaupt
noch Testläufe stattfinden**. Manuell weiterhin: `npm run test:sweep-dbs`
(age-gated) bzw. `npm run test:unblock` (`--force`, Notfall).

---

## 5a. Neon-Kosten: Pool-Warmhaltung vs. Scale-to-Zero (Task #1807)

Neon berechnet **compute-hours** (Zeit, in der der Compute-Endpoint wach ist) plus
Storage. Der Compute suspendiert (Scale-to-Zero) erst, wenn **keine offenen
Client-Verbindungen** mehr anliegen. Ein hoher `idleTimeoutMillis` des
Connection-Pools (früher **5 min**) hielt leere Pool-Sockets künstlich offen und
verhinderte damit das Suspendieren in ruhigen Phasen (nachts/Wochenende), obwohl
das Nutzungsprofil überwiegend **Bürozeiten** ist.

**Entscheidung:** Default-`idleTimeoutMillis` auf **60s** gesenkt
(`server/lib/db.ts`, override per `NEON_POOL_IDLE_TIMEOUT_MS`). Ungenutzte Sockets
schließen zügig → Neon kann in Leerlaufphasen suspendieren und spart
compute-hours. Die **Cold-Start-Mitigationen bleiben vollständig erhalten**:
TLS/Auth-Pipelining + großzügiges `connectionTimeoutMillis` (15s) fangen den
nächsten Compute-Wake ab; `keepAlive` stabilisiert **aktive** Sockets (kein
Idle-Effekt). Der Trade-off (gelegentlicher Cold-Start nach längerer Ruhe vs.
laufende compute-hours) ist bei diesem kleinen, bürozeit-lastigen Profil klar
zugunsten Scale-to-Zero. Für Last-/E2E-Läufe, die viele warme Verbindungen halten
wollen, den Wert per Env hochsetzen (z.B. `NEON_POOL_IDLE_TIMEOUT_MS=300000`).

---

## 6. Restore aus einem Backup

Custom-Format (selektiv möglich):

```bash
# WARNUNG: nur gegen die Dev-DB. Vorher den Workflow stoppen.
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "$DATABASE_URL" tmp/db-backups/dev/dev-<TIMESTAMP>.dump
```

Plain-SQL:

```bash
gunzip -c tmp/db-backups/dev/dev-<TIMESTAMP>.sql.gz | psql "$DATABASE_URL"
```

Nach dem Restore den `Start application`-Workflow neu starten.

---

## 7. Sicherheits-Guards (alle Skripte)

- Abbruch bei `NODE_ENV=production`.
- Abbruch, wenn der DB-Host nach Produktion aussieht (Regex auf den Hostnamen, gespiegelt
  aus `server/scripts/cleanup-test-data.ts`).
- Abbruch, wenn `DATABASE_URL`-Host == `PROD_DATABASE_URL`-Host (falls letzteres gesetzt ist).
- Reseed zusätzlich: **Credential-Preflight** vor jedem Löschen (sonst bliebe die DB ohne
  Login-Konto zurück), Trockenlauf als Default, getippte `RESEED`-Bestätigung.
- Backups landen im gitignored `tmp/db-backups/` — niemals committen.
