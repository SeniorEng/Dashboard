---
name: Ephemeral test-DB parallelism & PID ceiling
description: Why integration test workers are capped low, how fresh-DB isolation breaks tests, and how to verify runs in this container.
---

# Ephemeral throwaway test DBs + fileParallelism (CareConnect)

The integration test workflow runs via `scripts/with-ephemeral-db.ts`: builds one
seeded template DB, clones a throwaway DB per vitest worker, and gives each worker
its own dedicated app-server (per-worker `DATABASE_URL`/`TEST_BASE_URL` routed in
`tests/setup.ts` by `VITEST_POOL_ID`).

## Parallel worker count is capped by the container PID ceiling
**Rule:** default to a LOW number of parallel test workers (currently 2), overridable
via `EPHEMERAL_DB_WORKERS`.
**Why:** the container cgroup sets `pids.max=1024` (user.slice budget ~1000). Each
worker is a full app-server that can spawn Chromium for PDF renders; when the `test`
workflow runs concurrently with `e2e-smoke` (Playwright browsers) and `Start
application`, the combined process/thread count exceeds the ceiling → `spawn EAGAIN`
kills whole vitest workers, and EVERY file on a dead worker reports as "failed". This
looks like a mass test regression but is pure resource exhaustion, not logic.
**How to apply:** if you see a burst of unrelated test-file failures plus `EAGAIN`
/ "Worker exited" in the log, suspect the PID ceiling first. Don't bump workers high
for the local workflow (it must coexist with the other workflows). Also cap
`PDF_RENDER_CONCURRENCY=1` per worker. Higher parallelism is fine only on isolated
CI runners (one job = one fresh runner).

## Fresh isolated DBs expose tests that relied on shared accumulated data
**Symptom:** a test does `GET /api/customers` (or employees/appointments) and uses
`data[0]`, or hard-codes a record id (e.g. `customer_id=14`). Passes on the old shared
dev DB (which had organically accumulated rows), fails on a fresh isolated DB (0 rows
/ FK violation).
**Fix (test/seed setup only):** create the needed data in `beforeAll` via the
`createTestCustomer()` helper in `tests/test-utils.ts` and clean up with
`cleanupCustomer()` — do NOT weaken assertions or change domain logic.

## Verifying runs in this environment
**The workflow-log capture (`/tmp/logs/test_*.log`) is unreliable for fresh results**
— it re-snapshots the last-completed run with a frozen mtime, so it can show a stale
older run even when a workflow "finished/failed" again. `restart_workflow` on
`test`/`e2e-smoke` tends to time out. Detached/`setsid`/`nohup` background runs get
killed when the bash tool's cgroup scope tears down.
**Only reliable method:** a SYNCHRONOUS bash run inside one tool call (≤120s) with an
internal `timeout --signal=TERM <~100>` (so the orchestrator's DB/server teardown
fires before the hard kill), output to a file, then grep in the same call. Setup
(template push + per-worker clone + server boot) is ~40-60s, leaving ~40-50s of test
budget → run small file subsets only.

**Note (2026-06): all 5 workflows auto-re-fire together** in this env (platform
re-runs, not your edits — `.local` bundle writes are gitignored and do NOT trigger the
watcher). So a "clean isolated" full 2-worker run is effectively impossible here: a
manual background run always ends up racing a concurrently-re-fired `test`+`e2e-smoke`
and slows to 10+ min / EAGAINs. To validate correctness despite this, lean on: (a) tsc
(authoritative for code, fast even under load), (b) a one-time clean provisioning
measurement grabbed before contention hits, (c) the fact that failures are the SAME
resource-exhaustion set as baseline. True green is the isolated CI runner's job.

## tsx cold-start, not seeders, dominates per-worker boot
**Finding (Task #903):** per-worker app-server boot was ~13s and is dominated by
`tsx`'s on-the-fly transpilation of the whole server import graph, NOT by the startup
seeders/migrations. `TEST_SKIP_CLIENT` (skipping the Vite client mount) alone saved
only ~1.5s.
**Fix that worked:** esbuild-bundle the server ONCE per run (~2s) into a gitignored
`.local/test-server-<runId>.cjs` and boot each worker with plain `node <bundle>` →
"serving" in ~3s vs ~13s; whole-run provisioning ~24s vs ~31s. Shared esbuild helper
`script/server-bundle.ts` (`buildServerBundle`/`getServerExternals`), reused by the
prod build `script/build.ts`. Keep `drizzle-orm`/`@neondatabase/serverless`/`ws`
EXTERNAL — bundling drizzle breaks SQL template-fragment composition. The e2e/Playwright
path still needs `tsx` (it serves the real Vite client), so only the vitest path was
switched to the bundle.
**Why:** future "make tests faster" work should attack boot/transpile cost (bundle,
fewer workers' cold starts) before touching seeders.

## Both test paths boot from ONE API-only server bundle
**Rule:** vitest AND e2e workers boot from the same esbuild bundle
(`excludeClientServer: true`) via plain `node`, not `tsx server/index.ts`.
- vitest: `TEST_SKIP_CLIENT=1` (no client at all).
- e2e: `TEST_SERVE_STATIC_CLIENT=1` + `CLIENT_STATIC_DIR=<per-run vite build>` →
  server takes the `serveStatic` branch even under `NODE_ENV=test`.
**Why one bundle works for both:** static serving never imports `./vite`, so the
API-only bundle (which excludes the Vite dev server) is sufficient for the SPA path
too. The per-run `vite build` is kicked off CONCURRENTLY with DB provisioning +
server bundling, so it costs almost no wall-clock.
**How to apply:** escape hatch `EPHEMERAL_DISABLE_BUNDLE=1` reverts BOTH paths to the
old `tsx` boot (e2e then back to the Vite dev server). If e2e serves a stale UI,
check that the per-run client build (`.local/test-client-<runId>`) actually rebuilt.
