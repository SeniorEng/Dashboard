# Performance Audit Report - CareConnect App

**Date:** 2025-06-20
**Auditor:** Performance Audit Agent
**Scope:** Full application audit (frontend + backend + network + mobile)

---

## Summary

| Category | Status | Findings |
|----------|--------|----------|
| 1. Query Performance | WARN | N+1 in billing loop, statistics endpoint very heavy (13+ SQL queries), no pagination on several list queries |
| 2. Rendering | WARN | 15+ components >500 lines, 421 useState calls, statistics page makes 8 queries on mount |
| 3. Bundle Size | PASS | Lazy loading in place for all routes, tree-shakeable imports, small assets |
| 4. Network/API | WARN | Pages with 6-11 useQuery calls, duplicate queryKeys, statistics endpoint could be split |
| 5. Mobile | PASS | Viewport configured, fonts use display=swap, no heavy computations in handlers |

### Performance Metrics
- Largest component: 1,272 lines (admin/settings.tsx)
- Components >500 lines: 15 files
- Max queries on single page: 11 (profile.tsx), 8 (statistics.tsx, service-records.tsx)
- useState count: 421 across all .tsx files
- Server-side caches: 4 (customerIds, users, birthdays, session)
- Default staleTime: 2 min (queryClient), most queries inherit default
- Route lazy loading: All pages lazy-loaded (PASS)
- Image assets: favicon.png (3.3KB), opengraph.jpg (23KB), logo-icon.jpg (30KB), logo-seniorenengel.png (77KB)
- Font loading: Google Fonts with `display=swap` (PASS)

---

## Category 1: Database Query Performance

### 1.1 N+1 Query Patterns - WARN

**billing.ts lines 142-150**: Employee lookup inside appointment loop
```
for (const appt of appts) {
  const [emp] = await db.select(...).from(users).where(eq(users.id, employeeId));
}
```
**Impact:** Each appointment triggers a separate user query. For 50 appointments, this is 50 extra queries.
**Fix:** Pre-fetch all employee data before the loop using `inArray(users.id, employeeIds)`.

**billing.ts lines 388-390**: Customer lookup inside loop
```
for (const customerId of uniqueCustomerIds) {
  const customer = await storage.getCustomer(customerId);
}
```
**Impact:** Each customer triggers a separate query. For batch billing with 20 customers, 20 extra queries.
**Fix:** Batch fetch with `storage.getCustomersByIds(uniqueCustomerIds)`.

**time-entries.ts lines 355-364**: Sequential time entry creation and audit logging in loops
```
for (const dateStr of weekdayDates) {
  const entry = await timeTrackingStorage.createTimeEntry(...);
  entries.push(entry);
}
for (const e of entries) {
  await auditService.log(...);
}
```
**Impact:** Moderate - only for vacation/sick multi-day entries. Could use batch insert.

**appointments.ts line 576-577**: Budget transaction reversal in loop
```
for (const tx of transactions) {
  await budgetLedgerStorage.reverseBudgetTransaction(tx.id, req.user!.id);
}
```
**Impact:** Low - only on appointment update, typically few transactions.

### 1.2 Missing Pagination - WARN

The following storage queries return ALL records without limit:
- `insuranceProviders` - returns all providers (likely small dataset, LOW risk)
- `customerContacts` - returns all contacts for a customer (small per customer, LOW risk)
- `customerBudgets` - returns all budgets for a customer (small per customer, LOW risk)
- `customerCareLevelHistory` - returns all history (small, LOW risk)
- `customerContracts` - returns all contracts (small, LOW risk)
- `services` - returns all services (small dataset, LOW risk)
- `serviceBudgetPots` - returns all budget pots (small, LOW risk)

**Assessment:** Most unpaginated queries are for per-customer or reference data with inherently small datasets. No immediate FAIL, but should monitor as data grows.

### 1.3 Indexes - PASS

The schema has comprehensive indexes on:
- `appointments`: date, customer_id, employee_id, status+date, composite active indexes with partial WHERE
- `customers`: primary_employee_id, backup_employee_id, name
- `employee_time_entries`: user_id, entry_date, user+date composite
- `invoices`: customer_id, billing_year+month, status, invoice_number
- `budget_transactions`: customer_id, customer+date, appointment_id, allocation_id
- `tasks`: assigned_to, created_by, customer_id, status, due_date
- `service_records`: customer, employee, year+month, status

**Well-indexed.** JOINs are on indexed columns (customer_id, employee_id, etc.).

### 1.4 Statistics Endpoint - WARN

`/statistics/overview` executes 13+ complex SQL queries in a single request via two `Promise.all` blocks. Each query involves aggregations across appointments, invoices, time_entries, budget_transactions tables.

**Impact:** This is an admin-only endpoint with staleTime of 60s, so not called frequently. However, the raw SQL aggregations scan potentially large datasets without caching.

**Recommendation:** Consider server-side caching for statistics data (TTL: 5-10 min) since this data doesn't need to be real-time.

### 1.5 Aggregations Without Cache - WARN

Statistics routes (`/statistics/overview`, `/statistics/profitability`, `/statistics/planning`, `/statistics/growth`, `/statistics/budget-potential`, `/statistics/alerts`) all perform heavy aggregations on every request. None use server-side caching.

**Recommendation:** Add a `SimpleCache` instance for statistics results with 5-minute TTL.

---

## Category 2: Frontend Rendering Performance

### 2.1 Large Component Files - WARN

15 components exceed 500 lines:

| File | Lines |
|------|-------|
| admin/settings.tsx | 1,272 |
| admin/statistics.tsx | 1,192 |
| customer-detail.tsx | 1,168 |
| admin/document-templates.tsx | 909 |
| admin/customer-detail.tsx | 867 |
| profile.tsx | 839 |
| admin/components/customer-overview-tab.tsx | 827 |
| admin/customer-new.tsx | 793 |
| customer-convert.tsx | 789 |
| admin/prospects.tsx | 744 |
| admin/components/signatures-step.tsx | 724 |
| admin/components/customer-documents-section.tsx | 709 |
| budget/BudgetLedgerSection.tsx | 703 |
| customers/components/customer-documents-section.tsx | 688 |
| admin/time-entries.tsx | 667 |

**Impact:** Large components are harder to maintain and may cause unnecessary re-renders of child elements when parent state changes. However, since all pages are lazy-loaded, initial load is not affected.

**Recommendation:** Extract sub-sections into separate components, especially for settings.tsx and statistics.tsx.

### 2.2 TanStack Query Configuration - PASS

The global `queryClient` has sensible defaults:
- `staleTime: 2 * 60 * 1000` (2 minutes) - good default
- `gcTime: 10 * 60 * 1000` (10 minutes) - good
- `refetchOnWindowFocus: true` - appropriate for care app
- `refetchInterval: false` - no unnecessary polling
- `retry: 1` - reasonable

Individual queries override with appropriate staleTime (30s-120s for frequently changing data, 5min for stable data like auth).

### 2.3 Memoization - PASS

The `statistics.tsx` page properly uses `useMemo` for expensive trend calculations (`maxTrendMinutes`). date-fns imports are tree-shakeable (importing specific functions). No lodash usage found.

### 2.4 useState Count - INFO

421 useState calls across the app. This is proportional to the app size (80+ components/pages). No evidence of derived state being stored unnecessarily from the audit.

---

## Category 3: Bundle Size & Code Splitting

### 3.1 Lazy Loading - PASS

ALL pages (36 total) use `React.lazy()` with `Suspense` fallback. This is excellent - the initial bundle only includes the login page and shared components.

### 3.2 Dependency Imports - PASS

- `date-fns`: Tree-shakeable imports (`import { format, parseISO } from "date-fns"`) - 4 files only
- `lodash`: NOT used - PASS
- `lucide-react`: Individual icon imports throughout - tree-shakeable
- No barrel imports of large libraries detected

### 3.3 Image Optimization - PASS

All images are small:
- favicon.png: 3.3KB
- opengraph.jpg: 23KB
- logo-icon.jpg: 30KB
- logo-seniorenengel.png: 77KB

No uncompressed large images in the source tree.

### 3.4 Notable Dependencies

Large dependencies that could impact bundle:
- `puppeteer-core` (server-only, not bundled in frontend) - OK
- `pdf-lib` (used server-side for PDF generation) - check if tree-shaken from client
- `@uppy/*` (file upload, 3 packages) - only loaded when needed via lazy pages
- `react-signature-canvas` - only used in signatures-step (lazy-loaded)
- `react-day-picker` - used in date-picker component (shared, will be in main bundle)

---

## Category 4: Network & API Performance

### 4.1 Pages with Many Queries - WARN

Pages making 5+ separate API calls on mount:

| Page | Query Count |
|------|-------------|
| profile.tsx | 11 |
| admin/statistics.tsx | 8 |
| service-records.tsx | 8 |
| service-record-detail.tsx | 7 |
| admin/document-templates.tsx | 7 |
| admin/time-entries.tsx | 6 |
| admin/customer-detail.tsx | 6 |
| customer-detail.tsx | 6 |
| admin/components/customer-pricing-section.tsx | 6 |
| admin/birthday-cards.tsx | 6 |

**Impact:** Multiple parallel requests on page load. TanStack Query deduplicates same-key queries, but different endpoints still create multiple connections.

**Recommendation:** For pages with 5+ queries, consider combining into a single `/page-data` endpoint that uses `Promise.all` server-side.

### 4.2 Duplicate Query Keys - INFO

Most frequent queryKeys:
- `["customers"]` - 9 uses (TanStack Query deduplicates, this is fine)
- `customerKeys.lists()` - 7 uses (shared key factory, good pattern)
- `["auth", "me"]` - 6 uses (deduplicated by TanStack Query)
- `["/api/services"]` - 6 uses (reference data, deduplicated)

**Assessment:** TanStack Query properly deduplicates these. The shared query key patterns are well-designed.

### 4.3 Server-Side Caching - PASS

Four caches implemented:
1. **customerIdsCache** (10-min TTL) - assigned customer IDs per employee
2. **usersCache** (5-min TTL) - all users and active employees lists
3. **birthdaysCache** (24-hour TTL) - birthday entries
4. **sessionCache** (5-min TTL) - authenticated user sessions

Cache invalidation is properly called on:
- Employee CRUD -> usersCache + birthdaysCache
- Customer CRUD -> birthdaysCache + customerIdsCache
- Profile updates -> usersCache + birthdaysCache
- Auth operations -> sessionCache

### 4.4 HTTP Cache Headers - PASS

Middleware properly sets Cache-Control headers:
- Auth/CSRF: `no-store`
- Stable data (services, insurance-providers): `max-age=300` (5 min)
- Semi-stable (employees, users, settings): `max-age=60` (1 min)
- Everything else: `no-cache`

### 4.5 Missing Cache: Statistics - WARN

Statistics endpoints (`/statistics/*`) perform heavy aggregations but have no server-side cache. They rely only on client-side staleTime (60s).

**Recommendation:** Add server-side cache with 5-minute TTL for statistics data, keyed by year+month.

---

## Category 5: Mobile-Specific Performance

### 5.1 Viewport - PASS
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1" />
```
Properly configured with `maximum-scale=1` to prevent unintended zoom.

### 5.2 Font Loading - PASS
Google Fonts loaded with `display=swap` to prevent invisible text during font load.

### 5.3 Touch Responsiveness - PASS
No heavy computations found in event handlers. Only one filter in a service selector onChange (removing an item from a small array).

### 5.4 Scroll Performance - INFO
No virtualization library is used. Lists (appointments, customers) rely on pagination or filtering to limit DOM nodes. For the current scale of a home care business (likely <100 customers, <50 appointments/day), this is acceptable.

**Monitor:** If customer/appointment counts grow significantly (500+), consider adding `react-window` or `react-virtuoso` for long lists.

---

## Action Items

### MUST FIX (FAIL-level)
None identified. The app has no critical performance failures.

### SHOULD FIX (High Priority WARN)

1. **N+1 in billing.ts (line 142-150)**: Pre-fetch employees before loop
   - Impact: Billing generation with many appointments will be slow
   - Fix: `const employees = await db.select().from(users).where(inArray(users.id, employeeIds))`

2. **N+1 in billing.ts (line 388-390)**: Batch customer fetch
   - Impact: Batch billing with many customers will be slow
   - Fix: Use `storage.getCustomersByIds(uniqueCustomerIds)`

3. **Statistics server-side cache**: Add SimpleCache for statistics results
   - Impact: Heavy SQL aggregations on every request
   - Fix: Cache with 5-min TTL keyed by year+month

### SHOULD OPTIMIZE (Medium Priority WARN)

4. **Large components**: Split settings.tsx (1,272 lines), statistics.tsx (1,192 lines), customer-detail.tsx (1,168 lines) into sub-components
   - Impact: Maintainability and potential re-render optimization

5. **Pages with 6+ queries**: Consider combined endpoints for profile.tsx (11 queries), service-records.tsx (8 queries)
   - Impact: Fewer HTTP connections, faster page loads on slow networks

### NICE TO HAVE (Low Priority)

6. **Time entry batch creation**: Use batch insert instead of loop for multi-day entries
7. **Monitor list sizes**: Add virtualization if lists grow beyond 100 items
8. **Logo optimization**: logo-seniorenengel.png (77KB) could be converted to WebP (~30KB)

---

## Commands Executed

```bash
# N+1 detection
grep -rn "for.*of\|forEach\|\.map(" server/storage/ --include="*.ts" -A3 | grep "await.*db"
grep -rn "for\s*(.*of\b" server/routes/ --include="*.ts" -A8 | grep -B5 "await.*db\.\|await.*storage\."

# Missing pagination
grep -rn "\.select()\|\.from(" server/storage/ --include="*.ts" | grep -v "limit"

# JOIN analysis
grep -rn "\.innerJoin\|\.leftJoin" server/storage/ --include="*.ts"

# Index verification
grep -rn "index\|createIndex" shared/schema/ --include="*.ts"

# Large components
find client/src/ -name "*.tsx" -type f -exec wc -l {} \; | sort -rn | head -20

# Lazy loading check
grep -rn "lazy\|Suspense" client/src/App.tsx

# Query configuration
grep -rn "useQuery" client/src/ --include="*.tsx" -A3 | grep "staleTime"

# Pages with multiple queries
for f in $(find client/src/pages -name "*.tsx"); do count=$(grep -c "useQuery" "$f"); if [ "$count" -gt 2 ]; then echo "$f: $count"; fi; done

# Duplicate query keys
grep -rn "queryKey:" client/src/ | sed 's/.*queryKey://' | sort | uniq -c | sort -rn | head -15

# Dependency imports
grep -rn "import.*from ['\"]date-fns['\"]" client/src/
grep -rn "import.*from ['\"]lodash['\"]" client/src/

# Image sizes
ls -lh client/src/assets/ client/public/

# Cache analysis
cat server/services/cache.ts
grep -rn "invalidate\|\.delete\|\.clear" server/ --include="*.ts" | grep -i "cache"
cat server/middleware/cache-headers.ts

# Mobile checks
grep -rn "viewport" client/index.html
grep -rn "display=swap" client/index.html
grep -rn "onClick\|onChange" client/src/ --include="*.tsx" -A3 | grep "\.filter\|\.sort"

# useState count
grep -rn "useState" client/src/ --include="*.tsx" | wc -l
```
