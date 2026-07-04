---
name: matchRows duplicate-match test trap
description: Why an Excel-import integration test can silently produce updated:0 / billedProtected undefined, and how to avoid it.
---

**Symptom:** An import integration test seeds an existing appointment, imports a row
for it expecting an `update`, but gets `updated: 0` (or `billedProtected` comes back
`undefined` instead of `true`). The row was never matched to the existing appointment.

**Cause:** matchRows only treats an imported row as a duplicate/upgrade of an existing
appointment when the appointment's START time equals the fixture's start time. A
different start time = no match = no `existingAppointmentId` = the `update`/`upgrade`
branch never runs and no protection tag is applied.

**How to apply:** In such tests, give the seeded appointment the SAME start time as the
fixture row, and force the "needs mutation" diff on a different field (e.g. end
time / duration), not on the start time.
