---
name: §45b accrual anchor needs origin stamp
description: customer-wide budget_start_date is read by ALL pots; §45b caps it origin-aware, so every writer/deleter of that anchor must keep origin correct or §45b silently pins to the Stichmonat instead of accruing from Pflegegrad start.
---

# §45b accrual anchor origin discipline

`customer_budget_preferences.budget_start_date` is **customer-wide** and read by every
pot: §45a/§39 read it RAW (canonical Pflegegrad anchor), §45b caps it in the READ path —
but ONLY when `budget_start_date_origin === 'derived_pflegegrad'`. If the column is NULL,
§45b can neither apply the Jan-1 floor nor fall back to the Pflegegrad-history anchor, so
it pins §45b to whatever Stichmonat got written → shows one month (131€) instead of the
full year-to-date accrual.

**The rule:** any write path that sets the customer-wide anchor for §45b MUST stamp
`budget_start_date_origin`:
- Auto/derived writes → `'derived_pflegegrad'` (gets floored + capped in §45b read path).
- Explicit admin preference write with a date → `'manual'` (NEVER floored; always wins,
  must not be overwritten by a later derived write).
- A derived write should only pull the anchor EARLIER (never push it later).

**Delete symmetry:** deleting a §45b initial-balance/carryover allocation that pinned the
anchor must RE-DERIVE the anchor from the earliest Pflegegrad start when origin is
derived — otherwise §45b stays stuck on the now-deleted Stichmonat. A `'manual'` anchor
stays untouched. Legacy rows written with `origin=NULL` (pre-fix) are NOT auto-healed by
the delete path; that is a separate forward-only data repair.

**Why:** the §45b cap lives entirely in the READ path (origin-aware), NOT in a pre-capped
preferences row, so §45a/§39 keep reading the ungekappten Pflegegrad anchor unchanged.
The whole mechanism collapses if a writer forgets the origin stamp.

**How to apply:** the canonical correct writer is the dedicated §45b initial-budget path
(always stamps derived + floors §45b allocation rows). The generic initial-balance writer
and the delete path must stay consistent with it. Default onboarding posts §45b with a
zero current-month amount, so it sets only the anchor+carryover, never a redundant 131€
initial_balance that would re-pin the anchor.
