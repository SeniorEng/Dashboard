---
name: mark_task_complete platform-step failures
description: When mark_task_complete fails at rebase/checkpoint (not validation), it's infra — don't loop retries.
---

# mark_task_complete can fail at platform steps BEFORE validation runs

`mark_task_complete` runs platform-managed steps (git `rebaseOnMainRepl`, then a
`checkpoint_activity`) **before** it ever runs project validation. When one of
those steps fails you get a result like:

- `error: rebase_on_main_activity failed ... UNAUTHENTICATED` (git fetch main-repl), or
- `error: checkpoint_activity failed ... START_TO_CLOSE timeout`
- with `validation_run_result: None`, `validation_status: None`, `task_marked_complete: False`, `rebase_has_conflicts: False`.

**Key tell:** `validation_run_result: None` means validation never ran — the failure
is platform infrastructure, NOT your code and NOT a validation failure.

**Why:** these steps depend on Replit's git/checkpoint backend, which can be
transiently unauthenticated or overloaded. A `checkpoint_activity` timeout is the
platform snapshotting the repl, not your build.

**How to apply:**
- Do NOT run git manually to "fix" it (version control is platform-managed).
- A couple of retries are fine for transient/auth errors (cause often differs each time).
- Reducing workspace size (clearing stale `.local/test-client-*` / `test-server-*`
  build artifacts) is a reasonable hypothesis for checkpoint timeouts, but if the
  timeout repeats **identically after** the cleanup, size is NOT the cause — stop
  retrying and report the platform blocker to the user.
- The actual task can be fully complete + verified (typecheck/lint/coverage green)
  even while completion is blocked at the checkpoint step.
