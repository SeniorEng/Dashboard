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

### 2026-09-25 ~20:00 UTC — USt-Regel § 4 Nr. 16 g + Nachzug #193/#194 (#195) — VORFALL: neue Spalten fehlten in Prod

**Anlass:** `main` @ `d57aaef1` (#195 = #193 + #194: Verbrauch nach Startwert,
Vorschau = Rechnung, USt je Position). Frist: vor dem Oktober-Abrechnungslauf.

| | |
|---|---|
| Schema-Änderung | **nur additiv**, 5 nullable Spalten + 1 FK (#194, `migrations/0002_*`): `customer_care_level_history.entfernt_am` (timestamptz), `.entfernt_grund` (text), `.entfernt_von_user_id` (int, FK `customer_care_level_history_entfernt_von_user_id_users_id_fk` → `users`), `invoice_line_items.vat_rate_bp` (int), `.pflegegrad_am_leistungstag` (int). #192/#193: kein Schema. |
| DROPs | 0 — Backup nach §3 nicht erforderlich |
| Soll-`version` (`GET /health`) | **`2a4cdee5699d8113`** (nachgerechnet über `d57aaef1`, Verfahren §5) — Ist-Wert: *von Alrik nachzutragen* |

#### Ablauf

1. **Erster Publish brach in Schritt 0d ab** („Pulling schema from
   database…") — derselbe Hänger wie am 22.09. (`6hWvrJgff5xr9hfp`).
2. **Zweiter Publish ohne `migrate.sh`** (Build-Zeile nur lokal gekürzt, danach
   per `git reset --hard origin/main` wiederhergestellt). Grundlage war die
   Aussage im Runbook (`docs/ust-4-16g-golive-runbook.md`, 1c), Replits
   Schema-Phase wende additive Änderungen an.
3. **Publish grün, aber die 5 Spalten fehlten in Prod**:
   `column entfernt_am does not exist`. **Replits Schema-Phase hat sie NICHT
   angelegt** — die Runbook-Aussage war falsch.
4. **Fix (Alrik, Gate 4):** eine Transaktion
   `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` für alle 5 Spalten, FK-Name wie
   von Drizzle erwartet (DDL von CC aus dem Schema-Diff `3124015a..d57aaef1`
   gemessen, auf einer Wegwerf-DB im Prod-Zustand geprüft: vorher 0/5, nachher
   5/5, zweiter Lauf idempotent). Prüfbefehl read-only: **5/5 Spalten, nullable,
   FK gesetzt.**

**Daten:** nicht betroffen. Jeder Rechnungs-Insert schreibt `vat_rate_bp` —
ohne die Spalte brach er ab; es gibt keine halben Datensätze. Kein Backfill
nötig (NULL = Bestand).

#### Live-Gang danach (Ticket `6hcgffPJWm57p72p`)

- Freigabe-Check: A/B nur Kunde 177 — **von Alrik als echt bestätigt (PG 3 seit
  01.08.2024)**, nichts ausgetragen. C (Stammdaten ≠ Historie, 7 Kunden) und E
  (umgedrehte Zeiträume, 5 Kunden) bekannt und nicht blockierend → Datenhygiene
  vor dem Cutover. F/G/H leer.
- **Oktober-Abrechnungslauf freigegeben.**
- Folge aus der Korrektur zu 177: RE-2026-0337 und RE-2026-0433 (bezahlt,
  20,98 € USt) per Storno + Neuausstellung ohne USt berichtigen.

#### Lehren

- **Publish ohne `migrate.sh` nur nach vorheriger DDL in Prod** — DDL →
  Prüfung → Publish, nie umgekehrt. Jetzt als §0 in
  `docs/pre-publish-backup-runbook.md` und in CLAUDE.md (Release-Step).
- **Replits Schema-Phase ist kein verlässlicher Weg.** Ursache offen,
  vermutlich gleicht sie gegen die Dev-DB ab, in der die Spalten fehlten
  (Hinweis im Replit-UI „Your development database has been upgraded").
  Klärung in `6hc8RMmfr93WF5wG`.
- **Schritt 0d bleibt der Engpass** — vor dem nächsten Publish mit
  Schema-Änderung lösen, sonst ist der DDL-vorher-Weg Pflicht.
- Nebenbefund des Tages: #193/#194 waren gestapelt und landeten zunächst nicht
  in `main` (Nachzug #195). Regel: kein PR zum Merge ohne Basis `main`
  (CLAUDE.md, #196).

### 2026-09-21 — Trockenlauf + Messwerkzeug (#155, #156) — ZWEI Publishes, der erste baute den falschen Stand

**Anlass:** zwei gemergte PRs, gebündelt:

| PR | Inhalt | Schema? |
|---|---|---|
| #155 | `scripts/messe-0d.ts` (Messwerkzeug für den 0d-Abbruch), Logbuch-Eintrag 18.09., Checkliste nennt die Blindheit des Migrations-Greps | nein |
| #156 | Trockenlauf für den Qonto-Zahlungs-Abgleich (`POST /api/admin/qonto/auto-match/preview`) | nein |

**Kein DDL.** Skript-, Service- und Routen-Änderungen; keine Migrationsdatei,
keine Spalte, kein Constraint. **0 DROPs**, Backup entsprechend nicht nötig —
der Vor-Riegel (`npm run pre-publish-gate`) wurde gefahren und hat das belegt,
nicht angenommen.

#### Der erste Publish lieferte den Stand VOR dem Merge

| | |
|---|---|
| Merge von #156 | 17:37:03 UTC (`28a3a5b5`) |
| `builtAt` des ersten Builds | **17:38:30 UTC** — 87 Sekunden danach |
| `version` des ersten Builds | **`d14e9e60c5d01219`** = Quellstand **vor** #156 |

Aufgefallen ist es erst, als der neue Endpunkt in Prod **404** lieferte.

**Die Ursache ist weder „zu früh publisht" noch ein veraltetes Bundle** — es
wurde nach dem Merge frisch gebaut. Der Build sah nur anderen Quelltext:
**Replit baut aus dem Workspace, und der Workspace hatte den Merge nicht
gezogen.** Derselbe Mechanismus wie am 17.09., als `HEAD` einen Commit hinter
`origin/main` lag.

**Das Werkzeug dagegen lag bereit und wurde nicht gefahren:**
`npm run pre-publish-gate` prüft als Schritt 2 genau `HEAD == origin/main` und
hätte abgebrochen. Ein Riegel nützt nichts, den man nicht fährt.

#### Der zweite Publish

| | |
|---|---|
| `version` | **`7e5dd3ded1d89778`** = `origin/main` mit #156 |
| Vor-Riegel | gefahren, 0 DROPs, kein Backup nötig |
| Verifikation | `GET /health` gegen den nachgerechneten Hash |

**Uhrzeit des zweiten Builds nicht erhoben** und deshalb hier nicht behauptet.

#### Was dieser Vorfall geändert hat

Die §5-Vorlage im Runbook hat jetzt ein Feld für `version` + `builtAt`. Bis
hierhin hielt das Logbuch fest, welche PRs **gemeint** waren — nicht, welcher
Quellstand **ankam**. Genau diese Lücke hat den Abend gekostet.

- Durchgeführt von: Alrik (beide Publishes, Gate-Lauf), Protokoll: CC
- Tickets: `6hHW39P2JxmcjvQp` (Avise/Qonto), `6hWvrJgff5xr9hfp` (0d-Messwerkzeug)

### 2026-09-18 — Umsatz-Kachel (unterer Block + S-1) und der Vor-Riegel — Publish durch, OHNE Release-Step

**Anlass:** Sechs gemergte PRs, gebündelt in EINEM Publish (Batch-Policy oben):

| PR | Inhalt | Schema? |
|---|---|---|
| #148 | Umsatz-Kachel, unterer Block: Kosten aufgefächert, Potenzial-Spalten, Cutoff nach Weg A | nein |
| #152 | S-1: alle vier Ansichten sagen, was sie zählen und was der Monatsabschluss damit macht | nein |
| #149 | Korrektur-Protokoll LN-Constraint (`docs/corrections/`) | nein |
| #151 | Doku-Konvention (Beschreibung / Kommentar / Chat) nach `CLAUDE.md` | nein |
| #153 | `CLAUDE.md`-Korrektur: Schritt 0d ist auf dem Replit-Pfad kein Riegel | nein |
| #154 | Riegel VOR dem Publish (`npm run pre-publish-gate`) + zwei fail-open-Stellen im Drop-Detektor | nein |

**Kein DDL in diesem Publish.** Reader-, UI-, Skript- und Dokumentänderungen; keine
Migrationsdatei, keine Spalten- oder Tabellenänderung, kein Constraint.

**Dieser Publish lief OHNE den Release-Step.** Die `.replit`-Build-Zeile in Alriks
Workspace ist seit dem 17.09. lokal um `bash scripts/migrate.sh --force`
erleichtert, weil Schritt 0d gegen Prod nicht durchkommt (Ticket
`6hWvrJgff5xr9hfp`). Es gab also **keinen** Identitätsriegel (0a), **keinen**
DROP-Trockenlauf (0d), **keine** Nachbedingung (1b) und **keine** Datenstand-Prüfung
(0e/2). Das ist bei „kein DDL" vertretbar und war es genau deshalb — es ist keine
Zusage für den nächsten Publish. Im Repo steht die richtige Zeile; sie geht zurück,
sobald 0d einen Weg hat.

**Ersatz dafür war der neue Vor-Riegel** (`npm run pre-publish-gate`, aus #154),
hier zum ersten Mal gegen echtes Prod gefahren:

```
[ ✓ ] Verglichen wurde
      Ziel helium/heliumdb gegen Prod ep-still-term-akch49kv.c-3.us-west-2.aws.neon.tech/neondb
[3/4] ACHTUNG: die Build-Zeile ruft `migrate.sh` NICHT auf.
```

Beide Auflagen aus dem Ticket sind damit in der Praxis erfüllt: der Vergleich ist
**sichtbar** (beide Datenbanken beim Namen, kein Passwort im Log), und die Warnung
zu Schritt 3 hat gegriffen — in genau dem Zustand, für den es sie gibt.

**Backup:** kein lokaler Dump. Die Prod-DB hat **Point-in-time recovery über 7 Tage**
plus Scheduled Backups mit 28 Tagen Aufbewahrung; PITR kann auf eine Minute vor dem
Publish zurück, was ein Tages-Snapshot nicht könnte. Der Runbook-Punkt „Auto-Backup
≤ 1 h alt" ist damit gegenstandslos, nicht übersprungen — §5-Vorlage oben ist auf
Dump-Dateien geschrieben und passt für diese Lage nicht mehr.

**Nicht erhoben und deshalb hier nicht behauptet:** exakte Publish-Uhrzeit und
Build-ID. Gemeldet wurde der Abschluss um 12:06 UTC im Ticket
`6hWvMvpxpJFFjwQG`; der Publish lag davor.

- Durchgeführt von: Alrik (Publish + Gate-Lauf), Protokoll: CC
- `PROD_DATABASE_URL` nach dem Lauf wieder unset
- Tickets: `6hWgVqw2C8442hcG` (Kachel), `6hWvMvpxpJFFjwQG` (Gate-Reihenfolge), `6hWvrJgff5xr9hfp` (0d/`.replit`)

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
