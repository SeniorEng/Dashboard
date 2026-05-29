---
name: Stryker mutation testing setup
description: Two-profile split (fast native vitest runner + safe command runner), why the command runner is only for property modules, the -c CLI trap, and suite scoping.
---

# Stryker mutation testing (CareConnect)

## Two-profile split (the native runner CAN be used — but only for deterministic modules)
The mutation suite runs as **two Stryker profiles** orchestrated by
`scripts/run-mutation.mjs` (`npm run mutation`), which aggregates both JSON
reports into one score and enforces `break: 60` on the AGGREGATED score:

- **`vitest` profile** (`stryker.vitest.conf.mjs`, native
  `@stryker-mutator/vitest-runner`, `coverageAnalysis: "off"`, config
  `vitest.stryker-vitest.config.ts`): the SIX DETERMINISTIC `shared/domain/`
  modules. Fast (~1 min for the whole group, ~488 mutants).
- **`command` profile** (`stryker.command.conf.mjs`, command runner): the TWO
  PROPERTY modules `invoice-line-items.ts` + `budget-invoice-split.ts` (covered
  by fast-check tests `tests/equality/*`), config `vitest.stryker.config.ts`.
- Shared options live in `stryker.base.mjs`. Each profile has its OWN incremental
  file (`reports/stryker-incremental-vitest.json` /
  `…-command.json`) so the two runs don't clobber each other's cache.
- Single-profile gating is disabled (`thresholds.break: null` in base); the
  orchestrator gates the aggregate.

**Why the command runner ONLY for the two property modules:** re-verified
2026-05-28 (runner 9.6.1, vitest 4.0.18). The native runner's dry run completes,
but the mutation phase HANGS on mutants that create a *synchronous* infinite loop
inside the fast-check property tests — a vitest worker thread can't be aborted
mid-synchronous-loop, so the per-mutant timeout never fires. The command runner
spawns a fresh `npx vitest run` child per mutant and SIGKILLs it after
`timeoutMS`, so process death kills the infinite-loop mutant. The six
deterministic modules have no such loop risk, so they run on the fast native
runner. Cost: the command runner pays a ~5-8s cold start PER MUTANT (near-serial
in this container), so a cold full `command` run is several minutes for ~149
mutants; the vitest profile is the speedup. `timeoutMS` is 25s (suite runs ~3s,
generous margin) — lower = infinite-loop mutants die faster.

**How to apply:** keep deterministic modules on `vitest`; only move a module to
`command` if its tests are property-based / can loop. Before moving a property
module BACK to the native runner, verify a FULL run (not just the dry run)
finishes without hanging on the installed vitest major.

## The `-c` CLI trap (mislabeled "concurrency must match pattern")
`stryker run`'s config file is a **POSITIONAL** argument:
`npx stryker run stryker.vitest.conf.mjs`. `-c` is the short flag for
`--concurrency`, NOT config-file. Passing `-c stryker.X.conf.mjs` assigns the
file PATH as the concurrency value, which fails the oneOf(number|percent-string)
schema and aborts with the misleading
`Config option "concurrency" must match pattern "^(100|[1-9]?[0-9])%$"`.
This is NOT a Stryker validator bug and NOT a version regression — it's the
wrong CLI flag. The orchestrator passes the config positionally.
**How to apply:** if you see that concurrency-pattern error, check you didn't
pass the config via `-c`; use the positional arg (or `--configFile`).

## Scope is deliberately pure-only
Only **pure** `shared/domain/` calc modules are mutated (no DB/server I/O), each backed
by a pure unit/equality test run via a stryker vitest config with NO `globalSetup` (so
no DB cleanup): `vitest.stryker-vitest.config.ts` for the deterministic modules,
`vitest.stryker.config.ts` for the property modules. DB-bound services
(consumption-engine, month-close-scheduler) are intentionally excluded — mutating them
needs Postgres + app server = the explicit "too expensive" out-of-scope. Their math
already lives in pure modules (`cap-math`, `history-aggregation`) which ARE covered.

## Sandbox copy trap
Stryker copies the project into a sandbox respecting `.gitignore`. The workspace root
has dot-dirs (`.cache/`, `.config/pulse/`) with FIFOs/special files that crash the copy
with `EISDIR`. Solution: allowlist `ignorePatterns` (`["**", "!shared/**", "!tests/**",
...]`) so only what the pure tests need is copied. node_modules is symlinked, not copied.

## Incremental cache is keyed on SOURCE hash, not test hash
`incremental: true` reuses prior mutant results whenever the mutated source file is
unchanged — even if you added/changed assertions in its TEST file. So after writing new
tests to kill survivors, a normal `npm run mutation` reports the OLD (stale) score. There
are now TWO incremental files (one per profile): to re-measure delete the relevant one(s)
before the run — `rm -f reports/stryker-incremental-vitest.json
reports/stryker-incremental-command.json` (CLI `--incremental false` does NOT work — it's
parsed as a config-file path). Both files are gitignored.
**How to apply:** any time you tune tests to raise a module's score, delete the matching
incremental report first or you'll trust a cached number.

## Gotcha when killing runs manually
`pkill -f stryker` / `pgrep -f stryker` self-match the running shell's own command line
(it contains "stryker") and SIGKILL the shell (exit 137). Kill by exact PID, or match a
substring your kill command itself does NOT contain (e.g. `mutator/core`).
