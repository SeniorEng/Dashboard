---
name: Month-close unified readiness (auto/admin/batch)
description: One readiness SSoT decides month-close across auto-close, single admin-close, and batch-close; missing signature BLOCKS auto-close and escalates.
---

# Unified month-close readiness

All three close paths MUST share ONE readiness definition: `getMonthClosingReadiness`
(single) and `getAdminMonthClosingReadiness` (batch) in
`server/storage/time-tracking/month-closing.ts`; `autoCloseMonthForCutoff`
(`server/services/month-close-scheduler.ts`) consumes the admin readiness so its
per-employee decision is identical by construction.

**Readiness facts that bite:**
- "Activity" (`hasTimeEntries`) = time-entries OR completed/cancelled/no_show
  appointments. A lone OPEN/`documenting` appointment is NOT activity → such an
  employee is *skipped* (no candidate), not blocked. To test a BLOCK you need
  activity PLUS a blocker.
- "unsigned" is LN-aware: `appointmentCompletedButUnsignedCondition()` =
  status='completed' AND signature_data IS NULL AND no signed LN
  (`server/lib/appointment-signed.ts`). Readiness only checks `signature_data IS NULL`
  for "signed", so tests can set `signature_data='data:...'` via SQL to simulate signed.
- Attribution = COALESCE(performedBy, assigned, primary) via the
  `monthClosingResponsibility*` helpers in `appointment-helpers.ts`. Documenting
  through the admin auth cookie sets `performed_by_employee_id` to the ADMIN
  (excluded by the `isAdmin=false` readiness filter) → test setup MUST SQL-fix
  `performed_by_employee_id` to the test employee, or the appt vanishes from readiness.

**Policy:** a missing signature (or open appt) BLOCKS auto-close — it does NOT
silently skip and it NEVER overwrites appointment status. Auto-close logs
`month_auto_close_blocked` (audit + admin notifications, deduped) instead of closing.

**Error-code split (write paths in `appointment-documentation.ts` /document &
/document-no-show):** locked (= on a signed Leistungsnachweis) → 409 `conflict()`
(`APPOINTMENT_LOCKED`); month closed → 403 `forbidden("MONTH_CLOSED")`. The
read-only `/:id/no-show-preview` stays a uniform 403 IDOR guard on purpose.

**Architecture guard (two layers, `tests/architecture/ssot-imports.test.ts`):**
A2 catches a second readiness by FUNCTION NAME (`…MonthClosingReadiness`); A2b
catches a structural re-aggregation of the blockers WITHOUT that name. A2b keys on
the open-appointments status-exclusion triple (`notInArray(... "completed" +
"cancelled" + "customer_no_show")`) — which is UNIQUE to the SSoT module in the
real tree — combined with at least one more blocker signal (the unsigned predicate
or `employeeTimeEntries`). **How to apply:** any new file legitimately querying
that status triple must be allowlisted in `READINESS_AGGREGATION_ALLOWLIST`; pure
`isMonthClosed`/`monthCloseCache` lookups (orthogonal "Monat zu?") never trip it.

**Facade-init fragility (services):** the scheduler must import the readiness
functions DIRECTLY from the leaf `month-closing` module, NOT via the
`timeTrackingStorage` object-literal facade (`server/storage/time-tracking.ts`).
The facade freezes its method references at module-init; under circular-import
ordering those refs can still be `undefined` when a service that loads early
calls them → runtime `…getAdminMonthClosingReadiness is not a function`. Prefer
direct leaf imports in services (same pattern as `../storage/notifications`,
`../storage/tasks`). **Why:** Task #1172 moved the scheduler onto the facade and
this exact TypeError surfaced at reminder time.
