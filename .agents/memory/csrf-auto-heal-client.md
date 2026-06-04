---
name: CSRF auto-heal in API client
description: Why state-changing requests can 403 on CSRF and how the client self-heals; pitfalls for new write paths.
---

# CSRF auto-heal in the API client

The session cookie (`careconnect_session`) is `sameSite:"lax"` while the CSRF
cookie (`careconnect_csrf`) is `sameSite:"strict"`, both ~12h. A user can land on
an authenticated page (lax session sent on cross-site top-level nav, e.g. a
WhatsApp reminder link) while the strict CSRF cookie is expired/absent. A
state-changing request then gets the app's JSON 403 `CSRF_TOKEN_MISSING` /
`CSRF_TOKEN_INVALID`.

**Rule:** the API client (`apiRequest`) auto-heals this exactly ONCE: on a CSRF
403 for a non-safe method, force-fetch `/api/csrf-token` (ignore the stale
cookie), update the `x-csrf-token` header, retry once. Guarded by a
`csrfRetried` flag so there is no loop.

**Why it's safe (don't "tighten" it away):** a cross-site attacker can read
neither `/api/csrf-token` (SOP/CORS) nor the cookie, so they can't complete the
refresh+retry; only same-origin clients benefit. Retrying is side-effect-safe
because the CSRF middleware rejects (403) *before* business handlers run.

**How to apply:** any NEW client write path must inherit this. `apiRequest`
(api.post/put/patch/delete) already has it; `postFormData` does NOT — if a future
upload/sign flow uses it, add the same one-time auto-heal there.

**Debugging note:** a generic `text/html` "403 Forbidden" (short content-length)
from prod is the EDGE abuse-throttle (tripped by rapid/large bursts), NOT the app
CSRF 403. Don't conclude "request never reached Express" from it — check the
request-logger for the JSON `403 CSRF_*` first. Don't burst-probe prod.
