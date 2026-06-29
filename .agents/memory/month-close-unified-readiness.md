---
name: Month-close readiness + 8th-only unconditional close (Task #1496)
description: The 8th auto-close is the ONLY close mechanism; it is UNCONDITIONAL (never blocks/overwrites status), missing signatures are followed-up not blocked, and "documented" is decoupled from "signed".
---

# Month-close: 8th-only unconditional close (Task #1496)

**Policy (current, Task #1496 — supersedes the old blocking/escalating model):**
The 8th auto-close is the ONLY close mechanism — there is NO manual close, NO
batch close, and NO reopen. All HTTP routes in `server/routes/month-closing.ts`
are read-only GET. `autoCloseMonthForCutoff` closes EVERY employee with prior-month
activity UNCONDITIONALLY (regardless of open/unsigned/undocumented appts), and it
NEVER overwrites appointment status. The period lock lives solely in
`employee_month_closings`. "Nicht abgerechnet" (`expired_unsigned`) is a runtime
DISPLAY label only (`deriveAppointmentDisplayStatus(status,{isMonthClosed})`),
never persisted.

**Documented vs documented&signed (decoupled):** "documented?" = `status==='completed'`
(`isAppointmentDocumented` / `appointmentDocumentedCondition` / `documentedSqlRaw`),
INDEPENDENT of signature — drives "Nicht abgerechnet", Lexware wage export, and
statistics exclusion. "documented & signed" (`isAppointmentDocumentedAndSigned` /
`appointmentDocumentedAndSignedCondition`) is ONLY for customer/Pflegekasse billing
and the billing pipeline. The two TS predicates (`shared/domain/appointments.ts`)
and their SQL mirrors (`server/lib/appointment-signed.ts`) MUST stay byte-equivalent
(arch tests). The old `appointmentNotDocumentedAndSignedCondition` was removed.

**Missing signatures = follow-up, NOT a blocker:** after close, the scheduler emits
one `month_close_missing_signature` notification per affected employee;
`getMissingSignaturesInClosedMonths()` + read-only `GET /month-closing/missing-signatures`
+ the admin cockpit inbox + the month-closing page surface the open list. LN
(Leistungsnachweis) create+sign stay ALLOWED after close; only LN delete keeps the
month-closed gate (superadmin bypass).

**Readiness is now read-only telemetry:** `getAdminMonthClosingReadiness` still
computes activity/open/unsigned counts, but only for audit metadata + the follow-up
list — it no longer gates the close. `autoCloseMonthForCutoff`
(`server/services/month-close-scheduler.ts`) consumes it for per-employee iteration.

**Readiness facts that bite:**
- "Activity" (`hasTimeEntries`) = time-entries OR completed/cancelled/no_show
  appointments. A lone OPEN/`documenting` appointment is NOT activity → such an
  employee is *skipped* (no candidate). Activity is the ONLY gate now — with
  activity present the employee is closed unconditionally.
- "unsigned" is LN-aware: `appointmentCompletedButUnsignedCondition()` =
  status='completed' AND signature_data IS NULL AND no signed LN
  (`server/lib/appointment-signed.ts`). Readiness only checks `signature_data IS NULL`
  for "signed", so tests can set `signature_data='data:...'` via SQL to simulate signed.
- Attribution = COALESCE(performedBy, assigned, primary) via the
  `monthClosingResponsibility*` helpers in `appointment-helpers.ts`. Documenting
  through the admin auth cookie sets `performed_by_employee_id` to the ADMIN
  (excluded by the `isAdmin=false` readiness filter) → test setup MUST SQL-fix
  `performed_by_employee_id` to the test employee, or the appt vanishes from readiness.

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
