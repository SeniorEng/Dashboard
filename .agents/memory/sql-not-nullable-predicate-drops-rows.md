---
name: SQL NOT on nullable predicate drops rows
description: Negating a filter that can yield SQL-NULL silently drops the NULL-valued rows; COALESCE the inner predicate.
---

# SQL `NOT (...)` over a nullable predicate silently drops rows

When a list/count filter is expressed as the negation of a positive predicate, and any
input column of that predicate can be NULL, the negation evaluates to SQL-NULL for those
rows, which fails the `WHERE` clause — so those rows silently disappear from the result.

**Concrete:** the customer lifecycle filter (Task #1194) classified `gekündigt` as
`(contract_end IS NOT NULL OR contract_status = 'terminated')` and `laufend` as
`NOT (that)`. For active customers with no (latest) contract, `contract_status` is NULL,
so `false OR NULL => NULL`, then `NOT NULL => NULL` ⇒ those intake/no-contract customers
fell out of `laufend` entirely (and out of the lifecycle-counts endpoint that reuses the
same filter). The pure JS classifier in `shared/domain/customers/lifecycle.ts` was fine;
only the SQL mirror in `server/storage/customer-management.ts` had the bug.

**Why:** SQL three-valued logic. `NULL` in a boolean WHERE position is treated as "not
true", and `NOT NULL` is still `NULL`, never `true`.

**How to apply:** whenever you write `NOT (<predicate over a nullable column>)` (or rely
on the predicate being a clean boolean), wrap it: `COALESCE(<predicate>, false)`. Then
both the positive filter and its negation partition the rows exactly, and counts stay
additive (`a + NOT a == total`). Add an integration test that seeds a row with the
NULL column to lock the partition.
