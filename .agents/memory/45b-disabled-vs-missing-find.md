---
name: §45b disabled-vs-missing find trap
description: Selecting the §45b (statutory pot) setting row with `&& s.enabled` in the find conflates DISABLED with MISSING and re-triggers the default-enable fallback → false "active"/overrun budget warning.
---

# §45b disabled-vs-missing find trap

Readers that gate §45b activation must locate the setting row WITHOUT an
`&& s.enabled` predicate in the `find(...)`, then decide activation through the
one SSoT helper `resolve45bActivation({setting, billingType, asOfDate})` in
`shared/domain/budgets.ts` (returns `{enabled, inRange, active}`;
`active = enabled && inRange && non-selbstzahler`).

**Why:** `find(s => budgetType==='45b' && s.enabled)` returns `undefined` for a
row that EXISTS but is explicitly disabled, which is indistinguishable from
"no row at all". The no-row branch falls back to `effectiveDefaultPots` /
default-enable, so a statutorily-eligible non-Selbstzahler customer who has
§45b turned OFF gets treated as active → false soft banner "Dieser Termin
überschreitet das verfügbare §45b-Budget in seinem Monat." (real prod hit:
customer "Seidel, Wolfgang").

**How to apply:** any new/edited reader that answers "is §45b active?" must
route through `resolve45bActivation`, never re-inline the enabled/inRange math.
Row selection is safe because active type-settings are pre-filtered to one
valid row per date (append-only phase transitions close the old row). Caution:
not every enabled-filtered §45b `find` is an activation gate — at least one
feeds an allocStart-shift fallback (allocation-storage) and is intentionally
NOT an activation decision; don't blindly rewrite it, confirm the field it
feeds first.
