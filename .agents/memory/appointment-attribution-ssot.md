---
name: Appointment→employee attribution SSoT
description: The one rule that maps an appointment to the employee(s) it counts toward; the admin all-employees overview and the employee self-view must both go through it.
---

# Appointment → employee attribution must use one shared rule

Both the employee self-view and the admin all-employees time-tracking overview
must attribute an appointment to the same employee(s), via a single shared
domain rule — never by re-implementing per-view `groupBy(assignedEmployeeId)`.

The rule: a completed appointment counts toward whoever performed it; an open
(non-completed) appointment counts toward whoever is assigned, otherwise toward
the customer's coverage chain (primary then backups, deduped); an appointment
with no assignee and no coverage counts toward nobody.

**Why:** The admin overview once grouped only by the assigned employee and
silently dropped unassigned appointments, so admins saw fewer hours/appointments
for an employee than the employee saw for themselves. Open unassigned
appointments fan out to *every* covering employee — matching the self-view,
which reads coverage even for soft-deleted customers. So the admin-side coverage
lookup must NOT filter to active customers only, or parity breaks again.

**How to apply:** Any new aggregation that buckets appointments per employee
(stats, exports, dashboards) must call the shared rule. Parity is locked by an
equality test (admin vs. self appointment-set per employee) plus a pure unit
test of the rule. Caveat: a coverage-shared open appointment is counted once per
covering employee, so any *grand total* count (not per-employee) sums higher
than the raw appointment row count — dedupe before showing a headline count.
