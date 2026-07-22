---
name: Rebook-Target eligibility SSoT
description: How "is this pot a valid rebook target?" is resolved (preview vs execution) and the forDate/forEdit existence-gate pattern.
---

# Rebook-Target eligibility SSoT

"Ganzen Monat umbuchen" (rebook) preview and execution MUST derive pot
eligibility from ONE helper (`resolveRebookPotEligibility` in
`server/storage/budget/rebook-storage.ts`), not two parallel checks. Preview
uses stichtag = monthEnd; execution uses per-line txDate — same function,
different stichtag only (that date difference is intended #1785 semantics, not
drift).

The helper reads budget type-settings TWICE and combines them:
- `forDate`@asOfDate = window-filtered row, INCLUDES disabled rows → the
  *effective* row at that date.
- `forEdit` = latest intent row per pot regardless of window → a pure
  *existence* gate (`configuredEver`).

Decision order per pot (from `resolveEffectivePotConfig`, shared/domain/budgets.ts):
1. no row at date BUT configuredEver → skip "nicht gültig" (NO default fallback).
2. else disabled row present → "nicht aktiviert".
3. window (validFrom/validTo) checks.
4. else → entitlement-gated default (§45b default-active for Pflegekasse; §45a/§39 default-off).

**Why:** reading only `setting?.enabled` made a MISSING row look deactivated, so
default-derived Pflegekassen customers (e.g. #202) saw statutory pots falsely as
"nicht verfügbar". The existence gate distinguishes "never configured → default"
from "configured but out-of-window → skip", preserving #1785 while fixing #1837.

**How to apply:** any new rebook/target-validity path funnels through this one
helper. A DEACTIVATED persisted row must stay unavailable on BOTH paths
(execution: single-rebook throws the reason; month-rebook skips the line with it).

**Known divergence (see follow-up):** cascade booking
(`consumption-engine.ts`) does NOT apply the forEdit existence gate — a pot
configured only outside the booking-date window falls back to default in cascade
but is rejected as a rebook target. Matches pre-existing cascade behavior (no
regression) but is an inconsistency in "is pot X usable at date Y?".
