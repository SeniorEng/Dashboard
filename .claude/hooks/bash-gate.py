#!/usr/bin/env python3
"""Entscheidungslogik des PreToolUse-Gates fuer das Bash-Tool.

ERSETZT das `permissions.ask`-Array in `.claude/settings.local.json`. Vorher
prompteten 26 Muster; ein Hook kann eine `ask`-Regel NICHT aufheben (gemessen:
Regel-`ask` schlaegt Hook-`allow`), deshalb ist die Liste dort leer und die
gefaehrlichen Faelle stehen ausschliesslich hier.

Gemessene Praezedenz, auf der dieser Aufbau steht:
    Hook-`deny` > Regel-`deny` > Regel-`ask` > Hook-`allow` > Regel-`allow`
Das `deny`-Array in den Settings bleibt als zweite Lage: es schlaegt ein
Hook-`allow` und faengt damit auch einen Fehler in DIESER Datei ab.

Vertrag: JSON auf stdin, JSON auf stdout mit
`hookSpecificOutput.permissionDecision` = "allow" | "deny".
FAIL-CLOSED: alles, was nicht sicher als harmlos erkannt wird, ist `deny`.
"""

import json
import os
import re
import shlex
import sys

# Wohin geschrieben/geloescht werden darf, ohne dass es das System trifft.
SAFE_PREFIXES = (
    "/home/dev/dashboard/",
    "/tmp/",
    "/var/tmp/",
    "/home/dev/.claude/",
    "/home/dev/.local/share/claude/",
)

# Pfade, deren Beschreiben das System bzw. den Prod-Betrieb trifft.
SYSTEM_PREFIXES = (
    "/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/lib64", "/opt",
    "/root", "/proc", "/sys", "/dev", "/var/lib", "/var/log", "/data",
    "/srv", "/mnt",
)

SEPARATORS = re.compile(r"\|\||&&|;|\||\n|\$\(|`|\(|\)")

# --- Selbstschutz -----------------------------------------------------------
# Das Gate ist im unbeaufsichtigten Betrieb die EINZIGE Schranke. Es darf sich
# deshalb nicht selbst entschaerfen koennen: weder die Hook-Skripte noch die
# Settings, in denen es registriert ist, duerfen ueber Bash veraendert werden.
# Die Edit/Write-Seite deckt `permissions.deny` in settings.local.json ab.
PROTECTED_RE = re.compile(r"\.claude/hooks|settings\.local\.json")

# Kommandos, die diese Pfade nur LESEN. Bewusst knapp gehalten: `awk` kann
# ueber `print > datei` schreiben, `git` koennte per `checkout` zuruecksetzen —
# beide sind deshalb NICHT hier drin.
READONLY_CMDS = frozenset({
    "cat", "head", "tail", "less", "more", "grep", "rg", "ls", "stat", "wc",
    "diff", "cmp", "md5sum", "sha256sum", "file", "realpath", "dirname",
    "basename", "sort", "uniq", "cut", "jq",
})


def emit(decision, reason):
    # Kompakte Separatoren: der Wrapper prueft die Entscheidung als Substring,
    # `json.dumps`-Default wuerde `"permissionDecision": "allow"` mit Leerzeichen
    # schreiben und dort vorbeilaufen.
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }, separators=(",", ":")))
    sys.exit(0)


def is_safe_path(p):
    """Absolute Pfade nur unter den Wegwerf-/Projekt-Wurzeln gelten als sicher.
    Relative Pfade sind sicher, weil das cwd das Projekt ist."""
    if not p.startswith("/") and not p.startswith("~"):
        return True
    if p.startswith("~"):
        return False
    p = os.path.normpath(p)
    return any(p.startswith(pref) or p + "/" == pref for pref in SAFE_PREFIXES)


OPERATORS = (";", "&&", "||", "|", "&", "\n")


def segments(cmd):
    """Kommando in Teilkommandos zerlegen — `echo x && sudo y` muss BEIDE
    Haelften sichtbar machen, sonst greift das Gate nur auf das erste Token.

    Zerlegt wird ueber den Shell-Lexer, NICHT ueber einen Regex-Split. Ein
    Regex-Split auf `(`/`)` zerreisst Klammern INNERHALB von Quotes und laesst
    danach unbalancierte Fragmente zurueck — `python3 -c "open(...)"` und
    `awk '{print $1}'` liefen dadurch in ein fail-closed-deny. Der Lexer haelt
    Quotes zusammen und gibt Operatoren als eigene Tokens zurueck.

    Rueckgabe: Liste von Token-Listen, ENV-Zuweisungen vorne abgestreift.
    """
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        toks = list(lex)
    except ValueError:
        # Unbalancierte Quotes: nicht interpretierbar -> fail-closed.
        emit("deny", "Kommando nicht parsebar (unbalancierte Quotes) — fail-closed.")

    segs, cur = [], []
    for t in toks:
        if t in OPERATORS:
            if cur:
                segs.append(cur)
            cur = []
        elif t in ("(", ")"):
            continue
        else:
            cur.append(t)
    if cur:
        segs.append(cur)

    out = []
    for s in segs:
        while s and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", s[0]):
            s = s[1:]
        if s:
            out.append(s)
    return out


def check(cmd):
    # --- Roh-Treffer auf der ganzen Zeile (auch in Quotes, z.B. bash -c "...").
    # Die Zeichenklasse enthaelt bewusst Quotes und Backtick: `bash -c 'sudo x'`
    # hat vor dem Schluesselwort ein Quote, kein Leerzeichen — ohne das lief
    # genau dieser Bypass durch (im Unit-Test aufgefallen).
    if re.search(r"""(?:^|[\s;&|("'`])sudo(?:\s|$)""", cmd):
        return "deny", "`sudo` ist gesperrt — Host-Administration laeuft ueber Alrik, nicht ueber den Executor."
    if re.search(r"""(?:^|[\s;&|("'`])docker(?:-compose)?(?:\s|$)""", cmd):
        return "deny", "`docker` ist gesperrt — der Test-Stack laeuft persistent, der Routine-Loop startet ihn nicht."
    if re.search(r"\b(?:curl|wget)\b[^|]*\|[^|]*\b(?:ba)?sh\b", cmd):
        return "deny", "Download nach Shell-Pipe (`curl|bash`) — nicht auditierbar, gesperrt."

    for toks in segments(cmd):
        base = os.path.basename(toks[0])
        rest = toks[1:]

        # Selbstschutz: sobald ein Token auf Hook-Skripte oder die Settings
        # zeigt, ist nur eine kleine Menge reiner Lese-Kommandos zugelassen.
        # Der Treffer per Substring erfasst auch Pfade INNERHALB von Quotes,
        # also z.B. `python3 -c "open('.claude/hooks/bash-gate.py','w')"`.
        if any(PROTECTED_RE.search(t) for t in toks):
            if base not in READONLY_CMDS:
                return "deny", (
                    "Zugriff auf das Gate selbst (`.claude/hooks/**` bzw. "
                    "`settings.local.json`) ist nur lesend erlaubt — das Gate darf "
                    "sich nicht selbst entschaerfen. Aenderungen macht Alrik."
                )

        # `bash -c "<kommando>"` versteckt das eigentliche Kommando in einem
        # String-Argument. Die Nutzlast deshalb rekursiv durch dasselbe Gate
        # schicken, sonst faengt nur der Roh-Regex oben (sudo/docker) etwas.
        if base in ("bash", "sh", "zsh") and "-c" in rest:
            i = rest.index("-c")
            if i + 1 < len(rest):
                sub_decision, sub_reason = check(rest[i + 1])
                if sub_decision == "deny":
                    return "deny", f"in `{base} -c`: {sub_reason}"

        if base == "git":
            sub = next((t for t in rest if not t.startswith("-")), "")
            if sub == "push":
                if any(t in ("--force", "-f", "--force-with-lease") or
                       t.startswith("--force-with-lease=") for t in rest):
                    return "deny", "`git push --force` — ueberschreibt fremde Historie, gesperrt."
                for t in rest:
                    ref = t.split(":")[-1]
                    if ref in ("main", "master") or ref.endswith("/main") or ref.endswith("/master"):
                        return "deny", "Direkter Push nach `main`/`master` — Aenderungen laufen ueber PR + Merge durch Alrik (Gate 3)."
            if sub == "reset" and "--hard" in rest:
                return "deny", "`git reset --hard` — verwirft nicht committete Arbeit unwiederbringlich."
            if sub == "clean" and any(re.match(r"^-[a-zA-Z]*f", t) for t in rest):
                return "deny", "`git clean -f` — loescht ungetrackte Dateien unwiederbringlich."

        if base == "gh":
            nonflag = [t for t in rest if not t.startswith("-")]
            if nonflag[:2] == ["pr", "merge"]:
                return "deny", "`gh pr merge` — der Merge nach `main` ist Gate 3 und gehoert Alrik."

        if base == "rm":
            flags = "".join(t for t in rest if t.startswith("-") and not t.startswith("--"))
            recursive = "r" in flags or "R" in flags or "--recursive" in rest
            force = "f" in flags or "--force" in rest
            args = [t for t in rest if not t.startswith("-")]
            if recursive or force:
                for a in args:
                    if a in ("/", "~") or a.startswith("~") or not is_safe_path(a):
                        return "deny", f"`rm -rf` auf `{a}` — ausserhalb von Projekt/Wegwerf-Pfaden; mehrdeutig, deshalb gesperrt."
                    if "*" in a and a.startswith("/"):
                        return "deny", f"`rm -rf` mit Glob auf absolutem Pfad (`{a}`) — Treffermenge nicht vorhersehbar."

        if base in ("chmod", "chown"):
            for a in [t for t in rest if not t.startswith("-")]:
                if a.startswith("/") or a.startswith("~"):
                    if not is_safe_path(a):
                        return "deny", f"`{base}` auf Systempfad `{a}` — gesperrt."

        # Redirects in Systempfade: > /etc/... bzw. >> /usr/...
        # Der Lexer gibt `>`/`>>` als eigene Tokens zurueck; das Ziel ist das
        # jeweils naechste Token.
        for i, t in enumerate(toks):
            if t in (">", ">>") and i + 1 < len(toks):
                target = toks[i + 1]
                if target == "/dev/null":
                    continue
                if target.startswith("/") and not is_safe_path(target):
                    return "deny", f"Schreib-Redirect nach `{target}` — Systempfad, gesperrt."
        if base == "tee":
            for a in [t for t in rest if not t.startswith("-")]:
                if a.startswith("/") and not is_safe_path(a):
                    return "deny", f"`tee` nach `{a}` — Systempfad, gesperrt."

    return "allow", "Kein Treffer in der gesperrten Handvoll."


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception:
        emit("deny", "Hook-Eingabe ist kein gueltiges JSON — fail-closed.")
    if not isinstance(payload, dict):
        emit("deny", "Hook-Eingabe ist kein JSON-Objekt — fail-closed.")
    if payload.get("tool_name") != "Bash":
        emit("deny", "Gate erwartet das Bash-Tool — fail-closed.")
    cmd = (payload.get("tool_input") or {}).get("command")
    if not isinstance(cmd, str) or not cmd.strip():
        emit("deny", "Kein lesbares `command` in der Hook-Eingabe — fail-closed.")
    decision, reason = check(cmd)
    emit(decision, reason)


if __name__ == "__main__":
    main()
