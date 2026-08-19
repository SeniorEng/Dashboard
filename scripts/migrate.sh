#!/usr/bin/env bash
#
# RELEASE-STEP — läuft VOR dem Serving, auf jeder Plattform.
#
# Task #1840 (Schema) + 6hHqw8c7 (Datenstand-Gate).
#
#   Coolify : Pre-Deployment-Command  →  bash scripts/migrate.sh --force
#   Replit  : [deployment].build      →  npm run build && bash scripts/migrate.sh --force
#
# Ein Skript, zwei Hooks. Die Reihenfolge steckt IM Skript, nicht in einer
# Anweisung, die jemand einhalten muss — genau daran ist der 18.08.2026
# gescheitert: der Publish lief 28 Minuten vor der Datenmigration, 54 Zeilen
# trugen einen Status, den der neue Code nicht lesen kann, und die Abrechnung
# war rund eine Stunde nicht bedienbar.
#
# ── Drei Schritte, alle gatend ─────────────────────────────────────────────
#   1. Schema-Push  (drizzle-kit, Version aus package-lock.json gepinnt)
#   2. Datenstand-Prüfung  (scripts/release-verify.ts)
#   3. — weitere Datenmigrationen kommen hier dazwischen, wenn es sie gibt
#
# `set -euo pipefail`: jeder Fehlschlag beendet das Skript mit exit≠0. Auf
# beiden Plattformen bricht das den Deploy ab; die laufende Version bleibt
# unberührt und bedient weiter.
#
# ── Plattform-agnostisch ───────────────────────────────────────────────────
# Braucht ausschließlich `DATABASE_URL` und node/npx. Keine Replit-Variable,
# keine Coolify-Variable. Der Schema-Push geht über direktes pg-TCP; die
# Datenstand-Prüfung über `server/lib/db` und damit über `DB_DRIVER` — `neon`
# (Replit/Prod) und `pg` (Coolify) funktionieren beide.
#
# ── Die DATABASE_URL wird NIE ausgegeben ───────────────────────────────────
# Sie trägt das Passwort. Gemeldet werden Host und Datenbankname, letzterer aus
# der OFFENEN Verbindung (`current_database()`) — dieselbe Quelle, gegen die das
# Prod-Schreib-Gate vergleicht. Beim Testen ist uns dieser Leak einmal passiert.
#
# ── Zu `--force` ───────────────────────────────────────────────────────────
# `drizzle-kit push` ohne Argumente ist INTERAKTIV und würde in einem Build
# hängen. Ein Release-Step muss `--force` mitgeben. Das Skript setzt es bewusst
# NICHT selbst: `--force` wendet auch destruktive Änderungen an (Spalten-Drops),
# und diese Entscheidung gehört zum Hook, nach Review des Schema-Diffs. Fehlt es
# in einer nicht-interaktiven Umgebung, bricht das Skript ab, statt zu hängen.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[migrate] FEHLER: DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi

# Nicht-interaktiv ohne `--force` würde an der drizzle-kit-Rückfrage hängen und
# den Build ins Timeout laufen lassen — ein Deploy, der nicht scheitert, sondern
# steht. Lieber laut abbrechen.
if [ ! -t 0 ]; then
  case " $* " in
    *" --force "*) ;;
    *)
      echo "[migrate] FEHLER: nicht-interaktive Umgebung ohne --force." >&2
      echo "[migrate] drizzle-kit push wuerde auf eine Rueckfrage warten." >&2
      echo "[migrate] Der Release-Hook muss --force uebergeben (nach Review des Schema-Diffs)." >&2
      exit 1
      ;;
  esac
fi

VERSION="$(node -e "process.stdout.write(require('./package-lock.json').packages['node_modules/drizzle-kit'].version)")"
if [ -z "$VERSION" ]; then
  echo "[migrate] FEHLER: drizzle-kit-Version nicht in package-lock.json gefunden." >&2
  exit 1
fi

# `drizzle.config.ts` ist fail-closed und bricht auf Nicht-Wegwerf-DBs ab
# (scripts/lib/ephemeral-db-guard.ts). Dieses Skript IST der legitime
# Prod-Migrationspfad und erklärt seine Absicht deshalb ausdrücklich. Der Schutz
# bleibt dort wirksam, wo er hingehört: beim nackten `npx drizzle-kit push` in
# einer Shell, die eine fremde DATABASE_URL geerbt hat.
export ALLOW_NON_EPHEMERAL_DB_WRITE=1

echo "[migrate] Schritt 1/2 — Schema: drizzle-kit@${VERSION} push (Version gepinnt aus package-lock.json)"
npx --yes "drizzle-kit@${VERSION}" push "$@"

# Kein `exec` mehr. Die frühere Fassung endete mit `exec npx drizzle-kit push` —
# `exec` ersetzt die Shell, danach konnte nichts mehr laufen. Genau deshalb gab
# es keinen Ort für eine Datenstand-Prüfung, und die Reihenfolge blieb eine
# Anweisung in Dokumenten.
echo "[migrate] Schritt 2/2 — Datenstand gegen den auszuliefernden Code pruefen"
npx tsx scripts/release-verify.ts

echo "[migrate] Release-Step abgeschlossen. Serving darf starten."
