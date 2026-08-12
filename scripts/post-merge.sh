#!/bin/bash
set -e

# Der Post-Merge-Lauf konkurriert mit den schweren Agent-Harness-Workflows
# (test/e2e-smoke/billing-cov/typecheck laufen parallel). Unter dieser Last
# bricht `npm install` gelegentlich mit SIGABRT (Exit 134, native
# Thread-Erzeugung scheitert / Ressourcen-Engpass) ab — KEIN echter
# Dependency-Fehler. Darum bis zu 3 Versuche mit kurzem Backoff, bevor der
# Schritt den Merge scheitern lässt. Idempotent: bei bereits installierten
# Deps ist jeder Versuch ein schneller No-Op.
install_deps() {
  local attempt
  for attempt in 1 2 3; do
    if npm install --prefer-offline --no-audit --no-fund 2>/dev/null \
      || npm install --no-audit --no-fund; then
      return 0
    fi
    echo "[post-merge] npm install Versuch $attempt fehlgeschlagen (vermutlich Ressourcen-Engpass) — neuer Versuch in 5s"
    sleep 5
  done
  echo "[post-merge] npm install nach 3 Versuchen fehlgeschlagen"
  return 1
}
install_deps

# Task #50: Add service_details column to invoice_line_items
psql "$DATABASE_URL" -c "ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS service_details TEXT;" 2>/dev/null || true

# Drizzle introspect kann bei Neon-Cold-Start minutenlang hängen (Task #540
# Post-Merge: 3400+ Spinner-Frames, 440s gelaufen bis Hard-Kill). Wir geben
# dem Push 60s Zeit; danach wird der nächste Merge oder ein manueller Push
# die Drift einsammeln. Idempotent: kein Schaden, wenn übersprungen.
timeout --signal=TERM --kill-after=5s 60s npm run db:push 2>/dev/null || \
  echo "[post-merge] db:push skipped/timed out — wird beim nächsten Lauf nachgeholt"

# Task #1900: Karteileichen-Remotes (subrepl-*) aus .git/config entfernen.
# Jeder Task-Agent-Lauf hinterlässt ein Remote mit toter SSH-URL; ohne Pflege
# staut sich das auf (1052 Stück / ~215 KB .git/config) und die Git-Oberfläche
# meldet pauschal „Failed to authenticate with the remote". Best-effort: darf
# den Merge NIE blockieren. Idempotent: No-op, wenn nichts zu entfernen ist.
timeout --signal=TERM --kill-after=5s 60s bash scripts/prune-stale-subrepl-remotes.sh --apply || \
  echo "[post-merge] Remote-Prune übersprungen/fehlgeschlagen — nächster Merge holt es nach"

# Task #1249: GitHub-Sync nach jedem Merge (best-effort). Hält GitHub `main`
# auf dem Replit-Stand, damit CI nicht alten Code testet. Ein Sync-Fehler darf
# den Merge NIE blockieren — deshalb `|| true` und ein Timeout. Idempotent:
# No-op, wenn GitHub bereits in sync ist. Die geplante stündliche Kadenz
# (Scheduled Deployment) fängt zusätzlich aus, was hier ausfällt.
timeout --signal=TERM --kill-after=5s 60s bash scripts/github-sync.sh push || \
  echo "[post-merge] github-sync übersprungen/fehlgeschlagen — Kadenz/nächster Merge holt es nach"

# Task #1904: aufgeblähtes .git entschlacken. Eine verwaiste
# `.git/objects/maintenance.lock` legt Gits Hintergrundwartung still — lose
# Objekte werden dann nie gepackt (Stand #1904: 494 MB .git, 39.705 lose
# Objekte, 1.054 subrepl-*-Branches). Best-effort NACH dem Sync, damit ein
# langer Packlauf den Push nicht verzögert; darf den Merge NIE blockieren.
# Idempotent + selbst-gegatet: unterhalb der Bloat-Schwelle ein schneller No-Op.
# Bewusst OHNE --expire-graveyard: hier wird nur gelöscht, was nachweislich in
# einem erhaltenen Ref liegt; alles Ungeprüfte wandert nach
# refs/subrepl-graveyard/* und bleibt wiederherstellbar. Der einzige
# unumkehrbare Schritt bleibt eine bewusste manuelle Handlung.
timeout --signal=TERM --kill-after=10s 300s bash scripts/prune-git-object-bloat.sh --apply || \
  echo "[post-merge] git-Entschlackung übersprungen/fehlgeschlagen — nächster Merge holt es nach"
