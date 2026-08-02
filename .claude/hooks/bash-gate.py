#!/usr/bin/env python3
"""Entscheidungslogik des PreToolUse-Gates fuer das Bash-Tool.

STOLPERDRAHT GEGEN VERSEHEN — KEIN SANDBOX-ERSATZ.
Dieses Gate faengt das versehentlich getippte `sudo …`, `docker …`,
`git push origin main` oder `rm -rf /…`. Es ist ein Kommando-FILTER und als
solcher grundsaetzlich umgehbar: Praefixe (`env`, `command`, `nohup`, `{ …; }`),
Variablen-Expansion (`X=sudo; $X …`), `xargs`/`find -exec`, `eval`, oder ein
umbenanntes Verzeichnis (`mv .claude .claude-off`) laufen daran vorbei. Das ist
BEWUSST nicht geschlossen — ein Filter, der all das faengt, blockiert normale
Arbeit, und vollstaendig wird er trotzdem nie.
**Unbeaufsichtigter Betrieb mit fremdem Input braucht eine Sandbox, nicht
diesen Filter.**

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
FAIL-CLOSED: was nicht sicher interpretierbar ist, ist `deny`.
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

# --- Selbstschutz -----------------------------------------------------------
# Das Gate soll sich nicht mit einem Handgriff selbst entschaerfen. Der Check
# ist ein Substring-Treffer auf den geschriebenen Pfad und faengt entsprechend
# nur die direkte Schreibweise — `mv .claude .claude-off` oder ein Symlink
# laufen vorbei (siehe Kopf: Stolperdraht, keine Barriere).
PROTECTED_RE = re.compile(r"\.claude/hooks|settings\.local\.json")

# Kommandos, die diese Pfade nur LESEN. `awk` fehlt bewusst (`print > datei`
# schreibt). `git` steht hier DRIN: die frueher gewaehlte Ausnahme sollte
# `git checkout -- <hook>` verhindern, hat das aber nie geleistet
# (`git checkout main -- .`, `git stash`, `git restore .` kommen ohne den Pfad
# aus und liefen durch) — sie kostete nur Reibung: `git add .claude/hooks/...`
# war unmoeglich, das Versionieren des Gates brauchte ein pfadfreies
# `git add -A`. Reibung ohne Schutz ist es nicht wert.
READONLY_CMDS = frozenset({
    "cat", "head", "tail", "less", "more", "grep", "rg", "ls", "stat", "wc",
    "diff", "cmp", "md5sum", "sha256sum", "file", "realpath", "dirname",
    "basename", "sort", "uniq", "cut", "jq", "git",
})

# Kommandos, die als erstes Wort eines Teilkommandos gesperrt sind. Geprueft
# wird der BASENAME des Tokens, `/usr/bin/sudo` und `"sudo"` zaehlen also mit.
BLOCKED_COMMANDS = {
    "sudo": "`sudo` ist gesperrt — Host-Administration laeuft ueber Alrik, nicht ueber den Executor.",
    "doas": "`doas` ist gesperrt — siehe `sudo`.",
    "docker": "`docker` ist gesperrt — der Test-Stack laeuft persistent, der Routine-Loop startet ihn nicht.",
    "docker-compose": "`docker-compose` ist gesperrt — siehe `docker`.",
}

SHELLS = ("bash", "sh", "zsh")
DOWNLOADERS = ("curl", "wget")

OPERATORS = (";", "&&", "||", "|", "&")


def emit(decision, reason):
    # Kompakte Separatoren: der Wrapper prueft die Entscheidung als Substring.
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
    if p.startswith("~"):
        return False
    if not p.startswith("/"):
        return True
    p = os.path.normpath(p)
    return any(p.startswith(pref) or p + "/" == pref for pref in SAFE_PREFIXES)


def lex(line):
    """Eine Zeile in Tokens zerlegen; Operatoren kommen als eigene Tokens."""
    lx = shlex.shlex(line, posix=True, punctuation_chars=True)
    lx.whitespace_split = True
    try:
        return list(lx)
    except ValueError:
        emit("deny", "Kommando nicht parsebar (unbalancierte Quotes) — fail-closed.")


def segments(cmd):
    """Kommando in Teilkommandos zerlegen.

    ZEILENWEISE zuerst: `shlex` behandelt `\\n` als gewoehnlichen Whitespace und
    gibt ihn NIE als Token zurueck. Ein mehrzeiliger Block war dadurch EIN
    Segment, dessen `base` das erste Wort der ersten Zeile ist — alles ab Zeile 2
    entkam saemtlichen Token-Regeln (`echo start\\nrm -rf /etc/nginx` lief
    durch). Mehrzeilige Bloecke sind fuer das Bash-Tool der Normalfall, nicht
    die Ausnahme.

    Danach je Zeile am Shell-Lexer trennen — NICHT per Regex-Split: der zerriss
    Klammern INNERHALB von Quotes und lehnte `python3 -c "open(...)"` oder
    `awk '{print $1}'` faelschlich ab.

    Rueckgabe: Liste von Token-Listen, fuehrende ENV-Zuweisungen abgestreift.
    """
    out = []
    for line in cmd.splitlines():
        if not line.strip():
            continue
        segs, cur = [], []
        for t in lex(line):
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
        for s in segs:
            while s and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", s[0]):
                s = s[1:]
            if s:
                out.append(s)
    return out


def check(cmd):
    segs = segments(cmd)

    # `curl … | sh` — geprueft am Segment, nicht am Rohtext. Die fruehere
    # Rohtext-Regex hielt `cat /tmp/a | grep foo.sh` faelschlich fuer eine
    # Shell-Pipe, weil `\bsh\b` auch in Dateinamen trifft.
    for i, toks in enumerate(segs[:-1]):
        if os.path.basename(toks[0]) in DOWNLOADERS:
            nxt = os.path.basename(segs[i + 1][0])
            if nxt in SHELLS:
                return "deny", "Download nach Shell-Pipe (`curl|bash`) — nicht auditierbar, gesperrt."

    for toks in segs:
        base = os.path.basename(toks[0])
        rest = toks[1:]

        # Gesperrte Kommandos am Segmentanfang. Der BASENAME faengt auch
        # `/usr/bin/sudo`; Quotes hat der Lexer bereits entfernt. Bewusst KEIN
        # Rohtext-Treffer mehr: der lehnte jede Erwaehnung ab — `grep -rn docker
        # CLAUDE.md`, `git commit -m 'fix: sudo handling'` oder ein
        # `gh pr create --body '… docker compose …'` waren nicht ausfuehrbar.
        if base in BLOCKED_COMMANDS:
            return "deny", BLOCKED_COMMANDS[base]

        # Selbstschutz: zeigt ein Token auf Hook-Skripte oder die Settings, ist
        # nur eine kleine Menge reiner Lese-Kommandos zugelassen. Substring-
        # Treffer, erfasst also auch Pfade INNERHALB von Quotes, z.B.
        # `python3 -c "open('.claude/hooks/bash-gate.py','w')"`.
        if any(PROTECTED_RE.search(t) for t in toks):
            if base not in READONLY_CMDS:
                return "deny", (
                    "Zugriff auf das Gate selbst (`.claude/hooks/**` bzw. "
                    "`settings.local.json`) ist nur lesend erlaubt — das Gate darf "
                    "sich nicht selbst entschaerfen. Aenderungen macht Alrik."
                )

        # `bash -c "<kommando>"` versteckt das eigentliche Kommando in einem
        # String-Argument. Nutzlast rekursiv durch dasselbe Gate schicken.
        # Kombinierte Flags (`-lc`, `-ic`) zaehlen mit.
        if base in SHELLS:
            for i, t in enumerate(rest):
                if re.match(r"^-[a-z]*c$", t) and i + 1 < len(rest):
                    sub_decision, sub_reason = check(rest[i + 1])
                    if sub_decision == "deny":
                        return "deny", f"in `{base} -c`: {sub_reason}"
                    break

        if base == "git":
            sub = next((t for t in rest if not t.startswith("-")), "")
            if sub == "push":
                if any(t in ("--force", "-f", "--force-with-lease", "--mirror") or
                       t.startswith("--force-with-lease=") for t in rest):
                    return "deny", "`git push --force` — ueberschreibt fremde Historie, gesperrt."
                for t in rest:
                    ref = t.split(":")[-1].lstrip("+")
                    if ref in ("main", "master") or ref.endswith("/main") or ref.endswith("/master"):
                        return "deny", "Direkter Push nach `main`/`master` — Aenderungen laufen ueber PR + Merge durch Alrik (Gate 3)."
                # Nackter `git push` schiebt den aktuellen Branch — auf `main`
                # also ein Direktpush. Das Gate kennt den Branch nicht, deshalb
                # wird die Ziel-Angabe verlangt.
                if not [t for t in rest if not t.startswith("-") and t != "push"]:
                    return "deny", (
                        "`git push` ohne Ziel — auf `main` waere das ein Direktpush. "
                        "Bitte Remote und Branch ausdruecklich nennen."
                    )
            if sub == "reset" and "--hard" in rest:
                return "deny", "`git reset --hard` — verwirft nicht committete Arbeit unwiederbringlich."
            if sub == "clean" and any(re.match(r"^-[a-zA-Z]*f", t) or t == "--force" for t in rest):
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
                if (a.startswith("/") or a.startswith("~")) and not is_safe_path(a):
                    return "deny", f"`{base}` auf Systempfad `{a}` — gesperrt."

        # Schreib-Redirects in Systempfade. `>|` und `&>` werden vom Lexer als
        # eigene Interpunktions-Tokens geliefert und zaehlen mit.
        for i, t in enumerate(toks):
            if t in (">", ">>", ">|", "&>", "&>>") and i + 1 < len(toks):
                target = toks[i + 1]
                if target == "/dev/null":
                    continue
                if (target.startswith("/") or target.startswith("~")) and not is_safe_path(target):
                    return "deny", f"Schreib-Redirect nach `{target}` — Systempfad, gesperrt."
        if base == "tee":
            for a in [t for t in rest if not t.startswith("-")]:
                if (a.startswith("/") or a.startswith("~")) and not is_safe_path(a):
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
