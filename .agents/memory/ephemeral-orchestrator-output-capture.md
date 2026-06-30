---
name: Ephemeral-DB orchestrator output capture in agent harness
description: Why manual backgrounded `with-ephemeral-db.ts` runs produce empty log files, and what actually captures their output.
---

When you run `npx tsx scripts/with-ephemeral-db.ts <port> npx vitest run <files>`
yourself from the agent's bash tool, the test results are very hard to capture:

- A **foreground** run piped through `| tee file.log` DOES stream output
  incrementally (orchestrator boot lines appear), but a large integration file
  (e.g. tests/service-records.test.ts) exceeds the bash tool's ~120s ceiling and
  the tool SIGKILLs the whole process group before vitest prints results.
- A **backgrounded** run (`setsid ... &`, `nohup`, even `script -q -c ... file`)
  reliably produces a **0-byte log file** — the orchestrator/vitest child output
  never lands in a plain redirected file, and the process often finishes with
  nothing captured. Tried: direct `>`, `>>`, `| tee`, `| cat`, `script` PTY — all empty.

**Why:** don't keep re-trying capture variants; it's an environment quirk, not a
fixable redirect bug. The system reminder explicitly warns against repeating it.

**How to apply:** to actually SEE integration/e2e results, rely on the platform
workflow runner (it allocates a PTY and writes full logs to /tmp/logs/, read via
refresh_all_logs) — e.g. the `test` / `e2e-smoke` workflows. For a single file you
can't isolate that way; instead lean on typecheck + lint + clean dev-server boot
plus mark_task_complete's configured validation run. Also: `pkill -f with-ephemeral-db`
kills your OWN bash shell (the pattern matches the wrapping `bash -c` command line,
exit 143) — kill orchestrators by PID from `pgrep` instead.
