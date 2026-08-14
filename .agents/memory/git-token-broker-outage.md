---
name: Replit Git token-broker outage (Git pane dead, push via script)
description: How to recognise that Replit's credential helper is down rather than the repo being broken, and which push path still works
---

# Git pane "beeps and does nothing" == token broker down, not a repo problem

Replit's credential helper behind `GIT_ASKPASS` (`replit-git-askpass`) can fail
while the GitHub connection still *looks* connected. When it does, every request
hangs ~30 s and returns nothing (or the literal text `GitHub token request timed
out`). Git forwards that as the password, GitHub answers `remote: Invalid
username or token`, and the workspace Git pane (Sync/Pull/Push) becomes inert —
it also refuses to refresh or delete the GitHub connection.

**Why this is worth remembering:** the failure mode impersonates a repository
problem (divergent history, stale lock, broken remote) and invites a force-push
"reconcile" that is both unnecessary and destructive. Two independent traps make
the false diagnosis look confirmed:

- **A public repo keeps reading fine.** Anonymous `git fetch` / `ls-remote` /
  unauthenticated API still work, so the pane keeps rendering ahead/behind
  counters — from a stale cache. Those numbers are not a state, and they have
  been wildly wrong (e.g. "10 ↓ 2 ↑" for a repo that was 0 behind / 1 ahead).
- **Unauthenticated GitHub API reads are CDN-cached.** Right after a *successful*
  push, an anonymous `GET /repos/…/git/refs/heads/main` can still return the OLD
  sha for minutes, which reads like "the push silently failed". Always read back
  **with a token** (or `git ls-remote`) before concluding anything.

**How to distinguish it** from the stale-`subrepl-*`-remotes failure (the other
cause of an unusable Git pane): that one errors *immediately* with
`Failed to authenticate with the remote (UNAUTHENTICATED)`; the broker outage
**hangs ~30 s first**. Confirm directly:
`timeout 35 replit-git-askpass "Password for 'https://x@github.com': "` —
30 s + empty/`timed out` output is the broker, and nothing about the repo.

**How to apply:** don't try to fix it in the repo, and don't touch history. The
sync script authenticates straight from the secrets and bypasses the broker
entirely, so it keeps working while the pane is dead — it is the substitute push
path, and it also self-reports the broker outage before pushing. Repairing the
broker/connection itself is platform-side (reload workspace, re-link the GitHub
account, else Replit support). Runbook: `docs/ci-pipeline.md` →
"Token-Broker-Ausfall".

**Token hygiene that follows from this:** a token that answers `401/403` on a
single read-only API call cannot authenticate a push either, so probe first and
skip dead tokens instead of burning a full push attempt (plus a confusing error
dump) on them — and always name in the output *which* token actually worked.
