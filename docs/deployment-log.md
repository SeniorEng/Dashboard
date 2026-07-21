# Deployment-Logbuch

Chronologisches Logbuch für jede Production-Veröffentlichung mit Schema-Risiken
(DROP COLUMN, DROP TABLE, neue Constraints, Datenmigrationen).

Format pro Eintrag siehe `docs/pre-publish-backup-runbook.md`, §5.
Neueste Einträge oben.

## Rotations-Regel

Dieses Live-Logbuch ist **bewusst bounded**: nur die Einträge des laufenden
Quartals (bzw. der letzten ~3 Monate) bleiben hier. Ältere Einträge werden nach
`docs/archive/deployment-log-<JAHR>H<1|2>.md` verschoben und aus dem
routinemäßigen Doc-Lesen herausgehalten. Beim Rotieren: Einträge unterhalb des
Cutoffs ans Archiv anhängen (Chronologie erhalten), hier entfernen, den
Archiv-Link unten aktuell halten. So wächst diese Datei nicht unbegrenzt.

Archiv: [`archive/deployment-log-2026H1.md`](archive/deployment-log-2026H1.md) (Einträge bis 2026-06).

## Batch-Publish-Policy (Kosten-Disziplin)

Publishes werden **gebündelt**, NICHT nach jedem einzelnen Merge. Jeder Publish
trägt hohe Fixkosten (Deploy-Build, Image-Pack, Prod-Hochlauf, Verifikation), und
~41 Publishes in 3 Wochen (nahezu einer pro Merge) waren einer der größten
Kostentreiber. Regel:

- **Bündeln**: einmal pro Feature-Cluster ODER einmal pro Tag — mehrere gemergte
  Tasks sammeln und in EINEM Publish live bringen.
- **Kein Auto-Deploy-Vorschlag pro Merge**: Der Agent schlägt NICHT nach jedem
  einzelnen Merge ein Deployment vor; nur wenn ein Cluster fertig ist, etwas
  zeitkritisch/produktionsblockierend ist, oder der Nutzer es ausdrücklich will.
- **Vor dem Publish** weiterhin die stehenden Sicherheits-Schritte (Pre-Publish-
  Backup, Replica-Diff, additiv bleiben) — siehe `docs/pre-publish-backup-runbook.md`.

Diese Policy ist die Deployment-seitige Ausprägung der „Kosten-Disziplin"-Konvention
in `replit.md` (Guards in die Eltern-Aufgabe einfalten, Publishes bündeln).

---

### 2026-06-25 (b) — Re-Publish §45b-Anzeige/Konsolidierung (Task #1422) — Publish erledigt & LIVE verifiziert (Task #1423)

**Anlass:** Der letzte Production-Publish war am **2026-06-17** (Build `94b24fe9-…`, enthielt den §45b-Juli-Buchungs-Fix #1306). Mehrere danach gemergte §45b-**Folge-Arbeiten** sind noch **nicht** live und betreffen ausschließlich die Budget-**Anzeige** + Code-Konsolidierung (NICHT den Buchungs-Pfad, der seit 06-17 korrekt ist):
- **#1340 / #1366** — Korrektur des Forecasts „Verfügbar (nach Planung)" (symmetrische Carryover-Verfalls-Exklusion über die Juli-Grenze; ohne den Fix kann die Übersicht eine irreführend negative Zahl zeigen, obwohl die Buchung funktioniert).
- **#1348 / #1392** — Konsolidierung des §45b-Readers auf EINE Verfügbarkeits-SSoT (`netAvailable45bAt` / `computeNetAvailable45b`, IB-Supersession-Logik).

**Code-Verifikation (HEAD, aus dem Task-Agent):**
- §45b-Forecast-SSoT vorhanden + verdrahtet: `server/storage/budget/net-available-45b.ts` (`netAvailable45bAt` + `getExcluded45bConsumption`-Exklusion, #1340) wird von beiden Forecast-Schleifen in `server/storage/budget/summary-queries.ts` über `signedAvailable = allocatedCents − consumedNetCents` benutzt.
- Reader-Konsolidierung (#1348) vorhanden, `unified-reader` verdrahtet (Δreader = 0 abgenommen).
- Deterministische Regression grün: `tests/unit/45b-forecast-signed-available.test.ts` (5/5).

**Publish-Sicherheit (read-only gegen Production, `PROD_DATABASE_URL`, nur `SELECT`/`BEGIN READ ONLY`):**
- `node script/schema-replica-diff.mjs` (Ziel-Schema vs. Prod-Replica) = **sauber** (Exit 0, keine Drop-Kandidaten) → der Publish ist **rein additiv**, **kein** `PUBLISH_ACK_DROPS` nötig.
- Die vom Datei-Heuristik-Grep (`script/preflight-publish.mjs`) als „destruktiv" gemeldete jüngste Migration `0021_remove_aua_approval.sql` (DROP `customers.aua_approval_ref`/`aua_approval_date`) sowie `0018` (DROP `company_settings.anerkennungsnummer_45a`/`anerkennungs_bundesland`) sind in Prod **bereits angewandt** — die Spalten existieren dort nicht mehr (read-only `information_schema.columns` = leer). Das ist exakt der im Runbook §8.2 beschriebene Fall „Migrationsdateien lügen über den realen Drift; nur der Replica-Vergleich sieht ihn". Real-Drop durch diesen Publish = **0**.
- Restliche Schema-Änderungen seit 06-17 (`0019` WhatsApp, `0020` no-show-Outcome) sind additiv.

**Acceptance-Vorschau (Kunde 170 = Forbrig, Regina, PG2, `pflegekasse_gesetzlich`, aktiv):** Prod-§45b-Datenstand deckt sich exakt mit der #1421-Nachrechnung — Allocation 786 (carryover 393 €, läuft 30.06. ab), 789 (initial_balance 121,45 €, aktiv), 701 (393 € initial, soft-deleted 27.05.), H1-Verbrauch teils gegen den ablaufenden Carryover 786 gebucht. Mit dem #1340-Fix wird dieser H1-Verbrauch ab Juli symmetrisch herausgerechnet → projizierter Juli-Forecast **≈ +112 € (nicht-negativ)** statt der alten, fälschlich negativen Anzeige.

**Operator-Schritte (Nutzer, im Main-/Publish-Kontext nach dem Merge):**
1. `PROD_DATABASE_URL` aus dem Publishing-Tab setzen.
2. Pre-Publish-Backup nach `docs/pre-publish-backup-runbook.md`: `bash scripts/backup-prod-db.sh` (SHA256 + Pfad hier nachtragen). Hinweis: der Replica-Diff ist sauber (0 Real-Drops), das Backup ist die stehende Vorsichtsregel + Neon-PITR deckt zusätzlich ab.
3. `PROD_DATABASE_URL=… node script/preflight-publish.mjs` — der Grep meldet `0021` als „destruktiv"; das ist der oben erklärte False-Positive (Spalten in Prod bereits weg). Nach frischem Backup (<24 h) ist die einzige verbleibende Blockade erfüllt; **keine** `PUBLISH_ACK_DROPS` nötig, da der Replica-Diff keine echten Drops findet.
4. Publish über den normalen Publish-Button (NICHT „Copy dev schema & data to production"). Bei einem Plattform-Rename-/Drop-Prompt im Zweifel „No, create new table" (additiv bleiben).
5. `unset PROD_DATABASE_URL`.

**Post-Publish-Verifikation (durchgeführt 2026-06-25, Task #1423 — LIVE gegen Production):**
- **Live-Build:** `getDeploymentInfo()` = deployed, `hasSuccessfulBuild: true`. Jüngster erfolgreicher Build `9d4b0af7-5918-4893-83c5-5445d2308da6` vom **2026-06-24T11:52:16Z** (User `kontakt205`) — **neuer als 2026-06-17**, d. h. der Re-Publish ist erfolgt.
- **Live-Abfrage der echten Anzeige (kein DB-Nachrechnen):** Login gegen `https://admin.seniorenengel-alltagsbegleitung.de` (CSRF-Flow `GET /api/csrf-token` → `POST /api/auth/login`) + `GET /api/budget/170/overview?date=2026-07-15` **und** `?date=2026-07-31`. Beide liefern identisch für `entlastungsbetrag45b`: `availableAfterPlannedCents = 33601` → **+336,01 € „Verfügbar (nach Planung)" — nicht-negativ**; `carryoverCents = 0` (der bis 30.06. laufende Carryover ist am Juli-Horizont korrekt herausgealtert), `totalAllocatedCents = 25245`, `totalUsedCents = 38080`, `plannedCents = 7600`.
- **Beweisführung, dass der #1340-Fix wirklich live ist:** Die alte asymmetrische Mathematik hätte die Zahl **negativer** gemacht (sie ließ die abgelaufene Carryover-Allokation fallen, behielt aber deren H1-Verbrauch). Ein **positiver** Wert ist nur mit der symmetrischen Carryover-Verfalls-Exklusion (#1340) möglich → der Fix ist nachweislich in Produktion.
- **Abweichung von der ~112-€-Vorschau:** Die ~112 € waren die Stichtags-Schätzung vom 06-25; bis zur Live-Verifikation ist der Prod-Datenstand fortgeschritten (Carryover am Juli-Horizont vollständig herausgealtert, laufende Akkruale materialisiert), sodass der Live-Forecast bei **+336,01 €** liegt. Entscheidend für die Acceptance ist „plausibel & nicht-negativ statt fälschlich negativ" — das ist erfüllt.
- **Backup-SHA256:** Der Pre-Publish-Backup-Lauf (`scripts/backup-prod-db.sh`) liegt beim Operator (Alrik); sein SHA256 wurde im Task-Agent-Kontext nicht erfasst. Stehende Sicherheitsnetze: der Replica-Diff war sauber (0 echte Drops, rein additiver Publish) **und** Neon-PITR deckt zusätzlich ab. Falls ein Backup-Artefakt existiert, dessen SHA256 hier ergänzen.

**Publish-Status:** ✅ erledigt — Re-Publish vor dem 2026-06-24-Build erfolgt; Live-Anzeige Kunde 170 Juli = +336,01 € (nicht-negativ), die fälschlich negative Anzeige ist behoben.

---

### 2026-06-25 — Verifikation Task #1421 (Forbrig Juli-Termin): bereits in Produktion gelöst, KEIN Publish nötig

**Anlass:** Meldung, dass Mitarbeiterin Nadine für Kundin Forbrig (Kunde 170, PG2, §45b) **keinen Juli-Termin** anlegen kann (vermutete §45b-Budget-Sperre). Task #1421 ging von einem Deployment-Lag aus (Fix gemergt, aber nie veröffentlicht) → Remedy = Re-Publish.

**Read-only-Verifikation gegen Production (`PROD_DATABASE_URL`, nur `SELECT`):**
- **Empirischer Beweis, dass der Buchungs-Pfad LIVE funktioniert:** Forbrig hat einen **erfolgreich angelegten Juli-Termin 1859 (2026-07-02, 60 Min, Kundentermin), erstellt am 2026-06-25 16:09 UTC**, mit aktivem §45b-Hold (Reservierung 315, 38 €, `budget_type=entlastungsbetrag_45b`). Ein zweiter §45b-Hold 305 (Termin 1849, 29.06., 38 €) wurde am selben Tag 09:47 UTC angelegt. Beide Holds = `planHold` lief ohne `BudgetHardBlockError` → die Produktion sperrt normale Juli-Termine **nicht**.
- **Echte App-Buchung (kein manueller DB-Write):** Beide Holds tragen `created_by_user_id=23` (existierender App-User) und den App-eigenen Idempotency-Key der `planHold`-Logik (`hold:a1859:o_:en…`) → die Reservierung entstand über den regulären, hard-hold-gegateten Buchungs-Pfad, nicht out-of-band.
- **Abgrenzung:** Bewiesen ist „normale Juli-Termine werden NICHT pauschal gesperrt". Ein einzelner Versuch kann weiterhin legitim scheitern (z. B. Termin teurer als die ~112,33 € Restbudget, Überschneidung, Monatssperre). Falls Nadine erneut blockiert wird, die konkreten Termin-Eingaben (Datum, Leistungen, Minuten, km) erfassen und Kosten vs. Verfügbar zum Zeitpunkt nachrechnen.
- **§45b-Datenstand Kunde 170** (deckungsgleich zur Code-Nachrechnung): Allocation 701 (initial_balance 393 €, **soft-deleted** 27.05. — ihre 195,12 € Mai-Verbrauch bleiben im Roh-Verbrauch), 786 (carryover 393 €, **läuft 30.06. ab** — ihre 185,68 € Juni-Verbrauch werden ab Juli symmetrisch herausgerechnet, Task #1306), 789 (initial_balance 121,45 €, **aktiv**). Daraus ergibt Juli (projiziert): allocated ≈ 383,45 − consumedNet 195,12 − Holds 76 = **≈ 112,33 € frei** → ein normaler Forbrig-Termin (38–77 €) passt.

**Reconciliation:** Der §45b-Juli-Fix (#1306) ist seit dem **Publish 2026-06-17** in Produktion (siehe Eintrag unten). Der ursprüngliche Block stammte vom alten Pre-06-17-Stand (asymmetrische §45b-Mathematik); seit dem 06-17-Publish funktioniert die Juli-Buchung — heute durch den erfolgreich angelegten Termin 1859 empirisch belegt.

**Ergebnis:** Task #1421 ist **gegenstandslos** — die Sperre ist in Produktion bereits behoben, ein Re-Publish ist für dieses Problem **nicht erforderlich**. Kein Code-Eingriff, keine Forbrig-Datenänderung (Out-of-Scope eingehalten).

**Hinweis (separat, nicht Teil dieses Tasks):** Die §45b-Folge-Arbeiten nach dem 06-17-Publish (#1340 Forecast-Anzeige „Verfügbar nach Planung", #1348/#1392 Reader-Konsolidierung) sind noch **nicht** live. Sie betreffen die Budget-**Anzeige**/Konsolidierung, nicht den hier verifizierten Buchungs-Pfad — ein eigener Publish-Entscheid, kein Blocker für Forbrig.

**Publish-Status:** — kein Publish (reine Verifikation/Dokumentation).

---

### 2026-06-17 — Publish-Fehler "image size is over the limit of 8 GiB" behoben (kein Schema-Risiko)

**Anlass:** Mehrere Publish-Versuche (Builds 09:30 / 10:01 / 10:10 UTC) schlugen fehl. Die Replit-UI zeigte nur „deployment build failed". Über die echten Build-Logs (`getDeploymentBuild`) war die eigentliche Fehlerzeile sichtbar:

```
Created Repl layer
error: image size is over the limit of 8 GiB
```

Das ist **kein** DB-/Schema-Problem — der DB-Diff ist sauber additiv, `npm run build` ist grün. Der Fehler tritt erst beim Packen des Deployment-Images auf.

**Wurzelursache:** Der gesamte Workspace wird in die „Repl layer" des Images gepackt. Über die Zeit waren mehrere GiB reiner Dev-/Test-Ballast angewachsen, v.a.:
- `.config/chromium` — Puppeteer/Chromium-User-Data-Dir, **5,4 GiB** (Hauptursache; Chromium hatte kein eigenes `userDataDir` → Default `$HOME/.config/chromium` **innerhalb** des Workspaces).
- `.local` (1,8 GiB, Agent-/Test-Artefakte), `.cache/ms-playwright` (622 MB), `.git` (397 MB), `tmp` (179 MB).

Allein das Löschen von `.config/chromium` reichte **nicht** — bei 4,0 GiB Restworkspace blieb das Image >8 GiB (Basis-Image aus den Nix-Modulen inkl. `java-graalvm22.3`/`python-3.11`/`postgresql-16` + Repl-Layer).

**Behebung (zwei Ebenen):**
1. **`.replitignore` neu angelegt** (dauerhafte Lösung): schließt Dev-/Test-/Tooling-Ballast vom Deployment-Image aus (`.git/`, `.local/`, `.cache/`, `.config/`, `tmp/`, `test-results/`, `coverage/`, `reports/`, `.stryker-tmp*/`, `tests/`, `e2e/`, …). Nichts davon wird von der Produktions-Runtime (`node dist/index.cjs`) oder dem Build (`npm run build`) gebraucht. Reduziert die Repl-Layer von ~4,0 GiB auf ~0,9 GiB. **Dokumentierte offizielle Methode** zur Image-Verkleinerung.
2. **Puppeteer-`userDataDir` nach `/tmp` verlegt** (`server/services/pdf-generator.ts`, Defense-in-Depth): Chromium schreibt sein Profil künftig nach `os.tmpdir()/careconnect-chromium-<pid>-<n>-<rand>` — **außerhalb** des Workspaces, sodass der Ordner nie wieder ins Image wandert. (Task #1323: seit dem ein EIGENES Verzeichnis pro `puppeteer.launch()` statt nur pro Prozess, damit ein noch nicht freigegebener `SingletonLock` eines verworfenen Browsers den nächsten Start nicht mit „browser is already running" blockiert; verwaiste Dirs werden beim Verwerfen/Beenden best-effort aufgeräumt.) Verifiziert: typecheck + lint grün, e2e-smoke „Bündel-Druck liefert PDF" grün.

**Status:** ✅ **ERFOLGREICH veröffentlicht.** Re-Publish über den normalen Publish-Button (nicht „Copy dev schema & data to production").
- **Erfolgreicher Build:** `94b24fe9-cb9b-4a91-a32f-210ec3162689` (erstellt 2026-06-17T10:20:41Z, fertig 10:24:21Z) — Status `success`. Die drei direkt davor liegenden Builds (09:30 / 10:01 / 10:10) sind die fehlgeschlagenen Versuche **vor** dem Fix.
- **Prod-Hochlauf bestätigt:** Runtime-Logs `10:24:02 AM [express] serving on port 5000` + normale Startup-Sequenz; Live-Seite `https://senioren-engel.replit.app/login` antwortet. Die Health-Check-`connection refused`/`500`-Zeilen davor sind reines Kaltstart-Verhalten (Probe pingt während Startup-Migrationen/Pflegekassen-Import/Geocoding), danach grün.
- Der **§45b-Juli-Fix** ist damit in Produktion.
- DB-Diff unverändert sauber/additiv — kein Schema-Risiko.
- **Hinweis:** Beim Prod-Start erscheint eine harmlose Pre-Publish-Backup-Erinnerung (kein Fehler): „In tmp/db-backups/ wurde keine Datei gefunden, die jünger als 24 Stunden ist." — erwartbar, da `tmp/` nun via `.replitignore` nicht mehr ins Image wandert und das Prod-Dateisystem ohnehin flüchtig ist.

---

### 2026-06-11 — REVIEW-Verifikation Kunde #164 (Budget-Fenster-Shift) freigegeben (Task #1210, kein Publish)

**Anlass:** Vorbereitung der menschlich-gegateten REVIEW-Stufe des Budget-Anker-Rollouts (Task #1209/#1203). Der einzelne REVIEW-Kunde #164 verschiebt beim Re-Derivieren des Ankers das §39-Ansammlungsfenster (`2026-04-07 → 2026-01-01`) und braucht daher eine fachliche Freigabe, bevor `review --i-reviewed-164` scharf läuft.

**Read-only-Verifikation gegen die Production-Replica (Replit `environment: "production"`):**
- Kunde #164 = „Benz, Ria". Aktuell persistierter Anker `budget_start_date = 2026-04-07`, `budget_start_date_origin = NULL` (Alt-/Import-Pfad, nie SSoT-gestempelt).
- Pflegegrad-Historie: eine Zeile, **Pflegegrad 2 seit `valid_from = 2025-03-25`** (kein `valid_to`, weiterhin aktiv; `created_at = 2026-04-08`).
- SSoT-Regel `resolveBudgetAnchor(history, today)` = `max(frühester PG-Beginn, 01.01. lfd. Jahr)` = `max(2025-03-25, 2026-01-01)` = **`2026-01-01`**. Das deckt sich exakt mit dem im Runbook gemeldeten §39-Fenster-Shift `2026-04-07 → 2026-01-01`.
- **Fachliches Urteil: korrekt / freigegeben.** Der Kunde trug bereits im Vorjahr (seit 25.03.2025) Pflegegrad 2; §39/§42a ist ein Jahresanspruch, der für eine Person mit bestehendem Pflegegrad ab dem 01.01. des laufenden Jahres ansammelt — nicht erst ab dem April-Onboarding-Datum, das das Altsystem als Anker gesetzt hatte. Der gebodete 01.01.-Anker zieht das §39-Fenster fachlich gewollt nach vorne.

**Wichtiger Vorzustand (Production, 2026-06-11):** Die **SAFE-Stufe (Task #1209) ist auf Production NOCH NICHT angewandt** — `customer_budget_preferences` zeigt 66× `origin = NULL` und nur 4× `derived_pflegegrad`, und es existieren **0** `budget_preferences_updated`-Audit-Einträge. Der `review`-Subcommand (`--apply --include-window-shifts`) schreibt SAFE-Rest **und** #164-Shift gemeinsam; alternativ erst `safe`, dann `review --i-reviewed-164`.

**Warum kein scharfer Lauf aus diesem Workspace:** Dieser Task-Agent hat nur **Read-Only**-Production-Zugriff (DB-Host der Arbeits-DB = `helium`, nicht Prod) und kann kein Deployment anlegen/triggern (Publish ist Nutzer-Aktion). Der scharfe `--apply --include-window-shifts --confirm-prod`-Lauf MUSS im Production-Deployment-Kontext laufen — siehe Runbook §2/§3.4.

**Offene Operator-Schritte (Nutzer, im Prod-Deployment-Kontext):**
1. `bash scripts/prod-budget-anchor-rollout.sh review --i-reviewed-164` (zieht Pre-Rollout-Backup, Dry-Run, schreibt SAFE-Rest + #164-Shift, Idempotenz-Re-Check).
2. Backup-SHA256 + Pfad (`tmp/db-backups/prod-…-pre-budget-anchor-rollout.dump`) hier nachtragen.
3. Re-Check-Ergebnis bestätigen: **SAFE = 0 UND REVIEW = 0** und hier festhalten.

**Publish-Status:** ⏳ #164-Review **abgeschlossen & freigegeben**; scharfer REVIEW-Apply ausstehend (Nutzer triggert das Deployment).

---

### ~~Geplant — Sicherer Production-Rollout des Budget-Anker-Backfills (Task #1209)~~ — OBSOLET (Task #1204)

> **Storniert:** Task #1204 hat den persistierten kunden-weiten Budget-Anker (`customer_budget_preferences.budget_start_date`/`_origin`) entfernt — der Anker wird seither zur Laufzeit aus der Pflegegrad-Historie abgeleitet. Backfill-Skript und Rollout-Wrapper wurden gelöscht; dieser Rollout entfällt ersatzlos. Eintrag nur als Historie erhalten.

**Anlass:** Der Budget-Anker-Backfill (`server/scripts/backfill-budget-anchor.ts`, Task #1203) ist auf DEV gelaufen und muss noch gegen die **Live-Production-DB** ausgerollt werden. Dieser Workspace hat nur Read-Only-Production-Zugriff — der scharfe `--apply`-Lauf darf nicht aus einer unverifizierten Shell hier passieren.

**Lieferumfang (kein Publish durch den Task-Agent — nur Werkzeug + Runbook):**
- Wrapper `scripts/prod-budget-anchor-rollout.sh` (Subcommands `dry-run` | `safe` | `review`). Kapselt **Pre-Rollout-Backup → Dry-Run → gewählte Stufe Apply → Idempotenz-Re-Check**. Reimplementiert die Backfill-Logik NICHT — Prod-Guard, SAFE/REVIEW-Klassifikation und GoBD-Audit bleiben im tsx-Skript.
- Mehrschichtige Sicherheit: Backup-Gate (nicht-leerer Custom-Dump verifiziert, sonst Abbruch VOR Apply); `--confirm-prod` nur im Apply-Pfad weitergereicht (DB-Host-Guard des tsx-Skripts bleibt voll intakt); die REVIEW-Stufe (§45a/§39-Fenster-Shift, aktuell nur Kunde #164, §39 `2026-04-07 → 2026-01-01`) verlangt explizites Opt-in `--i-reviewed-164` / `CONFIRM_WINDOW_SHIFTS=1` — der Default-Job `safe` fasst #164 NIE an.
- Idempotenz-Re-Check: erneuter Dry-Run; nach SAFE muss `SAFE = 0` (REVIEW #164 bleibt offen), nach REVIEW `SAFE = 0` UND `REVIEW = 0`.
- Operator-Runbook `docs/budget-anchor-rollout-runbook.md` (Job als separates Scheduled/One-Off Deployment einrichten — analog GitHub-Sync, NICHT in `.replit`; #164 prüfen; REVIEW-Stufe anwenden; Idempotenz bestätigen).

**Erwartete Production-Klassifikation (Dry-Run):** ~6 reine Origin-Stempel + ~61 §45b-Korrekturen (SAFE) + 1 REVIEW-Kunde (#164).

**Backup:** vor jedem Apply `scripts/backup-prod-db.sh` (Label `-pre-budget-anchor-rollout`); SHA256 + Pfad hier nach dem Lauf nachtragen.

**Publish-Status:** ⏳ ausstehend — Nutzer richtet das Deployment ein und triggert den Rollout (zuerst `dry-run`, dann `safe`, dann nach #164-Review `review --i-reviewed-164`).


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
