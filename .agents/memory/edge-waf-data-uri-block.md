---
name: Edge WAF blocks data: URIs in request bodies
description: Why signature POSTs got a bare HTML 403 on the published app and the symmetric strip/restore transport fix.
---

# Edge WAF blocks `data:` URIs in request bodies

On the **published** app (behind the Replit/Google edge), any POST whose body contains the literal
`data:image/...;base64,` data-URI is rejected with an **HTML `403`** by the edge WAF **before the
request reaches Express**. Decisive A/B proof via live prod curl: identical base64 with the `data:`
prefix → text/html edge 403 (no `Google Frontend` server header); same base64 *without* the prefix →
reaches the app. Body **size** is not the trigger (9 MB plain/base64 bodies pass fine) — only the
`data:` token is.

Digital signatures are the only place CareConnect sends an image inside a JSON body, so every
"Unterschrift bestätigen" click failed with a bare `HTTP 403:` toast. This is invisible in
dev/preview (no WAF) — only reproducible against the published domain.

**Fix (symmetric, central):** `shared/utils/signature-transport.ts` → `transformSignatureFields(body, "strip"|"restore")`.
- Client (`apiRequest` in `client/src/lib/api/client.ts`) strips the `data:...;base64,` prefix from an
  allow-list of signature field keys before `fetch`, so the wire body carries only raw base64 (WAF-safe;
  base64 alphabet can't contain `data:` or `<`).
- Server (`server/index.ts` middleware, after `cookieParser`, before routes) restores the full data URL
  for `/api` bodies, so all validation/hashing/storage/PDF see the original format unchanged.

**Why:** keeps the persisted signature format + integrity hash + PDF output byte-identical; backward
compatible (restore is a no-op on already-prefixed values, so legacy/internal callers and integration
tests that send full data URLs still pass).

**How to apply:** any NEW write path that ships an image/data-URI in a JSON body to the published app
must route through `apiRequest` (or call the strip helper) — a raw `fetch`/multipart sender bypasses it
and will hit the edge 403. Add new image field names to the allow-list in `signature-transport.ts`.
