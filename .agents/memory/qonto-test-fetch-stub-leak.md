---
name: Qonto test global.fetch stub leak
description: Why request-level (apiPost/apiDelete) tests fail with a CSRF/login error when placed after fetch-stubbing suites in the same file.
---

Several Qonto suites in `tests/billing/qonto-multi-iban-sync.test.ts` replace
`global.fetch` with a Qonto-API mock via `vi.stubGlobal("fetch", ...)`. Not all
of them restore it (the multi-iban block's afterAll unstubs; the #1605 override
block does NOT).

The request-level helpers in `tests/test-utils.ts` (`apiPost`, `apiDelete`,
`getAuthCookie`) use `fetch` to hit the real running app-server. If a suite that
calls these runs AFTER a leaked fetch-stub, login hits the mock instead of the
server, gets no `Set-Cookie`, and fails with
`"CSRF-Token nicht in Cookies gefunden"` — a misleading error that looks like an
auth/CSRF bug but is really a leaked mock.

**Rule:** any describe block that uses the real HTTP routes (apiPost/apiDelete)
must `vi.unstubAllGlobals()` in its own `beforeAll` when it shares a file with
fetch-stubbing suites — don't rely on sibling suites to restore fetch.

**Why:** test order in a single file is sequential; a leaked global stub silently
poisons every later suite that assumes real `fetch`.
