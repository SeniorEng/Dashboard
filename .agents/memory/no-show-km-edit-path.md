---
name: No-show km edit path
description: How an existing customer_no_show appointment's kilometers are corrected, and why the generic PATCH edit path is not the mechanism.
---

# No-show kilometers edit path

Since #1565, `appointments.noShowKilometers` is the SSoT for "vergebliche Anfahrt"
km. Both readers use it: the time-overview "Leerfahrten" tile
(`server/storage/time-tracking/overview.ts`) and the no-show private charge
(`server/services/invoice-data.ts`). `travelKilometers` is NOT read for no-shows.

## How km on an EXISTING no-show is corrected
Reopen → re-document:
1. `POST /api/appointments/:id/reopen` resets `customer_no_show → documenting`.
2. `POST /api/appointments/:id/document-no-show` re-writes the no-show. That
   route writes `noShowKilometers` (from its `travelKilometers` input) and
   deliberately does NOT dual-write `travelKilometers` (the old dual-write was
   the drift root, removed in #1565).

## Why the generic PATCH is NOT the edit path
- `canModifyAppointment("customer_no_show")` is `false`
  (`shared/domain/appointments.ts`), so `validateAllUpdateRules` →
  `validateStatusTransition` makes `PATCH /api/appointments/:id` return **403**
  for ANY field on an existing no-show.
- The normal edit form (`use-edit-appointment-form.ts`) has no km field.
- The only validation-legal way `travelKilometers` reaches PATCH with no-show
  status is a `documenting → customer_no_show` transition
  (`ALLOWED_NO_SHOW_SOURCES = ["scheduled","documenting"]`), but no client flow
  does that, and generic PATCH skips the no-show charge/consumption booking that
  `document-no-show` performs.

**Why:** Task #1567 was filed on the belief that the generic edit form silently
saves no-show km to `travelKilometers`. That bug cannot occur — the edit is
rejected (403), not mis-saved, and the real path already writes the SSoT. Task
closed as already-satisfied with no code change (user decision).

**How to apply:** Don't add a `travelKilometers → noShowKilometers` redirect to
the PATCH handler to "fix" no-show km edits — it guards an unreachable path and
would add a second no-show-edit mechanism next to reopen/re-document
(Ersetzungs-Regel). The #1565 SSoT guard test lives in
`tests/equality/no-show-kilometers-ssot.test.ts`.
