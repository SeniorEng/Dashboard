---
name: Ephemeral-test PID exhaustion sweep
description: Why the ephemeral-DB orchestrator now also sweeps orphaned processes + PID-preflights, and the invariants that keep it from killing the wrong thing.
---

# Ephemeral-test PID exhaustion (orphaned Chromium + test-app-servers)

The recurring "test env blocked" failure (`spawn EAGAIN` / `fork: Resource
temporarily unavailable`, or "Vorlage gerade in Benutzung") is **PID exhaustion**,
not RAM/OOM. The container has a hard `cgroup pids.max` (~1024). Hard-killed runs
(SIGKILL/OOM/IDE abort) skip the orchestrator's SIGINT/SIGTERM teardown, so their
test-app-servers — and the **Chromium grandchildren** those servers spawn for PDF
rendering — get reparented to init and live forever, accumulating across runs.

**Why the existing sweep didn't catch it:** `scripts/lib/ephemeral-db-sweep.ts`
only swept orphaned DBs + log files. There was no process dimension. Chromium was
indistinguishable from dev/prod Chromium.

## The fix (extend, don't parallelize — Ersetzungs-Regel)
- Process detection lives in the SAME sweep SSoT. An orphan is selected ONLY if:
  marker-unique (test-server `.local/test-server-*.cjs` bundle path, OR Chromium
  `careconnect-chromium-test-` userDataDir) AND `ppid===1` (reparented → its
  orchestrator is dead; a live sibling run keeps ppid≠1 → protected) AND past the
  age guard. Never self, never pid<=1, never a foreign process.
- Test Chromium is made distinguishable in `server/services/pdf-generator.ts`:
  `makeChromiumUserDataDir` inserts a `test-` segment only when NODE_ENV==="test".
- Worker app-servers spawn `detached:true` (own process group, pgid===pid) so
  `killServers` can `process.kill(-pid)` the whole tree incl. Chromium grandkids;
  single-kill is the fallback. A `process.on("exit")` reaper is the last best-effort.
- PID-preflight runs AFTER the sweep (sweep frees PIDs first). If still saturated,
  abort with a German message pointing to `npm run test:unblock`.
- Cluster-wide worker-slot gate via Postgres advisory locks
  (`WORKER_SLOT_LOCK_BASE` in template-cache.ts) caps the SHARED worker budget so
  concurrent orchestrator runs (agent/validation harness runs test+e2e+app at once;
  CI does not) don't jointly blow the PID limit.

**Why it matters / how to apply:** Every part is fail-safe — any error/timeout
falls back to running normally (never block tests). When adding new test-server or
Chromium spawn paths, keep their markers matching the classifier, or the sweep goes
blind again. Tuning env: `EPHEMERAL_PID_PREFLIGHT` (0=off), `EPHEMERAL_PID_PREFLIGHT_RATIO`
(default 0.8), `EPHEMERAL_GLOBAL_WORKER_BUDGET` (default 4, 0=off). Pure logic pinned
in `tests/unit/ephemeral-db-process-sweep.test.ts`.
