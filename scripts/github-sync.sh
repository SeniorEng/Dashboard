#!/usr/bin/env bash
#
# github-sync.sh — Automatischer GitHub-Sync (Task #1152)
#
# Hält den Branch `main` auf `SeniorEng/Dashboard` auf dem Stand des
# Replit-Projekts, damit CI nie alten Code testet. Ersetzt den manuellen,
# leicht zu vergessenden `git push` (siehe docs/ci-pipeline.md → GitHub-Sync).
#
# Subcommands:
#   push   (default)  Pusht `main` nach GitHub, falls der lokale Stand vom
#                     Remote abweicht. No-op, wenn bereits in sync.
#   check             Drift-Signal: vergleicht lokale vs. remote main-SHA und
#                     prüft den OpenAPI-Spec-Drift. Exit != 0 bei Drift.
#                     Verändert nichts (read-only).
#
#   doctor            Schnelle Auth-Diagnose (read-only, ohne OpenAPI-Lauf):
#                     Zustand des Replit-Token-Brokers, Gesundheit jedes
#                     konfigurierten Tokens (200/401) und SHA-Vergleich.
#                     Der Ein-Befehl-Check, wenn die Git-Pane tot wirkt.
#
# Authentifizierung (in dieser Reihenfolge probiert):
#   1. GITHUB_PERSONAL_ACCESS_TOKEN  — Standard-Connector-Token (Code/Doku).
#   2. GITHUB_WORKFLOW_PAT           — Classic-PAT mit `repo`+`workflow`-Scope.
#                                      Nötig, sobald `.github/workflows/*`
#                                      mitgepusht wird (Connector-Token hat
#                                      kein `workflow`-Scope → GH013).
# Vor jedem Push-Versuch wird der Token per GitHub-API vorgeprüft: Wer dort mit
# 401/403 abgewiesen wird, ist tot und wird ÜBERSPRUNGEN, statt einen kompletten
# Push-Versuch (inkl. Objekt-Upload) daran zu verschwenden (Task #1903). Der
# Push fällt bei einem Workflow-Scope-Fehler weiterhin automatisch auf den PAT
# zurück; in einem Scheduled Deployment (wo der Connector-Token evtl. fehlt)
# greift direkt der PAT. Die Ausgabe benennt immer, WELCHER Token gegriffen hat.
#
# Dieses Skript ist zugleich der Ersatzweg, wenn Replits Credential-Helper
# (Token-Broker hinter GIT_ASKPASS) ausfällt und die Git-Pane im Workspace
# dadurch wirkungslos wird — es umgeht den Broker komplett und authentifiziert
# direkt über die Secrets. Siehe docs/ci-pipeline.md → "Token-Broker-Ausfall".
#
# Cadence: als Replit Scheduled Deployment einrichten (Run-Command
#   `bash scripts/github-sync.sh push`, z.B. stündlich). Details:
#   docs/ci-pipeline.md → "Automatisierter Sync".

set -euo pipefail

REPO="SeniorEng/Dashboard"
BRANCH="main"
API_REF="https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}"

log() { printf '[github-sync] %s\n' "$*" >&2; }

# --- Token-Registry -----------------------------------------------------------
# Reihenfolge = Vorrang. Es werden immer nur die LABEL (Variablennamen) geloggt,
# niemals der Token-Wert selbst.
TOKEN_LABELS="GITHUB_PERSONAL_ACCESS_TOKEN GITHUB_WORKFLOW_PAT"

token_value() {
  case "$1" in
    GITHUB_PERSONAL_ACCESS_TOKEN) printf '%s' "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ;;
    GITHUB_WORKFLOW_PAT)          printf '%s' "${GITHUB_WORKFLOW_PAT:-}" ;;
    *)                            printf '%s' "" ;;
  esac
}

# Merkliste der in DIESEM Lauf als tot (401/403) erkannten Token. Verhindert,
# dass ein nachweislich totes Token später erneut probiert wird (Task #1903).
DEAD_TOKEN_LABELS=""

token_is_known_dead() {
  case " ${DEAD_TOKEN_LABELS} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

mark_token_dead() {
  token_is_known_dead "$1" || DEAD_TOKEN_LABELS="${DEAD_TOKEN_LABELS} $1"
}

# Lokale main-SHA — bevorzugt git, Fallback auf das Ref-File (kein git nötig).
local_sha() {
  git rev-parse HEAD 2>/dev/null || cat ".git/refs/heads/${BRANCH}" 2>/dev/null || true
}

# Remote-SHA-Lesung mit EINEM konkreten Token. Exit-Codes:
#   0  Erfolg (gibt die 40-stellige Remote-SHA auf stdout aus)
#   2  kein Token übergeben
#   3  Authentifizierung fehlgeschlagen (401/403 — Token abgelaufen/ungültig)
#   1  sonstiger Fehler (Netzwerk/Transport oder unerwarteter HTTP-Status)
remote_sha_with_token() {
  local token="$1"
  [ -z "$token" ] && return 2
  local response http_code body
  if ! response="$(curl -sS -w $'\n%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.github+json" \
      "${API_REF}" 2>/dev/null)"; then
    return 1
  fi
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
    200)
      printf '%s\n' "$body" | grep -oE '[0-9a-f]{40}' | head -1
      return 0
      ;;
    401|403) return 3 ;;
    *)       return 1 ;;
  esac
}

# Remote main-SHA via GitHub-API (read-only). Probiert die verfügbaren Token und
# nutzt denjenigen, der tatsächlich 200 liefert — so maskiert ein abgelaufener
# Connector-Token kein erfolgreiches Lesen über einen anderen Token mehr.
# Optionaler $1: bevorzugter Token (z.B. der, der den Push authentifiziert hat),
# wird zuerst probiert.
remote_sha() {
  local preferred="${1:-}"
  local label token rc auth_failed=0 sha tried=""
  for label in $preferred $TOKEN_LABELS; do
    case " ${tried} " in *" $label "*) continue ;; esac
    tried="${tried} ${label}"
    token_is_known_dead "$label" && continue
    token="$(token_value "$label")"
    [ -z "$token" ] && continue
    if sha="$(remote_sha_with_token "$token")"; then
      printf '%s\n' "$sha"
      return 0
    else
      rc=$?
      if [ "$rc" = "3" ]; then
        auth_failed=1
        mark_token_dead "$label"
      fi
    fi
  done
  if [ "$auth_failed" = "1" ]; then
    log "Remote-SHA-Lesung scheiterte an Authentifizierung (401/403) — Token abgelaufen/ungültig? GITHUB_WORKFLOW_PAT erneuern."
  else
    log "Remote-SHA konnte mit keinem verfügbaren Token gelesen werden (kein Token gesetzt oder Netzwerkfehler)."
  fi
  return 1
}

# Vorabprüfung EINES Tokens gegen die GitHub-API (read-only, ein Request).
# Ergebnis wird in DEAD_TOKEN_LABELS gemerkt. Exit-Codes wie remote_sha_with_token:
#   0 gültig (200) | 2 nicht gesetzt | 3 tot (401/403) | 1 unklar (Netzwerk/Transport)
probe_token() {
  local label="$1" token
  token="$(token_value "$label")"
  [ -z "$token" ] && return 2
  token_is_known_dead "$label" && return 3
  local rc=0
  remote_sha_with_token "$token" >/dev/null || rc=$?
  [ "$rc" = "3" ] && mark_token_dead "$label"
  return "$rc"
}

# --- Token-Broker-Vorabprüfung (Task #1903) -----------------------------------
# Replits Credential-Helper hinter GIT_ASKPASS besorgt der Git-Pane im Workspace
# ihr GitHub-Token. Fällt der Broker aus, hängt JEDE Anfrage ~30 s und liefert
# statt eines Tokens nichts bzw. den Text "GitHub token request timed out". Git
# schickt das als Passwort, GitHub antwortet "Invalid username or token" — die
# Pane (Sync/Pull/Push) piept dann nur und ändert nichts, obwohl die Verbindung
# "verbunden" aussieht. Dieses Skript ist der Ersatzweg: es umgeht den Broker.
# Rein informativ: kurzes Timeout, kein Einfluss auf den Exit-Code, blockiert den
# Sync NIE. Der Token-Wert wird nie ausgegeben — nur klassifiziert.
CREDENTIAL_BROKER_PROBE_TIMEOUT="${CREDENTIAL_BROKER_PROBE_TIMEOUT:-5}"

credential_broker_check() {
  [ "${SKIP_CREDENTIAL_BROKER_CHECK:-0}" = "1" ] && return 0
  local helper="${GIT_ASKPASS:-}"
  [ -z "$helper" ] && return 0
  command -v "$helper" >/dev/null 2>&1 || return 0
  command -v timeout  >/dev/null 2>&1 || return 0

  local out="" rc=0
  out="$(timeout "$CREDENTIAL_BROKER_PROBE_TIMEOUT" "$helper" \
    "Password for 'https://x-access-token@github.com': " 2>/dev/null)" || rc=$?

  if [ "$rc" != "0" ] || [ -z "$out" ] || printf '%s' "$out" | grep -qi 'timed out'; then
    log "TOKEN-BROKER AUSGEFALLEN: '${helper}' liefert kein Token (Timeout/leere Antwort nach ${CREDENTIAL_BROKER_PROBE_TIMEOUT}s)."
    log "→ Folge: Die Git-Pane im Workspace (Sync/Pull/Push) ist wirkungslos — sie hängt ~30s und meldet"
    log "→ 'Invalid username or token', obwohl die GitHub-Verbindung gesund aussieht. Lesen klappt trotzdem,"
    log "→ weil ${REPO} öffentlich ist (anonymer Fetch) — die Zähler der Pane sind dann veraltet."
    log "→ Dieser Befehl ist der Ersatzweg: er umgeht den Broker und authentifiziert direkt über die Secrets."
    log "→ Reparatur des Brokers ist Replit-seitig. Runbook: docs/ci-pipeline.md → 'Token-Broker-Ausfall'."
  fi
  return 0
}

# OpenAPI-Spec-Drift (committete Spec vs. frisch aus den Zod-Schemas generiert).
spec_drift_check() {
  if npm run --silent gen:openapi -- --check; then
    return 0
  fi
  return 1
}

cmd_check() {
  local lsha rsha rc=0
  lsha="$(local_sha)"
  rsha="$(remote_sha || true)"

  log "Lokale  main-SHA: ${lsha:-unbekannt}"
  log "Remote  main-SHA: ${rsha:-unbekannt}"

  if [ -z "$rsha" ]; then
    log "DRIFT-SIGNAL: Remote-SHA konnte nicht ermittelt werden."
    rc=1
  elif [ "$lsha" = "$rsha" ]; then
    log "OK: GitHub ist auf dem lokalen Stand (kein SHA-Drift)."
  else
    log "DRIFT-SIGNAL: GitHub main ist NICHT auf dem lokalen Stand — Sync nötig (push)."
    rc=1
  fi

  if spec_drift_check; then
    log "OK: OpenAPI-Spec ist aktuell."
  else
    log "DRIFT-SIGNAL: OpenAPI-Spec driftet — 'npm run gen:openapi' laufen lassen und committen."
    rc=1
  fi

  return "$rc"
}

# Push über einen gegebenen Token; gibt die git-Ausgabe (inkl. Fehler) zurück.
do_push() {
  local token="$1"
  git push "https://x-access-token:${token}@github.com/${REPO}.git" "HEAD:${BRANCH}" 2>&1
}

# Erkennt an der git-Ausgabe, ob ein Push-Fehler ein Auth-/Token-Problem ist
# (abgelaufener/ungültiger Token) und nicht ein bloßer Netzwerkfehler.
looks_like_auth_failure() {
  printf '%s' "$1" | grep -qiE 'Authentication failed|Invalid username or password|Bad credentials|could not read Username|remote: (Invalid|Permission)|HTTP (401|403)|403 Forbidden|401 Unauthorized'
}

# Erkennt an der git-Ausgabe, ob der Push wegen DIVERGIERTER Historie abgelehnt
# wurde (non-fast-forward). Das ist KEIN Token-/Netzwerkfehler, sondern verlangt
# einen einmaligen, kontrollierten Force-Push-Reconcile über das Runbook
# (docs/ci-pipeline.md → Force-Push/Branch-Protection). Ohne diese Erkennung
# maskierte der generische "kein Token akzeptierte den Push"-Zweig die wahre
# Ursache und der Sync blieb still stehen (Backlog wuchs unbemerkt).
looks_like_non_fast_forward() {
  printf '%s' "$1" | grep -qiE 'non-fast-forward|failed to push some refs|Updates were rejected|fetch first|tip of your current branch is behind'
}

cmd_push() {
  local lsha rsha
  lsha="$(local_sha)"

  # Informativ, blockiert nie: sagt dem Nutzer, warum die Git-Pane tot wirkt.
  credential_broker_check

  rsha="$(remote_sha || true)"

  if [ -n "$rsha" ] && [ "$lsha" = "$rsha" ]; then
    log "Bereits in sync (${lsha}) — nichts zu pushen."
    return 0
  fi

  log "Drift erkannt: lokal=${lsha:-?} remote=${rsha:-unbekannt}. Pushe ${BRANCH} → ${REPO}…"

  local out="" label token rc
  local auth_seen=0
  local nonff_seen=0
  local pushed_attempted=0

  # Token in Vorrangreihenfolge durchgehen. Ein Token, das die GitHub-API mit
  # 401/403 abweist, kann auch keinen Push authentifizieren — es wird sofort als
  # tot benannt und ÜBERSPRUNGEN, statt einen kompletten Push-Versuch daran zu
  # verschwenden (Task #1903). Die Fallback-Kette (Connector → PAT, u.a. für
  # GH013/Workflow-Scope) bleibt dadurch unverändert erhalten.
  for label in $TOKEN_LABELS; do
    token="$(token_value "$label")"
    if [ -z "$token" ]; then
      log "${label}: nicht gesetzt — übersprungen."
      continue
    fi

    rc=0
    probe_token "$label" || rc=$?
    case "$rc" in
      3)
        log "${label}: TOT (GitHub-API antwortet 401/403) — übersprungen, kein Push-Versuch."
        auth_seen=1
        continue
        ;;
      0)
        log "${label}: gültig (GitHub-API 200) — Push wird mit diesem Token versucht."
        ;;
      *)
        log "${label}: Vorabprüfung nicht eindeutig (Netzwerk/Transport) — Push wird trotzdem versucht."
        ;;
    esac

    pushed_attempted=1
    if out="$(do_push "$token")"; then
      log "Push erfolgreich — verwendetes Token: ${label}."
      verify_pushed "$lsha" "$label"
      return 0
    fi
    log "Push mit ${label} fehlgeschlagen:"
    printf '%s\n' "$out" >&2
    looks_like_auth_failure "$out" && auth_seen=1
    looks_like_non_fast_forward "$out" && nonff_seen=1
    if printf '%s' "$out" | grep -qiE 'GH013|workflow|refusing to allow'; then
      log "Workflow-Scope-Problem (.github/workflows/*) erkannt — nächstes Token (GITHUB_WORKFLOW_PAT) übernimmt."
    fi
  done

  log "FEHLER: GitHub-Sync-Push fehlgeschlagen — GitHub main bleibt zurück (Backlog wächst)."
  if [ "$nonff_seen" = "1" ]; then
    log "→ Ursache: DIVERGIERTE Historie (non-fast-forward) — GitHub main hat Commits, die Replit nicht hat, oder die Historien sind auseinandergelaufen."
    log "→ Ein normaler Sync-Push kann das NICHT reparieren. Einmaliger kontrollierter Force-Push-Reconcile nötig:"
    log "→   docs/ci-pipeline.md → 'Force-Push / Branch-Protection' (allow_force_pushes temporär an, --force-with-lease, sofort wieder aus)."
    log "→ Bis dahin testet die GitHub-CI veralteten Code — dieser Fehlschlag ist der beabsichtigte Alarm, kein stiller Stillstand."
  elif [ "$pushed_attempted" = "0" ] && [ "$auth_seen" = "1" ]; then
    log "→ Ursache: KEIN verwendbares Token — alle konfigurierten Token werden von GitHub mit 401/403 abgewiesen (tot/abgelaufen)."
    log "→ GITHUB_WORKFLOW_PAT (Scope repo+workflow) erneuern; ein totes GITHUB_PERSONAL_ACCESS_TOKEN erneuern oder löschen."
    log "→ Diagnose in einem Befehl: npm run sync:doctor"
  elif [ "$auth_seen" = "1" ]; then
    log "→ Ursache: Token ungültig/abgelaufen. GITHUB_WORKFLOW_PAT (Scope repo+workflow) in den Deployment-Secrets erneuern."
  else
    log "→ Push wurde von keinem Token akzeptiert (siehe Ausgabe oben). Token/Secrets und Netzwerk prüfen."
  fi
  return 1
}

# Read-only Auth-Diagnose in einem Befehl: Broker-Zustand + Token-Gesundheit +
# SHA-Vergleich, ohne den (langsamen) OpenAPI-Lauf von `check`. Exit 0, solange
# mindestens ein Token gültig ist und die Remote-SHA gelesen werden konnte.
cmd_doctor() {
  local label rc live=0 lsha rsha ret=0

  credential_broker_check

  for label in $TOKEN_LABELS; do
    rc=0
    probe_token "$label" || rc=$?
    case "$rc" in
      0) log "${label}: OK (GitHub-API 200) — verwendbar." ; live=$((live + 1)) ;;
      2) log "${label}: nicht gesetzt." ;;
      3) log "${label}: TOT — GitHub antwortet 401/403 (abgelaufen/widerrufen). Erneuern oder löschen." ;;
      *) log "${label}: unklar — kein 200, aber auch kein 401/403 (Netzwerk/Transport?)." ;;
    esac
  done

  if [ "$live" = "0" ]; then
    log "FEHLER: Kein gültiges GitHub-Token verfügbar — Push nicht möglich."
    ret=1
  fi

  lsha="$(local_sha)"
  rsha="$(remote_sha || true)"
  log "Lokale  main-SHA: ${lsha:-unbekannt}"
  log "Remote  main-SHA: ${rsha:-unbekannt}"
  if [ -n "$rsha" ] && [ "$lsha" = "$rsha" ]; then
    log "OK: GitHub main ist auf dem lokalen Stand (in sync)."
  elif [ -n "$rsha" ]; then
    log "DRIFT: GitHub main hinkt hinterher — Push nötig: npm run sync:github"
    ret=1
  else
    log "DRIFT-SIGNAL: Remote-SHA konnte nicht ermittelt werden."
    ret=1
  fi

  return "$ret"
}

# Nach dem Push verifizieren, dass die Remote-SHA der gepushten entspricht.
# $2 (optional): das LABEL des Tokens, der den Push authentifiziert hat — wird
# zum Gegenlesen bevorzugt, damit ein abgelaufener Connector-Token keine falsche
# WARNUNG nach einem in Wahrheit erfolgreichen Push erzeugt.
verify_pushed() {
  local expected="$1" worked_label="${2:-}" got
  got="$(remote_sha "$worked_label" || true)"
  if [ -n "$got" ] && [ "$got" = "$expected" ]; then
    log "Verifiziert: GitHub main steht jetzt auf ${got}."
    return 0
  fi
  if [ -z "$got" ]; then
    log "HINWEIS: Push war erfolgreich, aber die Remote-SHA konnte nicht gegengelesen werden (Leserecht/Netzwerk). Der Push gilt trotzdem als erfolgreich."
  else
    log "WARNUNG: Remote-SHA nach Push (${got}) != erwartete (${expected})."
  fi
}

main() {
  local cmd="${1:-push}"
  case "$cmd" in
    push)   cmd_push ;;
    check)  cmd_check ;;
    doctor) cmd_doctor ;;
    *)
      log "Unbekanntes Subcommand: ${cmd}. Erlaubt: push | check | doctor."
      return 2
      ;;
  esac
}

main "$@"
