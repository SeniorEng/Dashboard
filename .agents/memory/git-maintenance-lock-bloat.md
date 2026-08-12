---
name: Stale maintenance.lock silently kills git housekeeping
description: Why a long-lived repl's .git explodes into loose objects, and the rules for safely retiring throwaway agent branches.
---

A leftover `.git/objects/maintenance.lock` makes **every** subsequent `git maintenance`
run exit immediately and silently. Nothing logs, nothing warns — loose objects simply
stop being packed. A hard container kill mid-maintenance is enough to create it.

**Why:** Nothing in the git UI or in git's own output points at the lock; the only
visible symptom is that workspace git operations get slower and slower as loose objects
and per-run agent branches pile up. It is easy to misread as a broken git connection or
a bad remote.

**How to apply:**
- Recognise it from the loose-object count plus the mere existence of an old
  `maintenance.lock`. Don't chase the git connection, the remotes, or the history.
- Throwaway agent branches end on checkpoint commits ("Saved your changes before
  starting work") whose content reaches `main` under a different SHA, so a large share
  have no exact tree match among the surviving refs. That is expected and is **not**
  evidence of unmerged work — but it is equally not evidence that deleting is safe.
  Age is never a proof either: a long-dormant branch looks exactly like a dead one.
  Delete only what is provably reachable or tree-identical elsewhere; park the rest
  under a real backup ref namespace (a ref shields its objects even from
  `gc --prune=now`) and make expiry an explicit human action.
- Never touch a checked-out branch, whatever its age — resolve `HEAD` *and* the branches
  of linked worktrees first, or a cleanup run leaves a working copy with a dangling HEAD.
- Don't expect a tiny repo afterwards: a pre-existing pack is usually only a partial
  pack, and the bulk of *reachable* history is what was lying around loose. What remains
  is committed binaries; shrinking past that needs a history rewrite.
- The cleanup only affects the `.git` of the environment it runs in. Object store and
  local branches are not versioned content and do **not** travel through a task merge —
  a task agent can only reach the main repl via the post-merge hook.
