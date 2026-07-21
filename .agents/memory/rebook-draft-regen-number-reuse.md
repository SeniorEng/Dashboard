---
name: Rebook draft-regen reuses discarded invoice NUMBER
description: Why whole-month/draft rebook tests must assert on invoice ID, not invoice number, after draft discard+regen.
---

When a draft (`status='entwurf'`) invoice is discarded and regenerated during a
budget rebook (draft-invoice-regen flow), the regenerated invoice REUSES the
discarded invoice's NUMBER (German gapless numbering / lückenlose Nummernkreis is
preserved on purpose). The old invoice row is hard-DELETEd (FK cascade), so a new
row with a NEW id but the SAME human-facing number appears.

**Why:** GoBD/§14 gapless numbering — discarding a not-yet-issued draft must not
burn a number. So the number is recycled, only the row identity changes.

**How to apply:** Tests verifying "the draft was re-created after rebook" must
assert the OLD invoice ID is gone and a NEW invoice ID exists, NOT that the number
changed (it won't). To produce a regen-able draft at all, seed a signed Sammel-LN
first so `generateInvoiceCore` has documented+signed appointments to bill.
