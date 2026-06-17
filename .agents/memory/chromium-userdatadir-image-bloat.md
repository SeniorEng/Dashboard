---
name: Chromium user-data-dir bloats the deploy image past 8 GiB
description: Why publish fails with "image size is over the limit of 8 GiB" and how to fix it
---

# Chromium user-data-dir bloats the deployment image

**Symptom:** Replit publish (autoscale / cloud_run) fails at the very end with
`error: image size is over the limit of 8 GiB`. This is NOT a build-phase or
DB-migration failure — `npm run build` is green and the schema diff is clean. The
build log shows the size error AFTER "Created Repl layer".

**Root cause:** `server/services/pdf-generator.ts` launches Puppeteer WITHOUT a
`userDataDir`, so Chromium defaults to `$HOME/.config/chromium`, which resolves
INSIDE the workspace (`/home/runner/workspace/.config/chromium`). Heavy PDF
rendering + tests grow that dir to several GiB. The whole workspace is packed
into the deploy image, so the runtime cruft pushes the image over the 8 GiB
Cloud Run limit. (Last good publish was small; it crept over the limit later.)

**How to diagnose:** use the deployment skill's `listDeploymentBuilds` +
`getDeploymentBuild(id)` to read the REAL build-log tail — the user only sees a
generic "build failed". Then `du -sh ./* ./.[^.]*` in the workspace root; the
giant offender is usually `.config/chromium` (and to a lesser degree
`.cache/ms-playwright`, `.local/test-client-*`).

**Immediate fix:** `rm -rf .config/chromium` (regenerates on next launch). That
alone dropped the workspace from ~9+ GiB to ~4 GiB. Publish right after, before
it regrows.

**Durable fix (not yet applied):** set Puppeteer `userDataDir` to an ephemeral
path OUTSIDE the workspace (e.g. under `os.tmpdir()`), so Chromium profile data
never lands in the deployable workspace again. Touches the critical invoice/PDF
path — change carefully and test PDF rendering.
