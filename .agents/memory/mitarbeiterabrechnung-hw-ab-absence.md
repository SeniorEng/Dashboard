---
name: Mitarbeiterabrechnung HW/AB buckets + absence blocks
description: How the payroll overview splits recorded hours into Lexware HW/AB pots and reconstructs absence Von–Bis blocks
---

## HW/AB Lexware split (replaced single "Erfasst")
The `/admin/mitarbeiterabrechnung` overview shows TWO recorded-hours columns, not one:
- **HW** = Hauswirtschaft + Erstberatung + Anfahrtszeit + Leerfahrten + Sonstiges (pure work).
- **AB** = Alltagsbegleitung.

`erfasst.hw` in `payroll-hours.ts` MUST NOT include Urlaub/Krankheit/Feiertage — those are tracked
separately (as days + hours) and are NOT part of the recorded-hours sum. `sumHours` in the route =
`hw + ab` only (Feiertage/Urlaub/Krankheit excluded).

**Why:** Lexware payroll import expects exactly these two work buckets; folding absences into HW
double-counted paid time. The drill-down groups line items under HW/AB/Separat with subtotals that
equal `row.erfasst.hw` / `row.erfasst.ab` by construction (one SSoT feeds overview=drilldown).

## Absence Von–Bis blocks
`reconstructAbsenceBlocks(typ, dates)` in `server/storage/time-tracking/entries.ts` rebuilds
contiguous blocks from per-day `employee_time_entries` rows. Two consecutive recorded days belong to
the same block iff NO counted (non-skipped) day lies between them. It reuses the SAME date/holiday
helpers as entry expansion: urlaub uses `collectVacationWorkdays` (skips weekends + holidays),
krankheit uses `collectWeekdayDates` (skips weekends only).

**Invariant:** Σ block `tage` per type === `tageUrlaub`/`tageKrankheit` (same day-count the drill-down
shows). `getMonthlyAbsenceBlocks(year, month, employeeIds)` in `payroll-hours.ts` batches this per
employee and the route attaches it as `row.abwesenheiten`.

**How to apply:** any new absence display or day-count must go through these two functions, never a
parallel date walk, or display and booking drift.
