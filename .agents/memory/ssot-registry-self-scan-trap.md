---
name: SSoT-Registry self-scan trap & allowlist drift gap
description: Machine-readable SSoT registry lives in shared/ and is scanned by the very tree-guards it documents; two durable gotchas.
---

# SSoT-Registry (`shared/ssot-registry.ts`) — two durable gotchas

The machine-readable SSoT catalog is a dependency-free `shared/` module that maps each
fachliche Frage → canonical function(s) + the architecture guard(s) that enforce it +
each guard's named allowlist + allowlist contents. Guard tests source their allowlists
FROM it via `ssotGuardAllowlist(id, allowlistName)` (single source of truth). WHO (the
registry, static data) is kept separate from HOW (detector regexes stay in each guard).

## 1. Self-scan trap: registry PROSE must not reproduce a forbidden formula
Because the registry file sits inside the same `shared/`+`server/` tree the tree-walking
guards scan, any registry text that literally reproduces a pattern a guard forbids trips
the REAL guard — not the meta-guard.

**Concrete hit:** the `private-payment-eligibility` entry's `question` string contained
the literal `(acceptsPrivatePayment || selbstzahler)`. That is exactly the hand-rolled
formula the A5 guard in `tests/architecture/ssot-imports.test.ts` forbids outside
`shared/domain/budget-selbstzahler-validator.ts` (A5 runs its regex over
`stripComments(content)`, so a string VALUE trips it; only a `//`/`/* */` comment would be
stripped). Fix = reword the prose to not reproduce the formula (kept a comment explaining
why). **Why mitigation-by-construction is correct:** do NOT duplicate detector regexes in
the meta-guard — the real guard already catches reintroductions. Keep registry questions
formula-free; describe in words.

## 2. Allowlist drift gap (accepted for AP1 seed scope, close in next AP increment)
For entries whose guard is NOT yet converted to call `ssotGuardAllowlist` (e.g.
`CAP_SLOT_IMPORT_ALLOWLIST`, `CASCADE_CALL_ALLOWLIST`, `DOCUMENTED_PREDICATE_ALLOWLIST` in
`ssot-imports.test.ts`), the registry holds a BYTE-COPY of the allowlist while the guard
still hardcodes its own ⇒ two sources of truth per allowlist. The meta-guard only checks
the allowlist NAME appears textually in the guard file; it never compares CONTENTS, so the
copies can diverge silently and stay green.
**How to close:** in a future AP increment, strengthen the meta-guard so that for guards
not yet calling `ssotGuardAllowlist`, every registry allowlist path literal must appear
(textual containment) in the guard test file — until conversion removes the duplicate.
Secondary smaller gap: the "≥2 consumers" check is aggregate-only; it doesn't verify a
converted guard calls `ssotGuardAllowlist` with the matching entryId/allowlistName pair.
