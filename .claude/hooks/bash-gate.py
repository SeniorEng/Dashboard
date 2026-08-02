#!/usr/bin/env python3
"""Entscheidungslogik des PreToolUse-Gates fuer das Bash-Tool.

STOLPERDRAHT GEGEN VERSEHEN — KEIN SANDBOX-ERSATZ.
Dieses Gate faengt das versehentlich getippte `sudo …`, `docker …`,
`git push origin main` oder `rm -rf /…`. Es ist ein Kommando-FILTER und als
solcher grundsaetzlich umgehbar. Die Regel, an der die Grenze verlaeuft:
**geprueft wird das ERSTE WORT jedes Teilkommandos.** Alles, was das
eigentliche Kommando dahinter versteckt, laeuft vorbei — Praefix-Kommandos
(`env`, `command`, `nohup`, `time`, `{ …; }`), Variablen-Expansion
(`X=sudo; $X …`), Command-Substitution (`$(sudo id)`), `xargs`, `find -exec`,
`eval`, Heredoc-Ruempfe an eine Shell, oder ein umbenanntes Verzeichnis
(`mv .claude .claude-off`). Das ist BEWUSST nicht geschlossen — ein Filter, der
all das faengt, blockiert normale Arbeit, und vollstaendig wird er trotzdem nie.
`tests/architecture/bash-gate.test.ts` haelt diese Grenze als Block
`BEWUSST_OFFEN` fest, damit sie sichtbar bleibt.
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

SAFE_PREFIXES = (
    "/home/dev/dashboard/",
    "/tmp/",
    "/var/tmp/",
    "/home/dev/.claude/",
    "/home/dev/.local/share/claude/",
)

PROTECTED_RE = re.compile(r"\.claude/hooks|settings\.local\.json")

# Kommandos, die die geschuetzten Pfade nur LESEN. `awk` fehlt bewusst
# (`print > datei` schreibt). `git` steht drin: die fruehere Ausnahme sollte
# `git checkout -- <hook>` verhindern, hat das nie geleistet (`git checkout
# main -- .`, `git stash`, `git restore .` kommen ohne den Pfad aus) und machte
# nur das Versionieren des Gates unmoeglich. Dass `git` damit den Hook auf einen
# aelteren Stand zuruecksetzen kann, ist eine bewusst offene Klasse.
READONLY_CMDS = frozenset({
    "cat", "head", "tail", "less", "more", "grep", "rg", "ls", "stat", "wc",
    "diff", "cmp", "md5sum", "sha256sum", "file", "realpath", "dirname",
    "basename", "sort", "uniq", "cut", "jq", "git",
})

BLOCKED_COMMANDS = {
    "sudo": "`sudo` ist gesperrt — Host-Administration laeuft ueber Alrik, nicht ueber den Executor.",
    "doas": "`doas` ist gesperrt — siehe `sudo`.",
    "docker": "`docker` ist gesperrt — der Test-Stack laeuft persistent, der Routine-Loop startet ihn nicht.",
    "docker-compose": "`docker-compose` ist gesperrt — siehe `docker`.",
}

SHELLS = ("bash", "sh", "zsh")
DOWNLOADERS = ("curl", "wget")

OPERATORS = (";", "&&", "||", "|", "&")
REDIRECTS = (">", ">>", ">|", "&>", "&>>", "<", "<<", "<<<")

# git-Flags, die einen WERT nach sich ziehen. Ohne die Liste laese
# `git -C <dir> push …` das Verzeichnis als Subkommando und alle git-Regeln
# waeren aus.
GIT_VALUE_FLAGS = ("-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace")

HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def emit(decision, reason):
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
    Relative Pfade sind sicher, weil das cwd das Projekt ist. `~` wird aufgeloest,
    damit `~/dashboard/out.log` nicht faelschlich als Systempfad gilt."""
    p = os.path.expanduser(p)
    if not p.startswith("/"):
        return True
    p = os.path.normpath(p)
    if p in ("/home/dev/.claude", "/home/dev/dashboard/.claude"):
        return False
    return any(p.startswith(pref) or p + "/" == pref for pref in SAFE_PREFIXES)


def try_lex(text):
    """Tokens oder None, wenn der Text (noch) nicht lexbar ist."""
    lx = shlex.shlex(text, posix=True, punctuation_chars=True)
    lx.whitespace_split = True
    try:
        return list(lx)
    except ValueError:
        return None


def logical_lines(cmd):
    """Physische Zeilen zu logischen Kommandozeilen zusammenfassen.

    Der Zeilen-Split ist noetig, weil `shlex` `\\n` als gewoehnlichen Whitespace
    behandelt: ohne ihn waere ein mehrzeiliger Block EIN Segment und alles ab
    Zeile 2 entkaeme allen Regeln (`echo start\\nrm -rf /etc/nginx`).

    Er darf aber nicht MITTEN in ein Argument schneiden. Drei Faelle:
      - Backslash-Fortsetzung (`npx vitest run \\`),
      - mehrzeilige gequotete Argumente (`git commit -m 'Absatz eins\\n\\nzwei'`),
      - Heredocs (`cat > x.md <<'EOF' … EOF`).
    Die ersten beiden werden mit der Folgezeile zusammengehaengt, bis der Text
    lexbar ist; der Heredoc-RUMPF wird uebersprungen — er ist Daten, kein
    Kommando. Ohne das lehnte das Gate genau die Arbeit ab, die es durchlassen
    soll: mehrabsaetzige Commit-Messages, `gh pr create --body '…'` und jede
    Doku, die `docker compose` erwaehnt.
    """
    raw = cmd.replace("\r\n", "\n").split("\n")
    out = []
    i = 0
    while i < len(raw):
        line = raw[i]
        while line.rstrip().endswith("\\") and i + 1 < len(raw):
            line = line.rstrip()[:-1] + " " + raw[i + 1]
            i += 1
        while try_lex(line) is None and i + 1 < len(raw):
            i += 1
            line = line + "\n" + raw[i]
        if line.strip():
            out.append(line)
        m = HEREDOC_RE.search(line)
        if m:
            delim = m.group(2)
            i += 1
            while i < len(raw) and raw[i].strip() != delim:
                i += 1
        i += 1
    return out


def segments(cmd):
    """Liste von (vorheriger Operator, Tokens). ENV-Zuweisungen und fuehrende
    Redirects werden abgestreift — `> /tmp/log sudo -n id` haette sonst `>` als
    Kommando gelesen und jede Regel des Segments abgeschaltet."""
    out = []
    for line in logical_lines(cmd):
        toks = try_lex(line)
        if toks is None:
            emit("deny", "Kommando nicht parsebar (unbalancierte Quotes) — fail-closed.")
        cur, prev_op = [], None
        pending_op = None
        for t in toks:
            if t in OPERATORS:
                if cur:
                    out.append((prev_op, cur))
                cur, prev_op = [], t
                pending_op = t
                continue
            if t in ("(", ")"):
                continue
            cur.append(t)
        if cur:
            out.append((prev_op, cur))
        _ = pending_op

    cleaned = []
    for op, s in out:
        while s and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", s[0]):
            s = s[1:]
        # `> /tmp/log cmd` und `2> /tmp/log cmd`. Der Lexer liefert die
        # Dateideskriptor-Ziffer als EIGENES Token, deshalb beide Formen.
        while True:
            if len(s) >= 2 and s[0] in REDIRECTS:
                s = s[2:]
            elif len(s) >= 3 and re.fullmatch(r"\d+", s[0]) and s[1] in REDIRECTS:
                s = s[3:]
            else:
                break
        if s:
            cleaned.append((op, s))
    return cleaned


def git_subcommand(rest):
    """Erstes Nicht-Flag-Token, aber Flags MIT WERT ueberspringen."""
    i = 0
    while i < len(rest):
        t = rest[i]
        if t in GIT_VALUE_FLAGS:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t
    return ""


def check(cmd):
    segs = segments(cmd)

    # `curl … | sh` — nur bei einer echten Pipe. Die fruehere Rohtext-Regex hielt
    # `cat /tmp/a | grep foo.sh` fuer eine Shell-Pipe; die reine Nachbarschaft
    # ohne Operator-Pruefung sperrte `curl -sf http://x/health && bash script.sh`.
    for i in range(len(segs) - 1):
        if os.path.basename(segs[i][1][0]) in DOWNLOADERS:
            nxt_op, nxt = segs[i + 1]
            if nxt_op == "|" and os.path.basename(nxt[0]) in SHELLS:
                return "deny", "Download nach Shell-Pipe (`curl|bash`) — nicht auditierbar, gesperrt."

    for _op, toks in segs:
        base = os.path.basename(toks[0])
        rest = toks[1:]

        if base in BLOCKED_COMMANDS:
            return "deny", BLOCKED_COMMANDS[base]

        if any(PROTECTED_RE.search(t) for t in toks):
            if base not in READONLY_CMDS:
                return "deny", (
                    "Zugriff auf das Gate selbst (`.claude/hooks/**` bzw. "
                    "`settings.local.json`) ist nur lesend erlaubt — das Gate darf "
                    "sich nicht selbst entschaerfen. Aenderungen macht Alrik."
                )

        if base in SHELLS:
            for i, t in enumerate(rest):
                if re.match(r"^-[a-z]*c$", t) and i + 1 < len(rest):
                    sub_decision, sub_reason = check(rest[i + 1])
                    if sub_decision == "deny":
                        return "deny", f"in `{base} -c`: {sub_reason}"
                    break

        if base == "git":
            sub = git_subcommand(rest)
            if sub == "push":
                if any(t in ("--force", "-f", "--force-with-lease", "--mirror") or
                       t.startswith("--force-with-lease=") for t in rest):
                    return "deny", "`git push --force` — ueberschreibt fremde Historie, gesperrt."
                for t in rest:
                    ref = t.split(":")[-1].lstrip("+")
                    if ref in ("main", "master", "HEAD") or ref.endswith("/main") or ref.endswith("/master"):
                        return "deny", "Direkter Push nach `main`/`master` — Aenderungen laufen ueber PR + Merge durch Alrik (Gate 3)."
                # Nackter `git push` schiebt den aktuellen Branch — auf `main`
                # also ein Direktpush, und das Gate kennt den Branch nicht.
                # `--dry-run`/`-n` sind ausgenommen: das schreibt nichts, und
                # die Regel ohne diese Ausnahme sperrte den read-only Check.
                dry = any(t in ("--dry-run", "-n") for t in rest)
                targets = [t for t in rest if not t.startswith("-") and t != "push"]
                if not dry and not targets:
                    return "deny", (
                        "`git push` ohne Ziel — auf `main` waere das ein Direktpush. "
                        "Bitte Remote und Branch ausdruecklich nennen (oder `--dry-run`)."
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
                    if a in ("/", "~") or not is_safe_path(a):
                        return "deny", f"`rm -rf` auf `{a}` — ausserhalb von Projekt/Wegwerf-Pfaden; mehrdeutig, deshalb gesperrt."
                    if "*" in a and a.startswith("/"):
                        return "deny", f"`rm -rf` mit Glob auf absolutem Pfad (`{a}`) — Treffermenge nicht vorhersehbar."

        if base in ("chmod", "chown"):
            for a in [t for t in rest if not t.startswith("-")]:
                if (a.startswith("/") or a.startswith("~")) and not is_safe_path(a):
                    return "deny", f"`{base}` auf Systempfad `{a}` — gesperrt."

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
