---
name: Stryker mutation testing setup
description: Why Stryker uses the command runner (not the vitest runner) and how the mutation suite is scoped in this repo.
---

# Stryker mutation testing (CareConnect)

## Decision: command runner, not @stryker-mutator/vitest-runner
The native `@stryker-mutator/vitest-runner` is still NOT viable on **vitest 4.x**
for this suite. Re-verified 2026-05-28 (runner 9.6.1, vitest 4.0.18):

- The **dry run now completes** with the native runner — the old
  "Creating test runner process(es)" / "never finishes the dry run" hang is gone.
  So "dry run works" is NO LONGER sufficient proof; you must verify a FULL run.
- With the default `coverageAnalysis: "perTest"` the **mutation phase hangs**:
  it stalls reproducibly around ~152/269 with no progress and the per-mutant
  timeout never fires.
- Even with `coverageAnalysis: "off"` the run **still hangs** on individual
  mutants that create a *synchronous* infinite loop inside the fast-check
  property tests (`tests/equality/*`). A vitest worker thread can't be aborted
  mid-synchronous-loop, so Stryker's timeout doesn't kill it.

**Fix:** keep `testRunner: "command"` with
`commandRunner.command = "npx vitest run --config vitest.stryker.config.ts"`.
The command runner spawns a fresh child per mutant and SIGKILLs it after
`timeoutMS` — so synchronous-infinite-loop mutants are killed by process death,
not by an in-worker timeout. Version-agnostic, ~3s cold start per mutant, fine
for a tiny pure suite.

**Why:** mutation testing must stay usable in CI; a hanging runner blocks the gate.
**How to apply:** before migrating to the native runner, verify a **full**
`npm run mutation` run (not just the dry run) completes on the installed vitest
major — and remember the real blocker is in-worker timeout enforcement on
synchronous-infinite-loop mutants, which the property tests routinely produce.

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

## Incremental cache is keyed on SOURCE hash, not test hash
`incremental: true` (`reports/stryker-incremental.json`) reuses prior mutant results
whenever the mutated source file is unchanged — even if you added/changed assertions in
its TEST file. So after writing new tests to kill survivors, a normal `npm run mutation`
reports the OLD (stale) score. To re-measure: `rm -f reports/stryker-incremental.json`
before the run (CLI `--incremental false` does NOT work — it's parsed as a config-file
path and errors with "Invalid config file 'false'"). The report file is gitignored.
**How to apply:** any time you tune tests to raise a module's score, delete the
incremental report first or you'll trust a cached number.

## Gotcha when killing runs manually
`pkill -f stryker` / `pgrep -f stryker` self-match the running shell's own command line
(it contains "stryker") and SIGKILL the shell (exit 137). Kill by exact PID, or match a
substring your kill command itself does NOT contain (e.g. `mutator/core`).
