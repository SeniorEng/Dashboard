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
- **Tests nur gegen Dev/Ephemeral-DBs — NIE gegen Prod.** Cleanup-/Reseed-Skripte
  brauchen `--apply` + Hostname-Guard. Dev-DB-Guard nicht umgehen.
- **UI-Präferenzen**: Keine Blur-Effekte (`backdrop-blur` verboten); Overlays max.
  `bg-black/50` ohne Blur. Keine CSS-Transforms in Dialog/AlertDialog/Sheet/Drawer
  (Sub-Pixel-Unschärfe) — Flexbox-Zentrierung + reine Fade-Animationen. Zentrale
  `SignaturePad`-Komponente für ALLE Unterschriften. Keine Avatare/Profilbilder.
- **Kommunikationsstil**: einfache, klare Sprache.

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
