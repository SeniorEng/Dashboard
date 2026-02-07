---
name: database-audit
description: Automated database audit agent that critically validates all implementations against the database schema, storage layer, and frontend. Use after ANY code change that touches database schema, storage queries, API routes, or frontend data display. Also use before marking major features as complete.
---

# Database Audit Agent

Run this audit after every significant code change that involves data persistence. Work through each category systematically, using the SQL queries in `reference/audit-queries.sql` and the code analysis steps below.

## When to Run

- After adding/removing/renaming database columns
- After changing storage queries or API routes
- After modifying frontend data display
- Before marking a major feature as complete
- During periodic codebase health checks
- After refactoring that touches multiple layers

## Audit Process

Work through all 10 categories. For each, report: PASS, WARN (non-critical), or FAIL (must fix).

---

## Category 1: Schema-Storage Consistency

**Goal**: Every schema field is loaded in storage queries, every loaded field exists in schema.

### Steps:
1. Read `shared/schema.ts` and list all columns per table
2. Search `server/storage.ts` and `server/storage/*.ts` for select statements
3. Cross-reference: Flag fields in schema but never selected (candidates for removal)
4. Cross-reference: Flag fields selected but not in schema (will cause runtime errors)
5. Check insert schemas (`createInsertSchema`) match the table columns minus auto-generated fields

### Red Flags:
- Field in schema but never loaded → unused, consider removing
- Field loaded but not in schema → runtime error
- Field in insert schema but auto-generated → should be omitted

---

## Category 2: Storage-Frontend Consistency

**Goal**: Data loaded from DB is actually used in the frontend.

### Steps:
1. For each storage query, trace which API route returns the data
2. For each API route, check which frontend component consumes it
3. Flag fields that are loaded from DB, sent via API, but never displayed or used in frontend logic
4. Check TypeScript types in `client/src/lib/api/types.ts` match what the API actually returns

### Red Flags:
- Field loaded + returned via API but never used in any component
- Type mismatch between API response and frontend type definition
- Frontend accessing a field that the API doesn't return

---

## Category 3: Data Types & Constraints

**Goal**: Correct SQL types enforce data integrity at the database level.

### Steps:
1. Verify monetary values use `integer` (cents), never `numeric` or `real`
2. Verify kilometer/distance fields use `integer`, never `real` or `numeric`
3. Verify date fields use `date` type (stored as "YYYY-MM-DD" strings)
4. Verify time fields use `time` type (stored as "HH:MM:SS" strings, `time without time zone`)
5. Verify all system timestamps (created_at, updated_at, expires_at etc.) use `timestamptz` (`timestamp with time zone`), never plain `timestamp`
6. Check NOT NULL is only used where truly required
7. Verify sensible defaults exist for optional fields
8. Run: `reference/audit-queries.sql` → "Nullable columns without defaults" (advisory: review list, not automatic failure — intentionally nullable fields like `notes` are fine without defaults)

### Red Flags:
- Money stored as float/real → rounding errors
- Dates stored as text without validation → format inconsistency
- NOT NULL without default on optional business fields → insert failures
- System timestamps using `timestamp without time zone` instead of `timestamptz` → timezone drift risk

## Category 3b: Date/Time Convention Compliance

**Goal**: All code follows the project's mandatory date/time conventions (see replit.md).

### Steps:
1. Search for `new Date()` usage in time-related contexts → must use `currentTimeHHMMSS()` / `currentTimeHHMM()` instead
2. Search for `Date` objects passed to datetime utilities (`formatTimeHHMM`, `formatTimeHHMMSS`, `timeToMinutes`, `timeDifferenceMinutes`, `isTimeBetween`) → all must accept only strings
3. Search for ISO timestamp strings (containing "T") being used as local times
4. Search for `date.getHours()` / `date.getMinutes()` / `date.getSeconds()` in time calculations → forbidden pattern
5. Verify all time utility function signatures accept only `string` parameters (not `Date | string`)
6. Check for local duplicate implementations of datetime functions (e.g., `parseLocalDate` redefined in route files) → must use `@shared/utils/datetime`
7. Verify all displayed times use "HH:MM" format (no seconds shown to users)
8. Verify all stored times use "HH:MM:SS" format

### Red Flags:
- `formatTimeHHMMSS(new Date())` → must be `currentTimeHHMMSS()`
- `timeToMinutes(someDate)` where `someDate` is a `Date` object → must convert to string first
- Any function signature like `(time: string | Date)` in datetime utilities → only `string` allowed
- Local `function parseLocalDate()` in non-utility files → use central import
- Time displayed with seconds ("09:45:00") → must show only "09:45"
- `new Date(isoString).getHours()` for time extraction → parse the time string directly

---

## Category 4: Indexing & Performance

**Goal**: Queries are fast, indexes exist where needed, no unused indexes waste space.

### Steps:
1. Run: `reference/audit-queries.sql` → "Sequential scan analysis" (note: pg_stat counters reset on DB restart — in dev, high seq_scan% is normal for small datasets)
2. Run: `reference/audit-queries.sql` → "Unused indexes" (monitor over a full business cycle before removing — dev stats are unreliable)
3. Check all foreign key columns have indexes (advisory: the FK-index query uses LIKE on indexdef and may miss multi-column indexes — verify manually)
4. Check columns used in WHERE, JOIN, ORDER BY have indexes
5. For multi-column filters, check composite indexes exist
6. Review storage queries for `SELECT *` usage → should select only needed columns

### Red Flags:
- Table with >1000 rows and >50% sequential scans → missing index (production only)
- Index with 0 scans (excluding PKs) → unused, consider removing (production stats only)
- Foreign key column without index → slow JOINs (advisory: audit columns like `created_by_user_id` rarely need indexes)
- `SELECT *` on large tables → unnecessary data transfer

---

## Category 5: N+1 Query Detection

**Goal**: No query patterns that cause exponential DB calls.

### Steps:
1. Search storage layer for loops that execute queries inside iterations
2. Check for patterns: `for (const item of items) { await db.query(...) }`
3. Verify related data is loaded via JOINs or batch queries, not individual lookups
4. Check API routes that fetch lists then enrich each item with additional queries
5. Look for `Promise.all(items.map(item => storage.getRelated(item.id)))` patterns

### Red Flags:
- Query inside a for/forEach/map loop
- Fetching related records one-by-one instead of batch
- API handler making N queries for N items in a list

### Fix Pattern:
```typescript
// BAD: N+1
const customers = await storage.getCustomers();
for (const c of customers) {
  c.appointments = await storage.getAppointments(c.id); // N queries!
}

// GOOD: JOIN or batch
const customers = await storage.getCustomersWithAppointments(); // 1 query with JOIN
```

---

## Category 6: Schema Drift Detection

**Goal**: Drizzle schema matches the actual database state.

### Steps:
1. Run: `npx drizzle-kit push --dry-run` and check for pending changes
2. Run: `reference/audit-queries.sql` → "Schema drift check"
3. Compare column names, types, and constraints between Drizzle schema and actual DB
4. Check for columns in DB but not in schema (manual additions)
5. Check for columns in schema but not in DB (missing migration)

### Red Flags:
- Drizzle push reports pending changes → schema out of sync
- DB has columns not defined in schema → manual changes bypassed ORM
- Schema has columns not in DB → migration never applied

---

## Category 7: GDPR/DSGVO Compliance

**Goal**: Personal data handling meets GDPR requirements.

### Steps:
1. Verify soft-delete pattern: `deletedAt` / `isActive` flags on employee/user tables
2. Check that soft-deleted records are filtered from normal queries
3. Verify audit trails don't contain unnecessary personal data
4. Check historization tables (valid_from/valid_to) store only necessary data
5. Verify no personal data in application logs
6. Check data retention: is there a mechanism to purge old data?

### Red Flags:
- Hard delete on tables with personal data without audit trail
- Soft-deleted records returned in normal list queries
- Personal data (names, addresses) in error logs
- No retention policy for historical data
- Audit trail contains full personal data copies instead of references

---

## Category 8: Historization & Audit Trail

**Goal**: Data changes are traceable and reversible.

### Steps:
1. Verify tables with `valid_from`/`valid_to` pattern are correctly maintained
2. Check that updates create new records (not overwrite) for historized tables
3. Verify "current" queries filter by `valid_to IS NULL`
4. Check that the performer/modifier is tracked (who made the change)
5. Run: `reference/audit-queries.sql` → "Overlapping historization records"

### Red Flags:
- Historized table updated in-place instead of insert-new/expire-old
- Missing `valid_to IS NULL` filter in "current data" queries
- No user/employee reference tracking who made changes
- Overlapping validity periods in historized records

---

## Category 9: Referential Integrity & Data Consistency

**Goal**: No orphaned records, proper cascading, valid cross-field relationships.

### Steps:
1. Run: `reference/audit-queries.sql` → "Orphaned records check"
2. Verify CASCADE/SET NULL/RESTRICT rules on foreign keys match business requirements
3. Check cross-field validations (e.g., startDate < endDate, actualStart after scheduledStart)
4. Verify transactions wrap multi-table operations
5. Check for race conditions in concurrent write scenarios (e.g., budget booking)

### Red Flags:
- Foreign key pointing to non-existent record → orphaned data
- Missing transaction on multi-table insert/update → partial writes possible
- No cross-field validation → invalid data combinations possible
- Budget/balance operations without locking → race conditions

---

## Category 10: Security

**Goal**: Database access is secure and follows least-privilege.

### Steps:
1. Verify all queries use parameterized statements (Drizzle ORM handles this)
2. Check no raw SQL with string concatenation exists
3. Verify role-based filtering at query level (not just API level)
4. Check sensitive fields (passwords, tokens) use proper hashing/encryption
5. Verify no sensitive data in API error responses
6. Check CSRF protection on all state-changing endpoints

### Red Flags:
- Raw SQL with template literals or string concatenation → SQL injection risk
- API returns full error stack traces with internal details
- Role checks only at middleware level, not at query level
- Passwords stored in plain text or reversible encryption

---

## Output Format

After completing all checks, produce a summary:

```
## Database Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Schema-Storage | PASS/WARN/FAIL | Details |
| 2. Storage-Frontend | PASS/WARN/FAIL | Details |
| 3. Data Types | PASS/WARN/FAIL | Details |
| 4. Indexing | PASS/WARN/FAIL | Details |
| 5. N+1 Queries | PASS/WARN/FAIL | Details |
| 6. Schema Drift | PASS/WARN/FAIL | Details |
| 7. GDPR/DSGVO | PASS/WARN/FAIL | Details |
| 8. Historization | PASS/WARN/FAIL | Details |
| 9. Data Integrity | PASS/WARN/FAIL | Details |
| 10. Security | PASS/WARN/FAIL | Details |

### Action Items
- FAIL items: Must fix before completion
- WARN items: Should fix, document if deferred
```
