---
name: Budget unified Available reader + single-reader guard
description: How the one budget Available reader is enforced and the known §45b shadow-read drift.
---

# Budget unified Available reader (GF Phase 4)

There is ONE budget availability reader: `readUnifiedBudgetAvailability` in
`server/storage/budget/unified-reader.ts`. It computes
`Available = Allocated − HoldsActive(=0 until Phase 5) − ConsumedNet`, capping
§45a/§39 via `computeCapSlot`. `getAvailableForDate` (import-availability.ts) is a
thin wrapper: it runs `syncCarryoverAndExpiry` (the only write) then delegates to
the pure (read-only) unified reader. Keep the reader read-only so the shadow-read
soak can run prod-safe.

## Single-reader architecture guard
`tests/architecture/budget-single-reader.test.ts` forbids new parallel readers by
scanning for **dot-access** `.netUsedInWindowCents` (a consumer deriving
availability), NOT the field declaration/producer.
**Why:** producers (`cap-calculator.ts` `computeCapSlot`, returns the field with no
leading dot) must not be on the allowlist; only consumers are. The test strips `//`
and `/* */` comments first, otherwise a doc mention like
`computeCapSlot.netUsedInWindowCents` (in history-aggregation.ts) false-positives.
**How to apply:** allowlist = {unified-reader, cap-math (`input.netUsedInWindowCents`),
summary-queries (legacy, kept until Phase 6)}. A new file that reads
`x.netUsedInWindowCents` to build its own availability will (correctly) fail the test.

## Known §45b shadow-read drift (transparent, Phase-6 job)
Legacy §45b summary subtracts net ledger ALL-TIME incl. `manual_adjustment`; the
unified reader (= getAvailableForDate math) subtracts net up-to-asOf-date EXCL.
`manual_adjustment`. So customers WITH `manual_adjustment` drift (the soak flags them);
customers without it are zero-drift. §45a/§39 are
structurally identical (both via computeCapSlot) ⇒ always zero drift. Do NOT claim
fleet-wide zero drift. Legacy stays SSoT until the soak window is clean — the
`shadow-read-soak.ts` report (read-only, exit 0/1) is the Phase-6 deletion gate.
