---
name: No-show km edit path
description: How an existing customer_no_show appointment's kilometers are corrected (reopen → re-document via the no-show path), and why the generic edit form is not the mechanism.
---

# No-show kilometers edit path

Since #1565, `appointments.noShowKilometers` is the SSoT for "vergebliche Anfahrt"
km. Both readers use it: the time-overview "Leerfahrten" tile
(`server/storage/time-tracking/overview.ts`) and the no-show private charge
(`server/services/invoice-data.ts`). `travelKilometers` is NOT read for no-shows.

## How km on an EXISTING no-show is corrected — reopen → re-document
1. `POST /api/appointments/:id/reopen` resets `customer_no_show → documenting`
   (a no-show has ZERO budget transactions, so nothing is reversed).
2. `POST /api/appointments/:id/document-no-show` re-writes the no-show. That
   route writes `noShowKilometers` (from its `travelKilometers` input) and
   deliberately does NOT dual-write `travelKilometers` (the old dual-write was
   the drift root, removed in #1565).

## #1757 — the reopen path had to be wired up (it was NOT reachable before)
The #1567 belief that "reopen → re-document already works, no code change" was
wrong in practice: `canReopenAppointment` only allowed `completed`, so the reopen
button never appeared for a no-show, and the detail page instead showed a generic
"Bearbeiten" button leading to a dead-end form with a misleading €-cost preview.
#1757 fixed this:
- `canReopenAppointment` now allows `customer_no_show` too (same lock/month-close
  gates as `completed`).
- Detail page (`appointment-detail.tsx`): shows reopen ("Dokumentation
  korrigieren") for no-shows via `isNoShow`, and hides the edit button
  (`showEdit = canEdit && !isNoShow`).
- The reopen `onSuccess` redirect BRANCHES on the pre-reopen status: a no-show
  goes to `/document-appointment/:id/no-show`, everything else to
  `/document-appointment/:id`.

**Why the branch matters:** after reopen the appt is plain `documenting`, which is
also a valid source for the REGULAR documentation flow. If a reopened no-show were
routed to the normal doc page, re-saving it would book Hauswirtschaft + §45b and
silently turn a no-show into a regular service appointment. The no-show-only
redirect makes the no-show doc flow the DEFAULT path after reopen.

**Known, deliberately-accepted edge (do NOT "fix" additively):** the redirect is a
default, NOT an absolute invariant. A reopened-but-not-resubmitted no-show sits in
`documenting` and — like any reopened appt — is then still regularly documentable
via an explicit "Jetzt dokumentieren" action (which converts it to `completed` +
books budget). The task DoD calls this a conscious user action, not the default
"just save" path, and explicitly DEFERS any stronger persisted-no-show-intent
guarantee (e.g. a server block in `POST /:id/document` on `noShowReason != null`)
as a separate change to clarify with Alrik first — do not build it additively.
Note: `POST /:id/document` also does not clear residual `noShowReason`/
`noShowKilometers`; inert today because all readers are status-gated.

Guard test: `tests/appointments/no-show-reopen-roundtrip.test.ts` (status stays
`customer_no_show`, 0 budget transactions after reopen + re-doc).

## Why the generic PATCH / edit form is NOT the edit path
- `canModifyAppointment("customer_no_show")` is `false`
  (`shared/domain/appointments.ts`), so `PATCH /api/appointments/:id` returns
  **403** for any field on an existing no-show.
- `edit-appointment.tsx` now also blocks `customer_no_show` up front with a
  "Bearbeitung nicht möglich" screen pointing at "Dokumentation korrigieren".
- Don't add a `travelKilometers → noShowKilometers` redirect to the PATCH handler
  to "fix" no-show km edits — it guards an unreachable path and would add a second
  no-show-edit mechanism next to reopen/re-document (Ersetzungs-Regel).

**How to apply:** correct no-show km ONLY via reopen → re-document-no-show. Keep
the two guard tests green: `tests/equality/no-show-kilometers-ssot.test.ts`
(#1565 SSoT) and `tests/appointments/no-show-reopen-roundtrip.test.ts` (#1757
no-consumption round-trip).
