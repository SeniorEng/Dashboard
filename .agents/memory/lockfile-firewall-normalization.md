---
name: package-lock firewall-URL normalization
description: Why the committed package-lock.json must be normalized off the Replit package-firewall, and why only a postinstall hook (not .npmrc) can do it durably.
---

# package-lock.json firewall-URL normalization

The committed `package-lock.json` must contain `https://registry.npmjs.org/`
`resolved`/tarball URLs, never `http://package-firewall.replit.local/npm/…`.
The firewall host resolves ONLY inside Replit, so any firewall URL in the
lockfile makes GitHub-CI `npm ci` die with `EAI_AGAIN` and takes down every job.

**Why `.npmrc` / `replace-registry-host` can't fix it at the registry layer:**
- In Replit `npm_config_registry` (env var) points at the firewall and
  **overrides** any project `.npmrc registry=` (env beats project npmrc in npm's
  config precedence).
- The firewall mirror's *packument itself* serves `dist.tarball` URLs already
  rewritten to the firewall host — so npm writes firewall URLs no matter what
  `replace-registry-host` is set to (that flag only swaps the *default-registry*
  host, not arbitrary tarball hosts baked into a packument).
- Net: whenever the lockfile is regenerated in Replit, it re-acquires firewall
  URLs. There is no pure-config way to prevent the write.

**The fix (durable, at source):** a `postinstall` hook
(`scripts/normalize-lockfile.mjs`, wired in `package.json`) string-replaces
`http://package-firewall.replit.local/npm/` → `https://registry.npmjs.org/` in
`package-lock.json` after every install. Identical tarballs ⇒ integrity hashes
stay valid. It's idempotent and never fails the install (try/catch → exit 0).
`registry.npmjs.org` is reachable from BOTH Replit and CI (verified HTTP 200),
so the normalized URLs work everywhere. Local Replit installs are unaffected:
fetch still goes through the firewall (env var), only the lockfile is rewritten
afterward.

**How to apply:** Do NOT reintroduce a per-step `sed` in `.github/workflows/ci.yml`
to paper over a dirty lockfile — that's the band-aid this replaced. If CI ever
fails on firewall URLs again, check the postinstall ran (it doesn't run with
`npm ci --ignore-scripts`). The `.npmrc registry=` is only a repo-default for
non-Replit envs (no env var there); it is NOT the mechanism that keeps the
lockfile clean.
