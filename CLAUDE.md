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
  Der `tests`-CI-Job ist **bekannt rot** (~28 Dateien Altbestand); PRs gegen
  diese Baseline diffen, nicht gegen „grün".

## Arbeitsmodus: autonom bis zur PR, Mensch an 4 Gates

Der volle Loop (read → plan → implement → tsc/lint/test → commit → push → PR →
CI) läuft **autonom**. Ein Mensch klinkt sich nur an diesen vier Punkten ein:

1. **Fachliche Weiche** — offene Domänen-Entscheidung, *bevor* gebaut wird
   (Variante A/B, GoBD-Frage). Greift nur, wenn wirklich offen. → Alrik entscheidet.
2. **PR-Diff-Review** — Urteilsblick auf die Billing-/GoBD-Logik *vor* dem Merge.
   → Cowork-Claude ODER der `reviewer`-Subagent (`.claude/agents/reviewer.md`),
   der den Code nicht geschrieben hat.
3. **Merge + Deploy** — Admin-Merge nach `main` + Prod-Publish. → Alrik bestätigt.
4. **Prod-Schreiboperation** — Dry-Run zuerst, dann ausdrückliche Freigabe je
   Schritt. → Alrik bestätigt.

Alles dazwischen läuft ohne Rückfrage. Grundsatz: **Gate dort, wo Urteil oder
Unumkehrbarkeit sitzt — nicht überall.**

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
