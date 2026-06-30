---
name: test-utils request helpers need explicit /api prefix
description: tests/test-utils.ts apiGet/apiPost/apiDelete (+ *As variants) do NOT prepend /api
---
The integration request helpers in `tests/test-utils.ts` build the URL as
`${BASE_URL}${path}` — they do NOT add an `/api` prefix (only the internal
login helper hardcodes `/api/auth/login`). So every path passed to
`apiGet/apiPost/apiDelete/apiGetAs/...` MUST start with `/api/...`, e.g.
`apiGet("/api/services")`, not `apiGet("/services")`.

**Why:** a missing prefix returns 404 (route simply not found), which looks
like a routing/mount bug or a flaky server but is just the helper convention.

**How to apply:** when writing new integration tests, always prefix routes
with `/api`. A surprise 404 in `beforeAll` against a known-good route is the
tell.
