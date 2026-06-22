---
name: Replit runButton & Project boot composite
description: Why agent workflow tools can't fix parallel-boot overload; only a manual run-button flip commits the fix.
---

When a Repl has 2+ workflows, Replit auto-generates a parallel composite workflow
named `Project` and sets `runButton = "Project"` in `.replit`. The Run button (=
workspace boot path) then launches EVERY workflow in parallel. With heavy check
workflows (full vitest, coverage-gate, playwright/e2e) this OOMs the workspace
(`spawn EAGAIN`, killed `tsc`, preview disconnects).

**Hard constraint (verified):** the agent workflow tools cannot fix this.
- `configureWorkflow` only ADDS a workflow — and every workflow that exists gets
  appended to the `Project` composite. Recreating a workflow re-adds it.
- `removeWorkflow` DELETES a workflow entirely (no "keep but exclude from boot").
- Neither can set `runButton` to a single workflow or to a curated subset.
- With ONLY `Start application` left, `runButton` STAYS `"Project"` (composite
  just shrinks to `["Start application"]`). So you can't end on a single-workflow
  runButton while keeping the others.
- `autoStart:false` does NOT keep a workflow out of the `Project` composite.

**Why:** `runButton`/`Project` regeneration is platform-owned; `.replit` is
blocked for direct agent edit.

**How to apply:** The only durable fix that keeps all workflows is a MANUAL
one-click run-button reassignment in the Run dropdown (user action) — that
commits `runButton = "Start application"` into `.replit`. An arch test asserting
`runButton == "Start application"` (or "boot closure has no heavy commands")
will therefore be RED in the isolated agent env (can't flip) and only goes GREEN
after the user's manual commit. Don't fight the platform re-launching `Project`;
stop running heavy workflows via remove+recreate(autoStart:false) only to free
RAM for verification. See Replit-Workspace-Overload-Prevention-Plan.md.

**Update — Agent-centric UI may expose NO Run button at all:** verified via user
screenshots that the new Agent layout shows no classic green Run button in EITHER
the chat view OR the code-editor view. Replit docs confirm the only assignment
paths are (a) the dropdown next to the Run button (absent in this layout) or
(b) editing `.replit` (agent gets "Direct edits to .replit and replit.nix are not
allowed"). So the manual flip can be genuinely unreachable for some users. Last
untried in-pane gesture: CLICK (not hover) the green "Run Button" badge on the
`Project` row in the Workflows pane; hover reveals nothing. If that fails it's a
Replit UI limitation → Replit Support, not a code problem. Don't loop more
UI-gesture guesses or repeat the heavy-workflow stop every turn (platform
relaunches `Project` each boot).
