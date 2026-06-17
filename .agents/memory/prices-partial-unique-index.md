---
name: prices unified table needs a partial unique index
description: The consolidated `prices` table requires a deleted_at-partial unique index keyed by scope+origin; "no unique constraints" is wrong.
---

# `prices` partial unique index (active rows)

The unified `prices` table MUST carry a partial unique index on
`(scope, origin, customer_id, service_id, valid_from) WHERE deleted_at IS NULL`
(`prices_active_validfrom_uniq` in `shared/schema/contracts.ts`).

**Why:** It is the successor of the old `customer_service_prices` index
`csp_customer_service_validfrom_active_idx`. During the price-consolidation
cutover the index lived in the (now-deleted) startup cutover file, so removing
that file silently dropped it — fresh DBs then let duplicate active prices
insert, and the private-billing e2e duplicate-active-price guard failed.
A brief that claims the `prices` table has "no unique constraints" is wrong.

**How to apply:**
- `scope` + `origin` MUST be part of the key. Without them the index falsely
  collides across origins (e.g. a `customer_service_prices` row and a
  `customer_contract_rates` row for the same customer/service/valid_from).
- `customer_id` is NULL for `scope='standard'` rows, so standard rows are not
  enforced by this index (NULLs are distinct) — that matches legacy behaviour.
- The normal "replace price" flow in `server/routes/customers/service-prices.ts`
  soft-deletes the prior same-date active row BEFORE inserting the new one, and
  also catches the PG unique violation (`isUniqueViolation` → 409). Any new
  writer to `prices` must preserve soft-delete-before-insert ordering or it will
  collide on this index.
