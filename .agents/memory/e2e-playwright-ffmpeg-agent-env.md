---
name: e2e playwright ffmpeg in agent env
description: Why Playwright e2e specs fail at browserContext.newPage in the agent env and how to unblock.
---

Running any Playwright e2e spec locally in the agent env can fail at `browserContext.newPage`
with `Executable doesn't exist at .cache/ms-playwright/ffmpeg-1011/ffmpeg-linux`.

**Why:** `playwright.config.ts` sets `video: "retain-on-failure"`, which requires Playwright's
bundled ffmpeg. The Nix Chromium is present, but ffmpeg is not installed by default here.

**How to apply:** Before running a spec manually, run `npx playwright install ffmpeg` once.
This is an agent-env harness gap, NOT a test bug — the failure is unrelated to the spec's logic
and does not reproduce in CI (which installs browsers via `npx playwright install --with-deps`).
