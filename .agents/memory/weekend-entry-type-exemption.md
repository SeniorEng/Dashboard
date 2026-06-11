---
name: Weekend/blocker entry-type exemption must be applied in lockstep
description: Allowing a time-entry type on weekends requires changes in 3 separate places or entries become uneditable/unreachable.
---

# Weekend (and holiday) exemption for a time-entry type is a 3-place change

When a `entryType` is allowed to exist on Saturdays/Sundays (e.g. a full-day
`blocker`/absence that spans a weekend), the exemption MUST be added in **all**
of these, or the feature is half-broken:

1. **POST create** weekend guard (`server/routes/time-entries.ts`) — the
   single-day `isWeekend(...)` reject, plus the multi-day range branch must use a
   collector that does NOT skip weekends (`collectAllDatesInRange`, not
   `collectWeekdayDates`).
2. **PUT update** weekend guard (same file) — there is a SEPARATE `isWeekend`
   reject on the update path. Forgetting it makes every weekend entry created by
   the new flow **immutable** (editing notes/times → 400).
3. **Calendar UI** day cells (`client/src/features/time-tracking/components/calendar-grid.tsx`)
   — weekend/holiday `DayCell`s are `disabled` for creation. If they stay fully
   disabled, the user cannot select the day to **view or delete** the weekend
   entry. Fix: keep creation blocked, but make the cell clickable when it already
   `hasEntries`, and render the entry dot even on holidays.

**Why:** A first pass that only patched the POST path produced weekend blockers
that could be created but never edited and were unreachable in the calendar — a
silent dead-end the architect flagged. Create, edit, and "reach it in the UI" are
three independent gates.

**How to apply:** Any time you add/relax a weekend (or holiday) rule for a
time-entry type, grep `isWeekend` across `server/routes/time-entries.ts` (expect
2 hits: POST + PUT) and re-check the `DayCell` disable/visibility logic.
