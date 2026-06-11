---
name: Budget statutory input caps
description: How §45a/§39-§42a statutory budget input limits are enforced across write paths and why the wizard gates on the enabled flag, not the amount.
---

# Budget statutory input caps (§45a / §39-§42a)

Statutory budget limits are enforced server-side on BOTH write paths and the wizard:
- `PUT /api/budget/:id/type-settings`
- `POST /api/admin/customers` (create-path)
- wizard `budgetsStepErrors` (client pre-submit)

Rules: §45a monthly ≤ `BUDGET_45A_MAX_BY_PFLEGEGRAD[pg]` (0 if PG<2), §39/§42a yearly ≤ 3.539,00 € (353900 ct).
Over-limit amount ⇒ 400 VALIDATION_ERROR. Statutory pots for Selbstzahler or §45a/§39-§42a at PG<2 ⇒ 409 (shared validators `validateSelbstzahlerBudget` / `validatePflegegradBudget`).

`clampToStatutoryMax` (`shared/domain/budgets.ts`) is the single SSoT — consumed by the read/summary path (clamps display), by the repair script, and conceptually mirrored by `validate45aAmount`/`validate39_42aAmount`.

**Why:** the budget audit found over-limit §45a/§39-§42a rows could be persisted, then the read-path clamped them silently → "Anzeige vs. Buchung" drift. One SSoT keeps write, read, and repair identical.

**How to apply:**
- The amount/PG/Selbstzahler checks MUST fire only for **enabled** pots, gated on the per-pot `enabled` flag — NOT on `value > 0`. The §39/§42a form default is 3.539 €; gating on value>0 would false-block a PG1 customer whose create payload omits that pot (the wizard zeroes disabled-pot amounts before submit, and the create route only writes type-settings rows for amounts>0).
- Disabled rows may legitimately still carry over-limit values; re-enabling via PUT re-validates the full payload, the read-path clamps, and the idempotent repair script (`server/scripts/clamp-over-limit-budget-type-settings.ts`, dry-run default + prod hostname guard) cleans existing rows via `upsertBudgetTypeSettings` (same-validFrom ⇒ in-place/transition; cbts has no UPDATE trigger).
- Known out-of-scope gap: `POST /initial-budget` and manual-correction allocation amounts enforce only the 409 gates, NOT the statutory amount caps (separate follow-up).
- **Test-fixture trap:** once the PUT type-settings route validates amounts, any fixture that DELIBERATELY seeds over-cap rows to exercise the read-path clamp (equality clamp tests, display-vs-booking property test) can no longer go through the HTTP PUT — it 400s. `setupBudgetScenario` mirrors the route's rejection (`validate45aAmount`/`validate39_42aAmount`, enabled rows only) and, when any row would be rejected, seeds DIRECTLY via `upsertBudgetTypeSettings` (storage) to bypass ONLY route validation, keeping the HTTP PUT for in-limit happy paths. §45b over-max still hard-throws (no read clamp exists).
