---
name: SSoT boot-gate ordering
description: A boot gate that aborts startup on an empty critical SSoT must run AFTER the migrations that fill/recover that SSoT — both before httpServer.listen.
---

# Critical-SSoT boot gate must run AFTER its SSoT-fill/recovery migrations

The boot-time gate that aborts production startup on an empty critical SSoT table
(e.g. the consolidated `prices` table) MUST be sequenced AFTER the startup
migrations that populate/recover that SSoT — and both must run before
`httpServer.listen` in the boot IIFE, NOT inside the post-`listen` startup-tasks
callback.

**Why:** A publish once deadlocked because the gate ran pre-`listen` while the
recovery migration ran post-`listen` (inside the startup-tasks callback). In prod
the gate saw the empty table and called `process.exit(1)` before recovery could
ever run, so the table stayed empty forever — every boot died and the publish
could never succeed. The gate was "working as designed" yet ordered ahead of its
own fix.

**How to apply:** When you add a boot gate that asserts a data invariant, place
the data-establishing migrations immediately before it in the same pre-serving
phase. Keep the fill/recovery migrations fault-isolated (try/catch + log) and keep
the gate non-fault-isolated (let it exit) — so a genuinely empty SSoT still fails
the deploy, but the recovery always gets its chance first. Any ledger-gated
migration moved into this earlier phase needs its ledger table ensured first
(idempotent `CREATE TABLE IF NOT EXISTS`).
