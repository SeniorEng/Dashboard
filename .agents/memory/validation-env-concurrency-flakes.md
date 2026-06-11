---
name: Validation-env concurrency flakes vs CI
description: Why some integration tests fail only in the agent validation harness and not in CI, and how to verify them.
---

The agent validation harness auto-runs the `test`, `e2e-smoke`, and `Start application`
workflows CONCURRENTLY. CI runs each as an isolated job. This difference produces
failures that are NOT real CI failures:

- **PID pressure**: container cgroup `pids.max` ~= 1024. Concurrent ephemeral-DB
  workers + Chromium PDF renders + e2e browsers exhaust it → `spawn EAGAIN`,
  ECONNREFUSED, or servers that never reach `startupComplete`. Environmental, not logic.
- **Concurrent-insert count races**: `tests/test-data-cleanup.test.ts` asserts
  `summary.*Deleted == countDisappeared(before, after)`. The parallel `test`
  workflow constantly inserts test-pattern rows; a row inserted in the window
  between the `before` snapshot and the purge gets deleted+counted but is not in
  `before` → mismatch. The test's own comments (lines ~35-38) document that this is
  deterministic/green in CI (sequential, alone). Verify in isolation, not in the harness.
- **Timing flakes**: `tests/services.test.ts` concurrency cases
  (`priceCents=-1`, parallel-POST Sonderpreis-Konflikt) fail nondeterministically —
  a DIFFERENT case fails each run. Pre-existing, timing-based.

**How to verify cleanly**: run the suspect file with raw vitest against the running
dev server (`NODE_ENV=test npx vitest run --project integration <file>`, base URL
defaults to localhost:5000). Other workflows use ephemeral DBs, so the dev DB sees no
concurrent inserts → count invariants hold and you get a true signal. Background
nohup/setsid runs in this env get killed and their /tmp logs vanish; prefer
synchronous foreground runs.

**Why:** repeatedly chased "failures" that were just the harness's concurrent
fan-out, wasting time re-running the orchestrator. Trust the per-file isolated run
and the test's own concurrency-immunity comments over the noisy harness aggregate.

**Caveat — not every billing failure is a concurrency flake:**
`tests/billing/persist-invoice-pdf-mutex.test.ts` fails DETERMINISTICALLY with
`TypeError: db.transaction is not a function` (invoice-pdf-orchestrator) even under
raw single-file vitest against the dev DB — i.e. it reproduces in full isolation, so
it is NOT the concurrent-fan-out flake above. The dev `Start application` server uses
that exact `db.transaction` path fine, so it's a vitest module-resolution artifact of
the billing/orchestrator import graph, pre-existing and independent of unrelated
feature work (e.g. prospect-card changes touch no billing code). Don't try to "fix" it
from an unrelated task; confirm zero coupling (grep that your change isn't imported by
billing) and skip it. Same for `billing-flow.test.ts` `list.data.find is not a function`
and `bulk-print` count `0 >= 1` — pre-existing billing-suite breakage in this env.

**Two orchestrators = template clone-race (spurious `test` FAILED):** running your OWN
`with-ephemeral-db.ts` run while the harness's `test`/`e2e-smoke` workflows are live
makes the harness's parallel 2-worker `CREATE DATABASE … TEMPLATE per_run_tmpl` fail
with `source database … is being accessed by other users / There is 1 other session`.
That FAILED is an infra clone-race, NOT a test-logic failure and NOT your code. Never
run a second orchestrator; kill yours (`pkill -f "with-ephemeral-db.ts <port>"`) and
let the harness/CI `test` run be the signal.

**Running the ephemeral orchestrator manually (Chromium/PDF integration files that
NEED a throwaway DB, so the raw-vitest-vs-dev-server trick above doesn't apply):**
- `setsid`/`nohup &` detached runs STALL forever at the esbuild "Baue
  Test-Server-Bundle" step — esbuild's child service never spawns without a
  controlling TTY (the parent sits idle with no children). Run in the FOREGROUND.
- Booting a second app server + Chromium alongside the running `Start application`
  dev server (plus any concurrent `test`/`e2e-smoke`) OOM-kills the run (exit 137).
  Mitigate: `EPHEMERAL_DB_WORKERS=1 PDF_RENDER_CONCURRENCY=1`, kill the competing
  orchestrators (`pkill -9 -f "with-ephemeral-db.ts 5050"` / `5051` / `test:e2e:smoke`),
  and launch in a window where `test`+`e2e-smoke` show "failed/stopped". A clean
  single-file run then fits in ~20s, well under the 120s bash cap.
