---
name: Publish fails "image size over 8 GiB" — workspace dev-cruft packed into the image
description: Why Replit publish fails with the 8 GiB image limit and the durable .replitignore fix
---

# Publish fails: "image size is over the limit of 8 GiB"

**Symptom:** Replit publish (autoscale / cloud_run) fails at the very end with
`error: image size is over the limit of 8 GiB`, right after `Created Repl layer`.
The UI only shows a generic "deployment build failed". This is NOT a build-phase
or DB-migration failure — `npm run build` is green and the schema diff is clean
& additive.

**How to see the real cause:** use the deployment skill's `listDeploymentBuilds`
+ `getDeploymentBuild(id)` (via code_execution) and read the LAST log lines —
that's where the size error appears. Then `du -sh ./* ./.[^.]*` at the workspace
root to find the bloat.

**Root cause:** the ENTIRE workspace is packed into the image's "Repl layer".
Dev/test cruft accumulates there over time. Worst offenders seen:
- `.config/chromium` (5.4 GiB!) — Puppeteer launched WITHOUT a `userDataDir`, so
  Chromium defaulted to `$HOME/.config/chromium`, i.e. INSIDE the workspace.
- `.local` (agent + per-test client dirs), `.cache/ms-playwright`, `.git`, `tmp`.

**Key lesson:** deleting `.config/chromium` alone is NOT enough. Even at a 4.0 GiB
workspace the image stayed > 8 GiB, because the base image (Nix `modules` incl.
`java-graalvm22.3` + `python-3.11` + `postgresql-16`) is itself several GiB and
adds to the Repl layer.

**Durable fix (applied):**
1. **`.replitignore` at repo root** — the documented official way to exclude
   files/folders from the deployment image. Exclude `.git/ .local/ .cache/
   .config/ tmp/ test-results/ coverage/ reports/ .stryker-tmp*/ tests/ e2e/`
   etc. None are needed by the prod runtime (`node dist/index.cjs`) or the build
   (`npm run build`). Drops the Repl layer from ~4.0 → ~0.9 GiB. (`.gitignore` is
   NOT used by the deploy image; `.replitignore` is the lever.)
2. **Puppeteer `userDataDir` → `os.tmpdir()/careconnect-chromium-<pid>`** in
   `server/services/pdf-generator.ts` (per-process unique to avoid Chromium
   SingletonLock across parallel app-server processes). Keeps the profile OUT of
   the workspace permanently. Note: `scripts/smoke-chromium.ts` and Playwright
   (`playwright.config.ts`) launch their own Chromium and still write
   `.config/chromium` in dev — harmless because `.config/` is in `.replitignore`.

**If it still fails after `.replitignore`:** consider trimming unused Nix
`modules` from `.replit` (GraalVM is the biggest), but that also affects dev
tooling (Java e-invoice validation, ephemeral-PG tests) — coordinate first.
