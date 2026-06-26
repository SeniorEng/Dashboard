---
name: Billing review-cluster (Phase 2) SSoT reuse
description: How /admin/billing Phase-2 Pre-Commit-Review-Cluster composes existing SSoTs and what "Kasse" means there.
---
The Phase-2 Pre-Commit-Review-Cluster on `/admin/billing` (review reader +
review-cluster card) MUST compose the existing billing SSoTs, never re-implement:

- Phase-1 columns (HW/AB/km/€) AND the dimension grouping come from
  `readBillingBreakdown` + `groupBillingBreakdown(units, dim)` +
  `summarizeBreakdownRows` — the exact same path the read-only Phase-1
  breakdown card uses. ⇒ Σ review === Σ breakdown by construction; no parallel
  money/hours/km arithmetic.
- Eligibility per customer comes from `classifyBillingEligibility`
  (shared/domain/billing-eligibility) fed by the SAME readers `buildInvoiceDraft`
  uses, so the review's eligible/blocked verdict matches the real generate path.

**"Kasse" dimension = `billingType` category** (Selbstzahler / Pflegekasse
gesetzlich / privat …), matching Phase-1's "Nach Kasse" — NOT the individual
insurance provider. An earlier insurer-grouping draft was rejected in code review
for diverging from Phase-1 and ignoring the dimension contract.

**Why:** a code review rejected the first cut for (1) missing per-cluster +
grand totals, (2) incomplete mark-all, (3) a server reader that ignored the
dimension and grouped by insurer. The fix: server returns BOTH dimension
clusters pre-aggregated (`clusters.kunde` / `clusters.kasse`) plus `grandTotals`,
so the client dimension toggle needs no refetch and carries no math.

**How to apply:** generation still loops the existing per-customer
`POST /billing/generate` over the marked customerIds (clusters expose
`eligibleCustomerIds` for mark-all). The endpoint is intentionally NOT in
OpenAPI (mirrors the /breakdown sibling; gen:openapi --check stays green).
