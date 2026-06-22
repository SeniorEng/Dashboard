---
name: §45b carryover-Verfall — no chaining, IB decoupled
description: How §45b leftover expires (own 30.06, never rolls forward) and why the Startwert(IB) floor must not depend on the latest carryover year.
---

# §45b carryover-Verfall root fix (no chaining + IB decoupled)

Two roots produced wrong §45b displays (e.g. shows "−2.012 €" when truly ~+300 €). Both fixed inside the ONE availability SSoT (`calculateAllocated45b` read path + `ensureYearlyCarryover45b` auto path in `server/storage/budget/allocation-storage.ts`); arch test `tests/architecture/budget-single-reader.test.ts` must stay green.

## Rule 1 — carryover never chains
A leftover from source-year Y expires at **its own** 30.06.(Y+1) and is written off (`processExpiredCarryover`), it MUST NOT roll into a Y+2 carryover. So the auto-roll only carries the entitlement that arose **in the year itself**: FIFO `consumedAgainstOwnYear = max(0, netConsumed − totalCarryoverIn)`, `unused = max(0, yearAllocatedCents − consumedAgainstOwnYear)`, skip when `unused ≤ 0`.
**Why:** carried-in money double-rolling re-credited "used" budget every year, inflating availability into nonsense (and the symmetric over-subtraction showed as a large negative).
**How to apply:** any new carryover-materialization path must subtract `totalCarryoverIn` before deciding what rolls forward; never treat a carryover row's full amount as roll-eligible.

## Rule 2 — Startwert(IB) floor decoupled from latest carryover year
The IB expiry floor (`ibFloorYear`) is bound to `expiryFloorAnchorYear` (H1 ⇒ prior year, from July ⇒ current year), **not** to `latestCountedCarryoverYear`. The `allocStart` shift uses only **valid** (not-yet-expired) carryovers (`latestValidCarryoverYear`). To avoid double-counting a carryover and the IB of the same source year, use **targeted** supersession: `supersededIbYears = { validCarryover.year − 1 }` (carryover for target T covers source T−1) — drop exactly that IB, keep all others. `excludedSpecialAllocationIds` symmetry (allocated ↔ consumed) preserved.
**Why:** flooring IB by the latest carryover year let an EXPIRED/stale carryover displace a perfectly valid in-window initial_balance, zeroing legit budget.
**How to apply:** when adding any IB/carryover counting logic, key supersession off the carryover's own source year, never off "the latest carryover present".

## Scope / out-of-scope
Forward-only: existing wrongly-rolled/expired carryover rows are NOT auto-migrated — their cleanup is a GoBD-pflichtiger operator storno. Read-only drift report: `server/scripts/verify-45b-carryover-verfall.ts` (db.select + SSoT read only) flags (A) negative raw availability, (B) expired-active carryover without write_off, (C) chaining suspicion (active carryovers for consecutive years).
