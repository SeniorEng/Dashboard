#!/usr/bin/env bash
# PreToolUse-Gate fuer das Bash-Tool (matcher: "Bash").
#
# Duenner, FAIL-CLOSED Wrapper um `bash-gate.py`. Die Entscheidungslogik steht
# dort; hier steht nur die Garantie, dass NIE versehentlich `allow` herauskommt:
# Fehlt Python, stirbt das Skript, oder ist die Ausgabe leer/kein `allow`, dann
# antwortet dieser Wrapper mit `deny`.
#
# Ausgabeformat exakt wie in der installierten 2.1.220 gemessen:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#     "permissionDecision":"allow|deny","permissionDecisionReason":"..."}}
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

IN="$(cat 2>/dev/null)" || deny "Hook konnte stdin nicht lesen — fail-closed."
[ -n "$IN" ] || deny "Leere Hook-Eingabe — fail-closed."

command -v python3 >/dev/null 2>&1 || deny "python3 nicht gefunden — Gate kann nicht urteilen, fail-closed."
[ -r "$HERE/bash-gate.py" ] || deny "bash-gate.py fehlt oder ist nicht lesbar — fail-closed."

OUT="$(printf '%s' "$IN" | python3 "$HERE/bash-gate.py" 2>/dev/null)"
RC=$?

[ $RC -eq 0 ] || deny "Gate-Logik endete mit Exit $RC — fail-closed."
[ -n "$OUT" ] || deny "Gate-Logik lieferte keine Ausgabe — fail-closed."
# Toleriert Leerzeichen nach dem Doppelpunkt, damit ein geaendertes
# Serialisierungs-Detail nicht still alles auf deny kippt.
if printf '%s' "$OUT" | grep -qE '"permissionDecision"[[:space:]]*:[[:space:]]*"(allow|deny)"'; then
  printf '%s\n' "$OUT"
else
  deny "Gate-Logik lieferte keine verwertbare Entscheidung — fail-closed."
fi
