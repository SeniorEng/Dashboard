---
name: business-logic-audit
description: Automated business logic audit agent that validates implementations against user workflows, domain rules, and real-world usage patterns. Use after ANY code change that touches business logic, status transitions, workflows, or domain rules. Verifies that features make sense from the user's perspective and are correctly implemented end-to-end.
---

# Business Logic Audit Agent

This agent validates that business logic is correctly implemented from the user's perspective. Unlike the database audit (which checks data integrity), this agent checks whether the **workflows, rules, and user journeys** actually work as intended in real-world usage.

## When to Run

- After implementing or modifying any business workflow
- After changing status transitions or state machines
- After modifying validation rules or domain logic
- Before marking a major feature as complete
- When a bug report suggests a workflow doesn't work as expected
- After refactoring shared domain logic

## Core Principle

**Think like a user, not a developer.** For every feature, ask:
1. What does the user actually do in practice? (not just the "happy path")
2. What happens when they skip steps or do things out of order?
3. Are error messages helpful and actionable (in German)?
4. Does the data flow correctly from user action → API → storage → display?

---

## Category 1: Workflow Completeness

**Goal**: Every user workflow is fully implemented end-to-end, with no dead ends or missing steps.

### Steps:
1. Identify the workflow being audited (see `reference/workflows.md` for project-specific workflows)
2. Trace the complete user journey: UI action → API call → storage operation → response → UI update
3. Check every status/state in the workflow has both an entry path AND an exit path
4. Verify the workflow handles the "skip step" scenario (e.g., user documents appointment without starting it first)
5. Check that intermediate states are recoverable (user can go back or continue later)

### Red Flags:
- Dead-end states: User reaches a status with no way to proceed
- Missing fallback values: Data expected by later steps isn't set when earlier steps are skipped
- Workflow requires strict step order but UI doesn't enforce it
- Success state reached but required data fields are still NULL

### Example (actualStart/actualEnd):
```
Problem: Users document appointments directly without clicking "Start" first.
→ actualStart/actualEnd were never set
→ Leistungsnachweis showed blank times
Fix: Document endpoint sets fallback values when start/end weren't explicitly triggered.
```

---

## Category 2: Domain Rule Consistency

**Goal**: Business rules are defined once (single source of truth) and enforced consistently across all layers.

### Steps:
1. List all domain rules from `shared/domain/*.ts`
2. For each rule, verify it's enforced at ALL relevant layers:
   - Frontend validation (forms, UI state)
   - API validation (Zod schemas, route handlers)
   - Storage layer (database constraints)
3. Check for duplicated logic that could diverge (same rule implemented differently in two places)
4. Verify domain functions are imported from `shared/domain/`, not reimplemented locally
5. Check that error messages for rule violations are in German and actionable

### Red Flags:
- Same business rule hardcoded in multiple files with different values
- Frontend allows an action that the backend rejects (or vice versa)
- Domain rule exists in code but has no corresponding database constraint
- Validation message is generic ("Fehler") instead of specific ("Termin kann nicht dokumentiert werden, da noch kein Pflegegrad zugewiesen ist")

---

## Category 3: Status Transition Integrity

**Goal**: State machines allow only valid transitions and every transition updates all dependent data.

### Steps:
1. Map all status values and their allowed transitions (see domain files)
2. For each transition, verify:
   - Preconditions are checked (required fields populated?)
   - All side effects are triggered (timestamps set? related records updated?)
   - UI reflects the new state correctly (buttons, badges, available actions)
3. Test reverse/undo transitions if they exist
4. Check concurrent access: What happens if two users trigger conflicting transitions?

### Red Flags:
- Status changes without updating dependent timestamps (e.g., completed without actualEnd)
- Transition allowed in API but not shown in UI (or vice versa)
- Missing side effects: Status changes but related data isn't updated
- No concurrency protection on critical transitions (e.g., double-booking)

---

## Category 4: Data Flow Verification

**Goal**: Data entered by the user flows correctly through the entire system and appears where expected.

### Steps:
1. Pick a data field that the user enters (e.g., Hauswirtschaft duration)
2. Trace it through:
   - Form input → form state → API request body
   - API validation → storage insert/update
   - Storage query → API response
   - Frontend display (detail view, list view, reports)
3. Verify the value is never silently transformed, truncated, or lost
4. Check that the same field shows consistent values everywhere it appears
5. Verify computed values (e.g., cost = duration × rate) are calculated correctly

### Red Flags:
- Value entered in form but not sent in API request (missing from payload)
- Value stored in DB but not included in storage query SELECT
- Value returned by API but not displayed in any UI component
- Value displayed differently in different views (e.g., formatted vs raw)
- Computed values use different formulas in different places

---

## Category 5: User-Perspective Validation

**Goal**: Features work as a real user would expect, not just as a developer designed them.

### Steps:
1. Consider the user persona: Caregiver with a mobile phone, possibly stressed, in a patient's home
2. Check mobile-first: Does the workflow work well on a phone? Touch targets ≥44px?
3. Check offline/poor-connection: What happens if the API call fails mid-workflow?
4. Verify error recovery: If something fails, can the user retry without losing data?
5. Check for implicit assumptions: Does the code assume data exists that might not?
6. Verify German localization: All user-facing text in German, German date/time formats
7. Verify date/time display conventions: Times shown as "HH:MM" (never seconds), dates as "DD.MM.YYYY" (German) or "YYYY-MM-DD" (forms)

### Red Flags:
- Workflow requires multiple page navigations on mobile for a simple task
- API failure silently swallows data the user entered
- Error message shows English technical text ("500 Internal Server Error")
- Feature works only if all optional data is filled in
- Dates displayed in US format (MM/DD) instead of German (DD.MM.)
- Times displayed with seconds ("09:45:00") instead of "09:45"
- Time values computed using `new Date()` instead of string-based utilities from `@shared/utils/datetime`

---

## Category 6: Cross-Feature Impact Analysis

**Goal**: Changes to one feature don't break related features.

### Steps:
1. Identify the feature being changed
2. Map all features that depend on it (see dependency graph below)
3. For each dependent feature, verify it still works correctly
4. Check shared domain functions: Are callers still compatible after changes?
5. Verify API contract: Does the response shape still match frontend expectations?

### Key Dependencies in This Project:
```
Appointments → Leistungsnachweise (service records depend on completed appointments)
Appointments → Budget Transactions (cost booking happens at documentation)
Appointments → Time Tracking (work hours derived from appointment times)
Customer Pricing → Appointment Cost Calculation (rates from pricing agreement)
Employee Assignment → Appointment Assignment (who can be assigned)
Care Level → Budget Eligibility (Pflegegrad determines §45b eligibility)
```

### Red Flags:
- Changed appointment structure but didn't update service record logic
- Modified pricing but cost calculation still uses old field names
- Added required field to customer but existing customers break
- Changed API response shape but frontend still expects old shape

---

## Category 7: Edge Cases & Boundary Conditions

**Goal**: The system handles unusual but valid real-world scenarios.

### Steps:
1. Test with empty/zero values: 0 minutes, 0 km, empty notes
2. Test with maximum values: 24-hour appointment, 999 km, very long notes
3. Test with dates at boundaries: midnight, month boundaries, year transitions
4. Test with special German characters: ä, ö, ü, ß in all text fields
5. Test concurrent actions: Two caregivers documenting the same appointment
6. Test with new vs. existing data: New customer without history, long-term customer with years of data

### Red Flags:
- Division by zero when duration is 0
- Overflow when calculating large budgets or costs
- Month/year transition creates duplicate records
- Special characters cause display issues or validation failures

---

## Category 8: Business Rule Documentation Sync

**Goal**: Code, comments, and documentation describe the same rules.

### Steps:
1. Read the domain rule documentation in `shared/domain/*.ts` comments
2. Compare documented rules against actual code implementation
3. Check `replit.md` business rules section matches current implementation
4. Verify that changed rules are reflected in error messages
5. Look for TODO/FIXME comments near business logic that indicate incomplete implementation

### Red Flags:
- Comment says "only completed appointments" but code also allows "documenting"
- replit.md describes a workflow that no longer exists in code
- Error message references a rule that was changed
- TODO comment on critical business logic that was never addressed

---

## Output Format

After completing all checks, produce a summary:

```
## Business Logic Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Workflow Completeness | PASS/WARN/FAIL | Details |
| 2. Domain Rule Consistency | PASS/WARN/FAIL | Details |
| 3. Status Transitions | PASS/WARN/FAIL | Details |
| 4. Data Flow | PASS/WARN/FAIL | Details |
| 5. User Perspective | PASS/WARN/FAIL | Details |
| 6. Cross-Feature Impact | PASS/WARN/FAIL | Details |
| 7. Edge Cases | PASS/WARN/FAIL | Details |
| 8. Documentation Sync | PASS/WARN/FAIL | Details |

### Action Items
- FAIL items: Must fix before completion
- WARN items: Should fix, document if deferred

### Workflow Trace
[For the specific workflow being audited, include the full trace:]
User Action → UI Component → API Endpoint → Storage Method → DB Table → Response → Display
```

---

## Cross-References to Other Audit Skills

This audit covers **business logic** (workflows, domain rules, user perspective). For complete coverage, also run:

| Skill | When to Also Run | What It Adds |
|-------|-----------------|--------------|
| `code-quality-supervisor` | **ALWAYS** after every task | Duplicate detection, convention compliance, migration completeness, dead code |
| `database-audit` | When schema, storage, or queries are affected | Schema consistency, data types, indexing, GDPR |
| `security-audit` | When auth, API routes, or validation rules change | OWASP checks, secret exposure, access control |
| `performance-audit` | When new features add complexity | Query efficiency, rendering, bundle size |

See `.agents/skills/code-quality-supervisor/SKILL.md` for the orchestration rules that determine which audits run when.
