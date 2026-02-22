---
name: qa-testing
description: Automated QA and testing agent that validates happy paths, edge cases, regression risks, error handling, and test coverage. Use after implementing new features, fixing bugs, or before deployment. Ensures stability by systematically checking that features work correctly and existing functionality is not broken.
---

# QA & Testing Agent

This agent acts as a systematic tester who validates that features work correctly, edge cases are handled, and existing functionality hasn't been broken. It combines manual verification strategies with automated test recommendations.

## When to Run

- After implementing a new feature or user-facing change
- After fixing a bug (to verify fix + check for regressions)
- Before deployment/publishing
- After refactoring that touches multiple files
- When users report unexpected behavior
- During periodic quality reviews

## Core Principle

**If it wasn't tested, it doesn't work.** For every feature, systematically verify the happy path, the sad path, and the weird path. Assume users will do unexpected things.

---

## Category 1: Happy Path Verification

**Goal**: The standard workflow works correctly from start to finish for the most common use case.

### Steps:
1. **Identify the primary use case** for the feature being tested
2. **Trace the complete flow**:
   ```
   User Action → UI Response → API Request → Server Processing → DB Operation → API Response → UI Update
   ```
3. **Verify each step**:
   ```bash
   # Check the API endpoint exists and has correct method
   grep -rn "router\.\(get\|post\|put\|patch\|delete\)" server/routes/ --include="*.ts" | grep "<ENDPOINT>"
   
   # Check the storage method exists
   grep -rn "async <METHOD_NAME>" server/storage.ts server/storage/ --include="*.ts"
   
   # Check the frontend calls the correct endpoint
   grep -rn "<ENDPOINT>\|<QUERY_KEY>" client/src/ --include="*.ts" --include="*.tsx"
   ```
4. **Check data round-trip**: Data entered by user → stored in DB → displayed back correctly
5. **Verify success feedback**: User sees confirmation (toast, redirect, updated view)

### Verification Checklist:
- [ ] Can the user start the workflow from the correct entry point?
- [ ] Does the form/action submit successfully with valid data?
- [ ] Is the data stored correctly in the database?
- [ ] Does the UI reflect the new state immediately (or after refresh)?
- [ ] Does the user receive success feedback?

### Red Flags:
- Endpoint exists but storage method is missing → FAIL
- Form submits but no success feedback → WARN
- Data stored but not displayed in any view → WARN
- Workflow requires page refresh to see changes → WARN

---

## Category 2: Input Validation & Error Handling

**Goal**: Invalid inputs are rejected gracefully with helpful German error messages.

### Steps:
1. **Frontend validation**:
   ```bash
   # Find form schemas and validation rules
   grep -rn "z\.object\|z\.string\|z\.number\|z\.enum\|required\|min(\|max(" shared/schema/ --include="*.ts"
   grep -rn "zodResolver\|register\|formState.*errors\|control" client/src/ --include="*.tsx" --include="*.ts"
   ```
   - Verify: Required fields are marked and validated before submission
   - Verify: Validation messages are in German

2. **Backend validation**:
   ```bash
   # Find Zod parse/safeParse in routes
   grep -rn "\.parse(\|\.safeParse(" server/routes/ --include="*.ts"
   
   # Find routes WITHOUT validation
   grep -rn "router\.\(post\|put\|patch\)" server/routes/ --include="*.ts" -A10 | grep -v "parse\|validate\|schema"
   ```
   - Verify: Every POST/PUT/PATCH endpoint validates the request body
   - Verify: Validation errors return 400 with descriptive German message

3. **Error boundaries**:
   ```bash
   # Check for error handling in API calls
   grep -rn "onError\|catch\|error\)" client/src/ --include="*.tsx" --include="*.ts" | grep -i "toast\|alert\|message"
   ```
   - Verify: API errors show user-friendly message, not raw error object
   - Verify: Network failures are handled (try again / retry option)

4. **Test with invalid inputs**:
   - Empty required fields
   - Extremely long strings (1000+ characters)
   - Special characters: `<script>alert(1)</script>`, `'; DROP TABLE --`
   - Numbers where text is expected (and vice versa)
   - Dates in the past where future is expected
   - Negative numbers where positive is expected

### Red Flags:
- POST/PATCH endpoint without Zod validation → FAIL
- Error message shows raw English error object → FAIL
- Form submits without validating required fields → FAIL
- No error handling for API call failures → WARN

---

## Category 3: Edge Cases & Boundary Conditions

**Goal**: The system handles unusual but valid real-world scenarios without crashing or producing incorrect results.

### Steps:
1. **Empty/Zero values**:
   ```bash
   # Find calculations that might divide by zero
   grep -rn " / \| /= " server/ shared/ --include="*.ts" | grep -v "//\|node_modules"
   ```
   - Test: What happens with 0 minutes, 0 km, 0 euros, 0 items?
   - Test: What happens when a list is empty?
   - Test: What happens when optional fields are all empty?

2. **Maximum values**:
   - Test: Very long names (100+ characters) — does the UI break?
   - Test: Very large numbers (999999 euros, 9999 km)
   - Test: Very long time spans (24-hour appointment)
   - Test: Maximum items in a list (100+ entries)

3. **Date/Time boundaries**:
   ```bash
   # Find date/time handling
   grep -rn "new Date\|parseLocalDate\|parseLocalTime\|startOf\|endOf" server/ shared/ client/src/ --include="*.ts" --include="*.tsx"
   ```
   - Test: Midnight (00:00) — is it handled as start or end of day?
   - Test: Month boundaries (Jan 31 → Feb 1)
   - Test: Year transitions (Dec 31 → Jan 1)
   - Test: Leap year (Feb 29)
   - Test: Appointment spanning midnight (23:00 - 01:00)

4. **Concurrent access**:
   - Test: Two users editing the same appointment simultaneously
   - Test: User submits a form twice quickly (double-click)
   ```bash
   # Check for double-submit prevention
   grep -rn "isPending\|isSubmitting\|disabled.*pending\|disabled.*loading" client/src/ --include="*.tsx"
   ```

5. **Special characters**:
   - Test: German umlauts (ä, ö, ü, ß) in all text fields
   - Test: Emojis in notes/comments
   - Test: Very long words without spaces (do they break layout?)

### Red Flags:
- Division by zero possible → FAIL
- UI breaks with long text → WARN
- No double-submit prevention on important forms → WARN
- Date boundary produces wrong results → FAIL
- Special characters cause errors → FAIL

---

## Category 4: Regression Risk Assessment

**Goal**: Changes haven't broken existing functionality.

### Steps:
1. **Identify impacted areas**:
   ```bash
   # What files were changed?
   git diff --name-only HEAD~5 2>/dev/null || echo "No git history available"
   
   # For each changed file, find what depends on it
   # Example: If storage.ts changed, check which routes use the changed methods
   ```

2. **Cross-feature dependencies** (from the project's dependency graph):
   ```
   Appointments → Service Records → Budget Transactions
   Customer Pricing → Appointment Cost Calculation
   Employee Assignment → Appointment Assignment
   Care Level → Budget Eligibility
   Services Catalog → Appointment Services → Documentation → Budget Booking
   ```
   - For each changed feature, check: Do downstream features still work?

3. **Shared code impact**:
   ```bash
   # If shared/ files changed, check all consumers
   git diff --name-only HEAD~5 2>/dev/null | grep "shared/" | while read f; do
     basename=$(basename "$f" .ts)
     echo "=== Consumers of $basename ==="
     grep -rn "$basename" server/ client/src/ --include="*.ts" --include="*.tsx" -l
   done
   ```

4. **API contract stability**:
   ```bash
   # Check if API response shapes changed
   git diff HEAD~5 -- server/routes/ server/storage.ts 2>/dev/null | grep "^[+-].*res\.json\|return.*{" | head -20
   ```
   - Verify: Frontend types still match API responses
   - Verify: No fields were removed that the frontend depends on

### Red Flags:
- Changed shared utility but didn't check all consumers → FAIL
- Changed API response shape but didn't update frontend types → FAIL
- Changed storage method signature but callers use old parameters → FAIL
- Changed business rule but dependent features use old rule → FAIL

---

## Category 5: State Management & Data Consistency

**Goal**: Application state is consistent across all views and after all operations.

### Steps:
1. **Optimistic updates**:
   ```bash
   # Find optimistic update patterns
   grep -rn "onMutate\|optimistic\|setQueryData" client/src/ --include="*.ts" --include="*.tsx"
   ```
   - Verify: Optimistic updates are rolled back on error
   - Verify: Cache is invalidated after successful mutations

2. **Cache invalidation**:
   ```bash
   # Find all invalidateQueries calls
   grep -rn "invalidateQueries\|invalidate" client/src/ --include="*.ts" --include="*.tsx" -A1
   ```
   - Verify: After creating/updating/deleting data, relevant queries are invalidated
   - Verify: Related views update (e.g., after documenting appointment, the list view reflects new status)

3. **State after navigation**:
   - Verify: Navigating away and back doesn't lose unsaved form data (or warns the user)
   - Verify: After action, user is navigated to appropriate view (not left on stale page)
   - Verify: Browser back button works correctly

4. **Multi-step workflows**:
   ```bash
   # Find multi-step forms or wizards
   grep -rn "step\|Step\|wizard\|Wizard\|stepper" client/src/ --include="*.tsx"
   ```
   - Verify: Each step preserves data from previous steps
   - Verify: User can go back to previous steps
   - Verify: Final submission includes data from all steps

### Red Flags:
- Mutation without cache invalidation → FAIL
- Optimistic update without rollback on error → WARN
- Multi-step form that loses data on back navigation → FAIL
- Stale data shown after successful mutation → WARN

---

## Category 6: Error Recovery & Resilience

**Goal**: The app handles failures gracefully and lets users recover without data loss.

### Steps:
1. **Network failure handling**:
   ```bash
   # Check for retry logic
   grep -rn "retry\|retryDelay\|refetchOnError\|refetchOnWindowFocus" client/src/ --include="*.ts" --include="*.tsx"
   ```
   - Verify: Failed queries can be retried
   - Verify: Failed mutations show retry option or preserve user input

2. **Server error handling**:
   ```bash
   # Check error middleware
   grep -rn "errorMiddleware\|error.*handler\|500\|Internal" server/ --include="*.ts"
   ```
   - Verify: 500 errors return user-friendly message, not stack trace
   - Verify: Partial failures in transactions are rolled back

3. **Browser state recovery**:
   - Verify: Refreshing the page doesn't lose critical state
   - Verify: Session expiry redirects to login (not error page)
   - Verify: After re-login, user can continue where they left off

### Red Flags:
- Unhandled promise rejection in route handler → FAIL
- No error middleware for 500 errors → FAIL
- Page refresh causes data loss → WARN
- Network error shows generic "Something went wrong" → WARN

---

## Output Format

After completing all checks, produce a summary:

```
## QA & Testing Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Happy Path | PASS/WARN/FAIL | Details |
| 2. Input Validation | PASS/WARN/FAIL | Details |
| 3. Edge Cases | PASS/WARN/FAIL | Details |
| 4. Regression Risk | PASS/WARN/FAIL | Details |
| 5. State Management | PASS/WARN/FAIL | Details |
| 6. Error Recovery | PASS/WARN/FAIL | Details |

### Test Scenarios Checked
[List specific scenarios tested and results]

### Action Items
- FAIL items: Must fix before marking feature complete
- WARN items: Should fix, document if deferred

### Recommended Automated Tests
[Suggest specific unit/integration tests that should be written]
```

---

## Cross-References to Other Audit Skills

This audit covers **functional correctness and stability**. For complete coverage, also run:

| Skill | When to Also Run | What It Adds |
|-------|-----------------|--------------|
| `code-quality-supervisor` | **ALWAYS** after every task | Dead code, convention compliance |
| `business-logic-audit` | When workflows are tested | Domain rule consistency, workflow completeness |
| `database-audit` | When data operations are tested | Schema consistency, N+1 queries, data integrity |
| `ui-ux-audit` | When UI changes are tested | Touch targets, visual feedback, accessibility |
| `security-audit` | When inputs are tested | Injection prevention, auth bypass |
