---
name: Test signature fixtures must be real PNGs
description: Why the 8-byte data:image/png stub breaks any test that signs a service-record / appointment.
---

# Test signature fixtures must pass signature-validation

Service-record / appointment signing endpoints run `analyzeSignatureImage`
(`server/lib/signature-validation.ts`, added by Task #749) which hard-rejects
anything below `MIN_SIGNATURE_DECODED_BYTES` (250 decoded bytes), under
40×20 px, or with < 50 non-zero IDAT bytes.

The old fixture `"data:image/png;base64,iVBORw0KGgo="` decodes to only the
8-byte PNG magic → deterministic `too_small_payload` (`EMPTY_SIGNATURE`).
Any test whose setup signs (`POST /api/service-records/:id/sign`,
`/document`, public-signing) will fail in *setup* if it uses such a stub.

**Why:** Task #749 (RE-2026-0010) blocks empty/corrupt signatures at the API
boundary; older concurrency-test fixtures predated it and silently went red in
setup, masquerading as flaky races.

**How to apply:** Use `tests/helpers/signature.ts` →
`VALID_SIGNATURE_DATA_URL` / `makeValidSignatureDataUrl()`. It builds a 64×40
RGBA PNG with *varying* pixel bytes (uniform fill compresses below 250 bytes
and still fails). Don't hand-roll tiny base64 stubs for signing fixtures.
