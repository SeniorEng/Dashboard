---
name: Stryker mutation testing setup
description: Why Stryker uses the command runner (not the vitest runner) and how the mutation suite is scoped in this repo.
---

# Stryker mutation testing (CareConnect)

## Decision: command runner, not @stryker-mutator/vitest-runner
The dedicated `@stryker-mutator/vitest-runner` (9.6.1) hangs forever at
"Creating test runner process(es)" with **vitest 4.x** — vitest 4 is newer than
the runner's supported internals (its peer range `>=2.0.0` is misleadingly loose).
The dry run never completes.

**Fix:** `testRunner: "command"` with
`commandRunner.command = "npx vitest run --config vitest.stryker.config.ts"`.
The command runner reruns the whole (small, pure) suite per mutant — version-agnostic,
~3s cold start per mutant, fine for a tiny suite.

**Why:** mutation testing must stay usable in CI; a hanging runner blocks the gate.
**How to apply:** if you ever migrate to the vitest runner, re-verify a dry run
actually completes on the installed vitest major version before trusting it.

## Scope is deliberately pure-only
Only **pure** `shared/domain/` calc modules are mutated (no DB/server I/O), each backed
by a pure unit/equality test, run via `vitest.stryker.config.ts` (NO `globalSetup`, so
no DB cleanup). DB-bound services (consumption-engine, month-close-scheduler) are
intentionally excluded — mutating them needs Postgres + app server = the explicit
"too expensive" out-of-scope. Their math already lives in pure modules (`cap-math`,
`history-aggregation`) which ARE covered.

## Sandbox copy trap
Stryker copies the project into a sandbox respecting `.gitignore`. The workspace root
has dot-dirs (`.cache/`, `.config/pulse/`) with FIFOs/special files that crash the copy
with `EISDIR`. Solution: allowlist `ignorePatterns` (`["**", "!shared/**", "!tests/**",
...]`) so only what the pure tests need is copied. node_modules is symlinked, not copied.

## Gotcha when killing runs manually
`pkill -f stryker` / `pgrep -f stryker` self-match the running shell's own command line
(it contains "stryker") and SIGKILL the shell (exit 137). Kill by exact PID, or match a
substring your kill command itself does NOT contain (e.g. `mutator/core`).
