# CareConnect — Betriebs- & Arbeitsregeln

Elderly-care-Service-Management. Diese Datei gilt für die Nicht-Replit-Umgebung
(Hetzner-Server + Coolify, Docker-Deploy aus GitHub). `replit.md` bleibt bis zum
Cutover parallel gültig (Replit-Betrieb).

## Deploy & Betrieb (Hetzner/Coolify)

- **Deploys macht Coolify bei Push — NIE auf dem Server bauen.** Coolify baut das
  Image aus dem `Dockerfile` (Multi-Stage) bei Git-Push und startet den Container.
  Kein manuelles `npm run build`/`node` auf dem Host.
- **Prod-DB NIE anfassen.** Keine manuellen Schreib-/DDL-Zugriffe auf die Prod-
  Datenbank. Schema-Änderungen laufen ausschließlich über den Migrations-Pre-Deploy
  (unten). Dev arbeitet gegen eine Prod-**Kopie**-DB, nie gegen Prod.
- **Container-Start**: `node dist/index.cjs` (aus dem Image), lauscht `0.0.0.0:$PORT`.
- **Healthcheck**: `GET /health` (schlank: DB-Ping + Build-Version, ohne Auth/PII).
  Das reichhaltige `GET /api/health` (Startup/Chromium/Migrationen) bleibt separat.

## Migrationen (Coolify Pre-Deploy-Command)

- **Pre-Deploy-Command**: `bash scripts/migrate.sh` — führt `drizzle-kit push`
  gegen `DATABASE_URL` (direkt-pg/TCP, kein Neon-Proxy nötig).
- **Versions-Pinning (drift-sicher)**: `migrate.sh` liest die drizzle-kit-Version
  EXAKT aus `package-lock.json` — nie `@latest`. Migrationstool-Drift auf echten
  Abrechnungs-/Patientendaten ist ein reales Risiko.
- **Datensicherheit**: `push` ohne Argumente ist interaktiv. `bash scripts/migrate.sh
  --force` wendet Änderungen nicht-interaktiv an — INKL. potenziell destruktiver
  (Spalten-Drops). Vor `--force` den Schema-Diff prüfen. Bewusst kein Default.
- **Absicht erklären, sonst fail-closed**: `drizzle.config.ts` und beide
  Test-Seeds brechen auf jeder Nicht-Wegwerf-DB ab (Allow-List-SSoT
  `scripts/lib/ephemeral-db-guard.ts`). Die drei legitimen Wege setzen
  `ALLOW_NON_EPHEMERAL_DB_WRITE=1` selbst: `scripts/migrate.sh` (Prod-Pre-Deploy),
  `npm run db:push` (Dev-Schema) und `scripts/reseed-dev-db.sh` (Dev-Reseed, hat
  zusätzlich seinen `--apply`- + Hostname-Guard). Ein nackter
  `npx drizzle-kit push` in einer Shell mit geerbter `DATABASE_URL` ist blockiert —
  er war der Weg, auf dem `--force` versehentlich eine echte DB treffen konnte.
  Der Guard läuft beim Config-Load, trifft also auch `generate`/`check`/`studio`
  und `--dry-run`. **Den Marker nie von Hand in einer Shell setzen** — er gehört
  in genau diese drei Skripte. `scripts/post-merge.sh` fährt `npm run db:push`
  unbeaufsichtigt gegen die Dev-DB; das ist der einzige Weg, bei dem „Absicht
  erklärt" nicht heißt, dass gerade jemand hinsieht.
- **Idempotente Startup-DDL**: Ergänzend laufen die Fixes in `server/startup/**`
  beim Boot (z.B. km-/geo-numeric, invoice-per-pot). Die gehören NICHT in
  `drizzle-kit push` (siehe `replit.md` → Gotchas).

## Schaltbare Infrastruktur-Env (additiv, Replit-kompatibel)

| Env | Default | Prod (Hetzner) | Zweck |
|-----|---------|----------------|-------|
| `DB_DRIVER` | `neon` | `pg` | `pg` = node-postgres/TCP (Standard-Postgres 16) |
| `STORAGE_DRIVER` | `replit` | `local` | `local` = FS-Treiber unter `FILE_STORAGE_ROOT` |
| `FILE_STORAGE_ROOT` | — | Volume-Pfad (z.B. `/data`) | Wurzel der lokalen Objekt-Ablage |
| `APP_DOMAIN` | — | echte Domain | Vorrang vor Replit-Domains für externe Links |
| `EMAIL_/WHATSAPP_/TWILIO_TRANSPORT` | (safe) | Prod: `real` / Dev: `stub` | safe-by-default: außer Prod immer Stub |
| `CHROMIUM_PATH` | (Fallback `/usr/bin/chromium`) | im Image gesetzt | PDF-Rendering |

- **Boot-Mindest-Env**: `DATABASE_URL`, `DB_DRIVER=pg`, `ENCRYPTION_KEY` (64-hex,
  signiert auch CSRF/Tokens), `APP_DOMAIN`, `STORAGE_DRIVER=local`,
  `FILE_STORAGE_ROOT`, `PORT`. Vollständige Env-Tabelle: `docs/environment-variables.md`.
- **Dev-Umgebung MUSS die Transports stubben** (`*_TRANSPORT=stub` oder
  non-prod `NODE_ENV`), da sie eine Prod-Kopie-DB mit echten Provider-Tokens nutzt.

## Arbeitsregeln (aus `replit.md` übernommen — gelten unverändert)

- **Ersetzungs-Regel (ersetzen statt hinzufügen)**: Jede neue Funktion/Tabelle/
  Spalte/Mechanismus MUSS benennen, was sie ERSETZT. „Kommt zusätzlich hinzu" →
  NICHT bauen, erst bei Alrik rückfragen. Gilt ausdrücklich auch für die KI.
- **Eine SSoT pro fachlicher Frage (+ Integer-Cents)**: Genau eine Funktion pro
  fachlicher Frage; Anzeige- und Schreibpfade importieren dieselbe. Geld = Integer-Cents.
- **Erstberatungen werden dem KUNDEN nicht abgerechnet — mitarbeiterseitig zählen sie
  voll (zweiseitige Regel, #1886).** Erstberatungs-Termine (`appointment_type =
  'Erstberatung'`, kundenlose Interessenten-/Prospect-Termine mit `customer_id = NULL`;
  Service `erstberatung`: `isBillable:false`, `defaultPriceCents:0`, `budgetPots:[]`) sind
  Akquise, kein abrechenbarer Kundentermin.
  - **Kundenseite (ausschließen):** keine Kunden-/Kassen-Rechnung, kein Leistungsnachweis,
    nie in Rechnungsliste/Abrechnung. In kundenseitigen „abrechenbar/dokumentiert aber
    fehlt"-/Reconciliation-Audits dürfen sie NICHT als Lücke erscheinen (sonst Fehlalarm).
    Sie werden nie als „Kundenunterschrift fehlt" geflaggt (kein Kunde, gegen den
    unterschrieben würde). SSoT-Prädikate: `completedButUnsignedSqlRaw` / `notErstberatungSqlRaw`
    in `server/lib/appointment-signed.ts` (`appointment_type <> 'Erstberatung'`, NULL-sicher).
  - **Mitarbeiterseite (voll zählen, NICHT ausschließen):** Arbeitsleistung, Stunden, km und
    Lohn zählen normal — der `erstberatung`-Service hat `employeeRateCents > 0`, die
    Lohn-/Stunden-SSoT `server/storage/time-tracking/payroll-hours.ts` bucketet Erstberatung
    ausdrücklich (`stundenErstberatung`). Kundenseitige Ausschlüsse eng fassen, damit sie
    keinen Lohn-/Stunden-/km-Pfad treffen.
- **Tests nur gegen Dev/Ephemeral-DBs — NIE gegen Prod.** Cleanup-/Reseed-Skripte
  brauchen `--apply` + Hostname-Guard. Dev-DB-Guard nicht umgehen.
- **Einmal-Korrekturskripte sind temporäre Werkzeuge (`server/scripts/fix-*`).**
  Nach „angewendet + verifiziert" das `.ts` LÖSCHEN und stattdessen ein kurzes
  Protokoll unter `docs/corrections/<datum>_<fall>.md` ablegen (Problem, Maßnahme,
  Vorher/Nachher, Audit-Referenz). Das Protokoll ERSETZT das liegengebliebene
  Skript als Nachweis; der vollständige Nachweis ist git-Historie + DB-Audit-Log
  + `.md`. Liegengebliebene Skripte brechen `tsc`/CI, sobald sich Signaturen
  ändern, und suggerieren einen wiederholbaren Vorgang, den es nicht gibt.
  Wiederverwendbare Fähigkeiten als echtes Feature bauen, nicht als Skript.
- **UI-Präferenzen**: Keine Blur-Effekte (`backdrop-blur` verboten); Overlays max.
  `bg-black/50` ohne Blur. Keine CSS-Transforms in Dialog/AlertDialog/Sheet/Drawer
  (Sub-Pixel-Unschärfe) — Flexbox-Zentrierung + reine Fade-Animationen. Zentrale
  `SignaturePad`-Komponente für ALLE Unterschriften. Keine Avatare/Profilbilder.
- **Kommunikationsstil**: einfache, klare Sprache.

## Wiederkehrende fachliche Regeln & Fallen (bindend)

Stehender Urteils-Kontext. Diese Regeln sind aus realen Prod-Vorfällen entstanden —
sie gelten auch dann, wenn die aktuelle Aufgabe sie nicht erwähnt.

- **GoBD**: Gestellte/versendete Rechnungen NIE still editieren → **Storno +
  Neuausstellung** (neue Nummer, Original referenziert). Nie einen bereits
  gestellten Betrag rückwirkend *erhöhen*.
- **Signierter Leistungsnachweis**: Termin entfernen nur, wenn keine **aktive**
  (nicht-stornierte) Rechnung dranhängt — sonst zuerst stornieren.
  In-place-Korrektur ist **reduktions-only**.
- **Erstberatung**: zweiseitig — kundenseitig nie abgerechnet, mitarbeiterseitig
  (Lohn/Stunden/km) voll. Ausschlüsse nur auf Kundenpfaden (Details oben).
- **§45b**: Anker = Pflegegrad (nicht Vertrag); Verfall strikt 30.06.(Y+1).
- **Kostenträger**: immer zeitraumgenau auflösen (Stichtag = Periodenende),
  Kassenwechsel nur zum 1. eines Monats.
- **`todayISO()`-vs-`asOf`-Falle**: Bei JEDER Datums-/Stichtags-Frage prüfen, ob
  fälschlich „heute" statt „as-of Zeitraum" gelesen wird. Dieser Bug ist dreimal
  aufgetreten: §45b-Verfall, Kostenträger-Empfänger, `asOfIso` in `invoice-calc`.
- **Eine SSoT pro fachlicher Frage**: Anzeige-, Schreib- UND Filter-Pfade
  importieren dieselbe Funktion; kein Zweitbegriff derselben Frage.
- **Nebenbefunde**: Jeden Nebenbefund (Bug/Auffälligkeit/Tech-Debt), der beim
  Arbeiten auffällt, im **PR-Body als `FINDING: … [P1/P2/P3]`** vermerken —
  Alrik/Cowork übernimmt ihn in die Long-List. Den laufenden Task NICHT
  entgleisen lassen.
- **Test-Fallen**: `getFutureDate` rollt Sa/So auf Montag → mehrere Offsets
  kollabieren auf denselben Tag (Do–So-Flake) → eigene Uhrzeit je Seed-Termin.
  Der `tests`-CI-Job ist **bekannt rot** (Stand 06.08.2026, `91f11570`:
  8 Tests / 7 Dateien Altbestand); PRs gegen diese Baseline diffen, nicht
  gegen „grün".

## Arbeitsmodus: autonom bis zur PR, Mensch an 4 Gates

Der volle Loop (read → plan → implement → tsc/lint/test → commit → push → PR →
CI) läuft **autonom**. Ein Mensch klinkt sich nur an diesen vier Punkten ein:

1. **Fachliche Weiche** — offene Domänen-Entscheidung, *bevor* gebaut wird
   (Variante A/B, GoBD-Frage). Greift nur, wenn wirklich offen. → Alrik entscheidet.
2. **PR-Diff-Review** — Urteilsblick auf die Billing-/GoBD-Logik *vor* dem Merge.
   → Cowork-Claude ODER ein Reviewer-Subagent, der den Code nicht geschrieben hat.
   Zwei risiko-gestufte Reviewer, **explizit by name aufrufen** (kein
   Auto-Routing — ein fehlgeleiteter kritischer PR verliert den zweiten Blick):
   - **`deep-reviewer`** (`.claude/agents/deep-reviewer.md`, Opus) — **Default,
     im Zweifel immer dieser.** Pflicht, sobald der Diff *irgendetwas* davon
     berührt: Billing/Abrechnung, §45b-Budget/Verfall, Kostenträger-Auflösung,
     Leistungsnachweis/Signatur, Auth/Permissions, Schema/Migrationen,
     öffentliche API/Response-Schemata, Datenintegritäts-Formeln (Carryover, FIFO).
   - **`light-reviewer`** (`.claude/agents/light-reviewer.md`, Haiku) — bewusste
     Ausnahme, nur wenn der Diff *ausschließlich* aus Docs/Markdown, Config ohne
     Logik, reinen Test-Refactorings, kosmetischen/Lint-Fixes oder Tippfehlern
     besteht, **keinen** der deep-Pfade berührt und typischerweise < 100 Zeilen
     ist. Er hat kein `Grep` und bricht bei kritischen Funden ab.

   Beide ERSETZEN den früheren `reviewer`-Subagenten (Datei entfernt).
3. **Merge + Deploy** — Admin-Merge nach `main` + Prod-Publish. → Alrik bestätigt.
4. **Prod-Schreiboperation** — Dry-Run zuerst, dann ausdrückliche Freigabe je
   Schritt. → Alrik bestätigt.

Alles dazwischen läuft ohne Rückfrage. Grundsatz: **Gate dort, wo Urteil oder
Unumkehrbarkeit sitzt — nicht überall.**

### Der Bash-Gate ist ein Stolperdraht, kein Sandbox-Ersatz

Damit „läuft ohne Rückfrage" nicht heißt „läuft ohne Schranke", prüft ein
PreToolUse-Hook (`.claude/hooks/bash-gate.sh` + `bash-gate.py`, Wächter:
`tests/architecture/bash-gate.test.ts`) jedes Bash-Kommando und sperrt die
gefährliche Handvoll: `sudo`, `docker`, `git push --force`, Push nach
`main`/`master`, `gh pr merge`, `rm -rf` auf System-/Home-Pfaden,
`git reset --hard`, `git clean -f`, `curl|bash`, `chmod`/`chown` auf
Systempfaden, Schreib-Redirects nach `/etc`, `/usr` & Co. Default ist `allow`.

**Er fängt Versehen, keinen Vorsatz.** Er ist ein Kommando-Filter und als
solcher grundsätzlich umgehbar — Präfixe (`env`, `command`, `nohup`, `{ …; }`),
Variablen-Expansion (`X=sudo; $X …`), Command-Substitution, `xargs`/`find -exec`
oder ein umbenanntes Verzeichnis (`mv .claude .claude-off`) laufen daran vorbei.
Das ist bewusst offen und im Test als Block `BEWUSST_OFFEN` festgehalten, statt
es zu verschweigen: ein Filter, der all das abdeckt, blockiert normale Arbeit,
und vollständig wird er trotzdem nie.

**Unbeaufsichtigter Betrieb mit fremdem Input braucht eine Sandbox, nicht
diesen Filter.** Fremder Input heißt alles, was nicht von Alrik kommt —
Issue-Texte, PR-Kommentare, gescrapte Inhalte, Fremd-Repos. Für den heutigen
Betrieb (Aufgaben von Alrik, eigenes Repo) ist der Stolperdraht angemessen; er
ist keine Grundlage, auf der man den Kreis der Auftraggeber erweitert.

Wichtig für Änderungen: **`permissions.ask` muss leer bleiben.** Gemessen gilt
`Hook-deny > Regel-deny > Regel-ask > Hook-allow > Regel-allow` — ein Hook kann
eine `ask`-Regel NICHT aufheben. Der Hook ERSETZT die `ask`-Liste; kommt sie
zurück, prompten ihre Muster wieder, egal was der Hook sagt. Das `deny`-Array
bleibt als zweite Lage, weil es ein Hook-`allow` schlägt und damit auch einen
Fehler im Hook abfängt.

Der Hook schützt sich **teilweise** selbst: Bash-Kommandos, die `.claude/hooks/**`
oder `settings.local.json` schreiben, sind gesperrt, Edit/Write auf `.claude/**`
ebenso — Änderungen daran macht Alrik, und praktisch heißt das: die Dateien
werden außerhalb dieses Verzeichnisses gebaut, geprüft und dann von Hand
hineinkopiert. **Nicht** gesperrt sind Wege, die den Pfad nicht buchstäblich
nennen: `mv .claude .claude-off`, `rm -rf .claude` und — seit der Versionierung
neu — `git checkout <alter-commit> -- .claude/hooks/bash-gate.py`, also das
Zurücksetzen auf eine schwächere Gate-Version. `git` steht bewusst in der
Lese-Allowlist, weil die frühere Ausnahme nichts schützte (`git checkout main
-- .`, `git stash`, `git restore .` kommen ohne den Pfad aus) und nur das
Versionieren unmöglich machte. Das ist derselbe Stolperdraht-Anspruch wie oben,
kein Widerspruch dazu.

## Integrationstests lokal fahren

**ERSETZT den CI-Roundtrip als einzigen Weg, Integrationstests zu sehen.** Vorher
war jede Test-Frage ein Push + ~20 min CI + Artefakt-Download; jetzt läuft
dieselbe Suite lokal in Sekunden. Der CI-`tests`-Job bleibt die verbindliche
Instanz — lokal ist die Vorstufe, nicht der Ersatz für den grünen Check am PR.

Zwei Wege, klar getrennt: der **Orchestrator** ist der Default für alles, der
**1:1-CI-Nachbau** ist der abgezäunte Fallback für CI-only-Fehlschläge.

`docker-compose.test.yml` liefert die fehlende Zutat: `postgres:16` + Neon-WS-Proxy,
beide nur auf `127.0.0.1`, DB auf `tmpfs`. Voraussetzung auf dem Host:
`psql`/`pg_dump` im PATH (`sudo apt-get install postgresql-client` — den **Client**,
nicht `postgresql`; das Server-Paket belegt 5432 und kollidiert mit dem Container).

**Der Test-Postgres läuft PERSISTENT — der Routine-Loop startet ihn nicht.**
Er hat `restart: unless-stopped` und kommt nach Host-Reboot/Docker-Restart von
selbst zurück. Das ERSETZT das `sudo docker compose up/down` als Teil jedes
Testlaufs: **`dev` bekommt kein passwortloses `sudo` mehr, und der Routine-Loop
darf weder `sudo` noch `docker` brauchen** (er ist auch nicht in der
`docker`-Gruppe — `docker ps` ohne `sudo` ist verweigert). Routine-Weg =
DB läuft schon, direkt Tests fahren; der Orchestrator spricht sie nur über
`DATABASE_URL`/`psql` an. Die `docker compose`-Zeilen unten sind **einmalig/
administrativ** (Erstaufsetzen, Image-Wechsel, bewusstes Stoppen) — nicht in den
Loop kopieren. Läuft die DB wirklich mal nicht, ist das ein administrativer
Vorfall für Alrik, kein Schritt, den der Executor selbst nachholt.

Der Neon-Proxy hat bewusst KEINE `restart`-Policy: ihn braucht nur der
Fallback-Ablauf, und der ist ohnehin administrativ. Der Orchestrator wählt ihn
per `DB_DRIVER=pg` ab.

`.env.test.local` ist gitignored und enthält genau diese Wegwerf-Werte:

```bash
NODE_ENV=test
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cc_test_careconnect
NEON_LOCAL_WS_PROXY=localhost:4444
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
TEST_USER_EMAIL=ci-test@example.com
TEST_USER_PASSWORD=TestPasswort123!
SUPER_ADMIN_EMAIL=ci-test@example.com
```

### Default: Orchestrator (`scripts/with-ephemeral-db.ts`)

Der kanonische Weg — Details in `docs/test-infrastructure.md`. Er macht Push,
beide Seeds, Per-Worker-Wegwerf-DBs, App-Server auf **frei vom OS vergebenen**
Ports und den Teardown selbst; der Template-Cache macht warme Läufe schnell.

Der Routine-Ablauf — **ohne `sudo`, ohne `docker`**, die DB läuft bereits:

```bash
unset CI TEST_DATABASE_URLS TEST_BASE_URLS
set -a; . ./.env.test.local; set +a
unset NEON_LOCAL_WS_PROXY; export DB_DRIVER=pg      # PFLICHT, siehe unten
npx tsx scripts/with-ephemeral-db.ts 5050 npx vitest run tests/<pfad>/<datei>.test.ts
```

Nur einmalig/administrativ (nicht im Loop) — Stack aufsetzen bzw. bewusst stoppen:

```bash
sudo docker compose -f docker-compose.test.yml up -d     # einmalig, bleibt oben
sudo docker compose -f docker-compose.test.yml down      # nur absichtlich
```

**`DB_DRIVER=pg` ist hier nicht optional.** Mit dem Neon-Proxy kollabieren alle
Per-Worker-DBs auf dessen Fixed Target — die Isolation, für die es den
Orchestrator gibt, wäre still weg. Er geht deshalb direkt über TCP.

### Fallback: 1:1-Nachbau des CI-Jobs

> **Nur zum Reproduzieren von CI-only-Fehlschlägen.** Für alles andere den
> Orchestrator nehmen. Dieser Ablauf ist **administrativ**: er braucht den
> Neon-Proxy (also `sudo docker compose up`) und wirft die persistente Test-DB
> mit `down` weg. Nicht aus dem Routine-Loop heraus fahren — bei Bedarf Alrik.

Nötig, weil der gating `tests`-Job **anders läuft als der Orchestrator**: EINE
geteilte DB, fester Port 5000, alle Dateien nacheinander dagegen, App-Zugriff über
den **Neon-WS-Proxy** statt Direkt-TCP. Genau daraus entstehen die Fehlschläge, die
nur in CI auftreten (Cross-Datei-Kontamination in der geteilten DB, Proxy-Verhalten,
Reihenfolge-Abhängigkeiten) — der Orchestrator mit seinen Per-Worker-DBs kann sie
per Konstruktion nicht zeigen. Dieser Ablauf ist das einzige Werkzeug dafür.

```bash
npm ci                                            # drizzle-kit-Version aus dem Lockfile
sudo docker compose -f docker-compose.test.yml up -d   # administrativ; holt den Neon-Proxy dazu

unset CI TEST_DATABASE_URLS TEST_BASE_URLS        # `source` kann nur setzen, nie löschen
set -a; . ./.env.test.local; set +a               # Semikolons, damit `set +a` immer läuft
ss -ltn | grep -q ':5000 ' && echo "ABBRUCH: Port 5000 belegt — erst freimachen"

npx drizzle-kit push --force                      # Schema
npx tsx scripts/ci-seed-superadmin.ts             # Login für globalSetup
npx tsx scripts/seed-test-reference-data.ts       # Services, company_settings
NODE_ENV=test npx tsx server/index.ts > server.log 2>&1 &
tail -3 server.log && curl -sf http://localhost:5000/api/health   # BEIDES prüfen

npx vitest run tests/<pfad>/<datei>.test.ts       # oder ohne Pfad: volle Suite

fuser -k 5000/tcp                                 # Server stoppen (siehe Fallen)
sudo docker compose -f docker-compose.test.yml down    # DB ist tmpfs, weg ist weg
# Danach den persistenten Stack wieder hochfahren (`up -d`) — der Routine-Loop
# erwartet eine laufende Test-DB und startet sie selbst nicht.
```

### Fallen

- **Die schreibenden Entrypoints prüfen ihr Ziel selbst.** `drizzle.config.ts`
  und beide Test-Seeds rufen die Allow-List-SSoT
  (`scripts/lib/ephemeral-db-guard.ts`) und brechen ab, wenn die `DATABASE_URL`
  nicht auf eine `cc_test_`-DB zeigt — auch bei geerbter oder leerer URL. Das
  ERSETZT den früheren `guard()`-Shell-Zaun in diesem Ablauf. Die legitimen
  Nicht-Test-Wege erklären ihre Absicht über `ALLOW_NON_EPHEMERAL_DB_WRITE=1`
  (Details: oben unter „Migrationen"). Ein nackter `npx drizzle-kit push` oder
  Seed-Aufruf gegen eine echte DB ist damit blockiert.
- **`CI` NICHT setzen.** `CI=true` schaltet den Wegwerf-DB-Guard ab
  (`scripts/lib/ephemeral-db-guard.ts`, Pfad 1). Lokal soll er greifen — deshalb
  heißt die DB `cc_test_careconnect` (Präfix erfüllt Pfad 3) statt wie in CI
  `careconnect`. Dasselbe gilt für `TEST_DATABASE_URLS` (Pfad 2, Rest aus einem
  Orchestrator-Lauf) — daher das `unset` im Preflight.
- **Port 5000 belegt = stiller Fehlschlag** (nur Fallback-Ablauf; der
  Orchestrator vergibt freie Ports und hat das Problem nicht). Der Server stirbt
  mit `EADDRINUSE` nur in `server.log`, und `curl /api/health` antwortet
  **erfolgreich** — vom Dev-Server. Die Health-Payload nennt weder `NODE_ENV` noch
  DB-Namen, man merkt es also nicht. Die Tests schreiben danach in die Dev-DB.
  Deshalb der Port-Check vorher und `tail server.log` vor dem `curl`.
- **Server über den Port stoppen, nicht über PID oder Muster.** `$!` liefert den
  `npx`-Wrapper, nicht den lauschenden Node-Prozess — `kill "$!"` lässt Port 5000
  belegt zurück. Und `pkill -f 'server/index…'` erwischt sich selbst, sobald der
  Ablauf als EIN Kommando läuft (Skript, `bash -c`): die eigene Kommandozeile
  enthält das Muster, der Aufrufer stirbt mit. `fuser -k 5000/tcp` trifft genau
  den Prozess, der den Port hält — interaktiv wie im Skript.
- **Der Neon-Proxy ist eine Fixed-Target-Brücke.** Er ignoriert den DB-Namen aus
  `DATABASE_URL` und leitet auf sein eigenes `PG_CONNECTION_STRING`. Im
  Fallback-Ablauf gehen App-Server und Seed-Skripte über den Proxy,
  `drizzle-kit push` und `psql` direkt über TCP. Nennen beide nicht dieselbe DB,
  landet das Schema in der einen und die App in der anderen — ohne Fehlermeldung.
  Im Orchestrator-Ablauf ist der Proxy deshalb per `DB_DRIVER=pg` abgewählt.
- **`cc_test_careconnect` ist Ziel des Orphan-Sweeps.** Der `cc_test_`-Präfix
  meldet die DB auch beim Sweeper an (`scripts/lib/ephemeral-db-sweep.ts`).
  `npm run test:unblock` oder ein Orchestrator-Start droppen sie, sobald keine
  Verbindung dranhängt — Schema und Seeds des Fallback-Ablaufs sind dann weg.
- **Lokale Baseline ≠ CI-Baseline, und sie ist datums-fragil.** Voller Lauf am
  06.08.2026 auf `main` (`91f11570`, nach #61): **21 rote Tests / 9 Dateien**
  von 3838, ~5 min. Aufgeschlüsselt:
  - **Host-Ausstattung — 14 Tests / 2 Dateien**, alle mit
    `ChromiumUnavailableError` (`pdf-generator-resilience` 8,
    `invoice-pdf-margins` 6). Einzeln nachgeprüft; das ist die EINZIGE
    host-erklärte Menge. `zugferd-send-failure` scheitert anders und zählt
    NICHT hierher.
  - **§45b-/Kalender-Menge — 0 Tests.** Der frühere Block (21 Tests /
    11 Dateien §45b-Budget-Mathematik plus 7 datumsabhängige) ist über #49–#59
    abgearbeitet. Wiederverwendbarer Kern ist die Anker-Familie in
    `tests/helpers/billing-month.ts` — `carryoverAnchor` (Frist als Kontext),
    `expirySubjectAnchor` (Frist als Prüfgegenstand), `expiredCarryoverAnchor`
    (bereits verfallen); alle drei per Tages-Sweep über 12–15 Jahre abgesichert.
    Wer eine §45b-Fixture datiert, greift dort zu statt neu zu rechnen.
  - **Rest — 7 Tests / 7 Dateien**: die vier `architecture/*`-Wächter je 1
    (`ssot-imports`, `replit-boot-path`, `budget-typesettings-read-path`,
    `budget-default-pots-ssot`), `query-invalidation-discipline` 1,
    `equality/appointment-series-bulk-rebook` 1,
    `billing/zugferd-send-failure` 1.
  Derselbe Commit in **CI: 8 rote Tests / 7 Dateien** (Run `31109841750`, der
  `push`-Lauf auf `main` — nicht der PR-Lauf; Run-ID mit notieren, sonst ist die
  Zahl später nicht zuzuordnen). Die Differenz geht in BEIDE Richtungen und
  rechnet sich vollständig auf:
  `21 − 14 (Chromium fehlt lokal) − 1 (`equality/appointment-series-bulk-rebook`)
  − 1 (`billing/zugferd-send-failure`) + 2 (`architecture/bash-gate`)
  + 1 (`startup/dedupe-pending-…`) = 8`; Dateien `9 − 2 − 1 − 1 + 1 + 1 = 7`.
  Wer nur die Chromium-Richtung abzieht, landet bei 14/9 und meldet zwei
  Phantom-Regressionen — die beiden mittleren Posten sind lokal rot, in CI grün.
  **In Arbeit:** #63 (`ssot-imports`) und #64 (die drei übrigen `architecture/*`)
  nehmen zusammen 4 der 8 CI-Tests weg. Nach ihrem Merge ist hier neu zu messen.
  **Zwei Läufe, zwei Zahlen — auch ohne Kalenderwechsel.** Derselbe Commit lieferte
  lokal erst 27/12, dann 25/10; die Differenz waren
  `tests/budget-transactions-immutability.test.ts` (1) und
  `tests/startup/cleanup-legacy-auto-allocations-migration.test.ts` (2), beide
  Kontaminations-Flakes der geteilten DB. Eine einzelne Messung reicht für eine
  Baseline also NICHT — bei Abweichung ein zweites Mal fahren und die stabile
  Schnittmenge nehmen.
  **Die Zahl gilt für diesen Tag.** Sie steigt und fällt mit der Kalenderlage —
  am 02.08.2026 waren es 37 Dateien / 78 Tests. Bei Zweifel neu auf `main`
  erheben statt fortschreiben, und PRs immer per **same-day-A/B** gegen einen
  frischen `main`-Lauf diffen, nie gegen eine notierte Zahl.
- Im Fallback-Ablauf den Server nach Server-Code-Änderungen neu starten — die
  Tests sprechen den gebooteten Prozess an, nicht den Quelltext. Der Orchestrator
  startet ihn pro Lauf frisch und hat das Problem nicht.

## Stack & Wo was liegt

- **Frontend** React 19 + Vite + Tailwind v4 (`client/src/`); **Backend** Express +
  Drizzle (`server/`); **Shared** Domain-/Schema-Logik (`shared/`).
- **DB** Postgres 16 (Prod: Coolify-intern via `pg`-Treiber; Replit: Neon).
- **Build** Vite (Client) + esbuild-Bundle (`dist/index.cjs`), via `npm run build`.
- **Storage** Objekt-Treiber-Abstraktion `server/lib/storage/` (`replit` GCS/Sidecar
  · `local` FS + Sidecar-`.meta.json`).

## Gotchas (Auszug — Details in `replit.md`)

- `drizzle-orm`/`drizzle-zod`/`@neondatabase/serverless`/`ws` NICHT ins Server-Bundle
  bundlen (bricht SQL-Template-Komposition) — bleiben external.
- **WhatsApp-Provider = Twilio** (Content API, `HX…`-SIDs).
- Sensible `company_settings`-Spalten sind AES-256-GCM at-rest (`ENCRYPTION_KEY`).
- Chromium-Pfad zur Laufzeit aufgelöst (`CHROMIUM_PATH` → `which` → `/usr/bin/chromium*`).
