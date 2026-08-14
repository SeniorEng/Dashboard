#!/usr/bin/env bash
#
# prune-stale-subrepl-remotes.sh — Karteileichen-Remotes aus .git/config entfernen (Task #1900)
#
# Problem: Jeder Task-Agent-Lauf in einem Subrepl hinterlässt im Haupt-Repl ein
# Remote `subrepl-<id>` mit SSH-URL auf `ssh.worf.replit.dev`. Diese Subrepls
# existieren nach dem Merge nicht mehr; die Remotes bleiben aber stehen und
# summieren sich (Stand Task #1900: 1052 Stück, .git/config ~215 KB). Die
# Git-Oberfläche im Workspace läuft beim Auflisten/Prüfen der Remotes in die
# tote SSH-URL (`Host key verification failed` / kein `ssh-askpass`) und meldet
# pauschal „Failed to authenticate with the remote" (UNAUTHENTICATED) — obwohl
# die GitHub-Verbindung selbst gesund ist.
#
# Dieses Skript entfernt AUSSCHLIESSLICH Remotes, die BEIDE Kriterien erfüllen:
#   1. Name beginnt mit `subrepl-`
#   2. URL zeigt auf den Subrepl-SSH-Host (ssh.worf.replit.dev)
# Alles andere (origin/GitHub, gitsafe-backup, main-repl) bleibt unangetastet;
# `main-repl` ist die Verbindung, über die ein Task-Environment mit dem
# Haupt-Repl abgleicht, und darf NICHT entfernt werden.
#
# Idempotent: ohne Karteileichen ein No-Op mit Exit 0.
#
# Nutzung:
#   bash scripts/prune-stale-subrepl-remotes.sh            # Trockenlauf (Default)
#   bash scripts/prune-stale-subrepl-remotes.sh --apply    # tatsächlich entfernen
#
# Läuft zusätzlich best-effort in scripts/post-merge.sh, damit sich der Bestand
# im Haupt-Repl nicht erneut über Jahre aufstaut.

set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

SUBREPL_HOST="ssh.worf.replit.dev"

log() { printf '[prune-remotes] %s\n' "$*" >&2; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "Kein Git-Repository — nichts zu tun."
  exit 0
fi

mapfile -t candidates < <(git remote | grep '^subrepl-' || true)

if [ "${#candidates[@]}" -eq 0 ]; then
  log "Keine subrepl-* Remotes vorhanden — nichts zu tun."
  exit 0
fi

log "${#candidates[@]} subrepl-* Remote(s) gefunden."

if [ "$APPLY" -eq 0 ]; then
  log "TROCKENLAUF (kein --apply): es wird nichts entfernt."
  log "Beispiele: ${candidates[0]}${candidates[1]:+, ${candidates[1]}}${candidates[2]:+, ${candidates[2]}} …"
  log "Zum Entfernen: bash scripts/prune-stale-subrepl-remotes.sh --apply"
  exit 0
fi

# Vor der ersten Änderung eine Kopie der Konfiguration sichern (einmal pro Lauf).
git_dir="$(git rev-parse --git-dir)"
backup_dir=".local/git-backups"
mkdir -p "$backup_dir"
backup_file="${backup_dir}/config.backup-$(date +%Y%m%d-%H%M%S)"
cp "${git_dir}/config" "$backup_file"
log "Backup der Git-Konfiguration: ${backup_file}"

removed=0
skipped=0
for remote in "${candidates[@]}"; do
  url="$(git remote get-url "$remote" 2>/dev/null || true)"
  case "$url" in
    *"$SUBREPL_HOST"*)
      git remote remove "$remote" 2>/dev/null && removed=$((removed + 1)) || skipped=$((skipped + 1))
      ;;
    *)
      log "ÜBERSPRUNGEN: ${remote} zeigt nicht auf ${SUBREPL_HOST} — bleibt bestehen."
      skipped=$((skipped + 1))
      ;;
  esac
done

log "Entfernt: ${removed}, übersprungen: ${skipped}."
log "Verbleibende Remotes: $(git remote | tr '\n' ' ')"
