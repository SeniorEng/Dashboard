---
name: Budget default-pots resolver (effectiveDefaultPots)
description: The eligibility-gated SSoT for default budget pots when no type-settings row exists; the raw order constant is module-private.
---

# effectiveDefaultPots is the only entry for a customer's default pots

When a customer has NO persisted `customer_budget_type_settings` row, the
default pot list (order + enablement) MUST come from
`effectiveDefaultPots(customer)` in `shared/domain/budgets.ts`. The underlying
order constant (`DEFAULT_BUDGET_POT_ORDER`) is module-private and only carries
the UNGATED raw default (§45b on, §45a/§39 off).

**Why:** The raw constant had §45b statically `enabled:true`, so Selbstzahler
customers without a settings row showed §45b active even though the write path
(`validateSelbstzahlerBudget`) forbids it (409). Display drifted from booking.
`effectiveDefaultPots` runs each pot's enablement through the existing gate
`defaultStatutoryPotEnabled` → `validateSelbstzahlerBudget` — NO second copy of
the eligibility check.

**How to apply:** Need a customer's default pots (booking cascade, invoice
split order, read-default route, AND the unified availability reader + budget
summary queries — all default-enablement fallbacks, not just the two
constant-importing files, route through this)? Call
`effectiveDefaultPots({billingType, pflegegrad})`. `pflegegrad` is accepted but
unused by the default (only §45b/billingType drives it), so passing `null` is
safe where the caller hasn't loaded Pflegegrad. Never import the raw constant —
eslint `no-restricted-imports` plus an architecture test (cross-tree guard over
server/client/shared) break CI on any direct import. §45a/§39 stay default-off
regardless of Pflegegrad; only §45b is default-on for non-Selbstzahler.
