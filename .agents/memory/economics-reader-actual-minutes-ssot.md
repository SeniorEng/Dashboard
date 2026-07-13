---
name: Economics "Nach Mitarbeiter" actual-minutes SSoT
description: How the Wirtschaftlicher-Überblick economics reader must derive hours/cost/rate labels.
---

The economics reader (server/storage/billing/economics-reader.ts) "Nach Mitarbeiter" /
"Nach Leistung" hours, costs and effective per-unit rate LABELS must rest on the SAME
documented-actual-minutes basis as revenue and payroll.

**Rule:** aggregate per `appointment_service` row using
`COALESCE(actual_duration_minutes, planned_duration_minutes)` — never `DISTINCT ON (a.id)`
(collapses a multi-service appointment to one row, dropping a category) and never
`duration_promised` (promised != documented actual). Status gate = `documentedSqlRaw` (=
status='completed'); there is no 'documented' enum value.

**km rate label denominator** = billable APPOINTMENT km only (travel + customer), not total
km incl. non-billable time-entry km — otherwise the displayed €/km rate gets diluted. The
displayed km QUANTITY column still shows total km; only the rate-label basis is billable-only
(buildRow rateBasis param).

**Why:** Task #1752 — Nadine Reupert June 2026 showed wrong HW/AB hours and diluted km rate
because the cost/hours query collapsed appointments and used promised minutes, drifting from
the revenue/payroll views.

**How to apply:** any change to economics hours/cost/rate must keep the three sub-queries
(cost/hours, revenue, km) on the same actual-minutes + documentedSqlRaw basis; verify
economics category hours === payroll getMonthlyCategoryErfasst hw/ab.
