# Performance Audit Report - CareConnect App

**Date:** 2025-07-08
**Auditor:** Performance Audit Agent
**Scope:** Full application audit (all 6 categories: DB, Frontend, Bundle, Network, Mobile, Memory)

---

## Summary

| Category | Status | Findings |
|----------|--------|----------|
| 1. Query Performance | WARN | 2 N+1 patterns, multiple unbounded queries without pagination, good JOIN usage |
| 2. Rendering | WARN | Large components (1279 lines max), 78 useMemo vs 132 array ops, good default staleTime |
| 3. Bundle Size | PASS | Excellent lazy-loading (37 lazy routes), manual chunk splitting configured, tree-shakeable imports |
| 4. Network/API | WARN | No prefetching, 11 pages with 5+ queries, good server-side caching with TTL |
| 5. Mobile & Core Web Vitals | WARN | 6 images without dimensions (CLS risk), 0 Skeleton placeholders used, good viewport config |
| 6. Memory & Resource Leaks | PASS | Good useEffect cleanup, graceful server shutdown, caches have TTL limits |

---

## Category 1: Database Query Performance

### Status: WARN

### N+1 Query Detection
**Found 2 N+1 patterns:**

1. **WARN** `server/routes/billing.ts:391` — Loop with `await storage.getCustomer(customerId)` inside `for (const customerId of uniqueCustomerIds)`. Should use `getCustomersByIds()` batch query instead.

2. **WARN** `server/storage/service-catalog.ts:182` — Loop with `await this.getServiceByCode(def.code)` and `await db.insert()` inside `for (const def of SYSTEM_SERVICE_DEFINITIONS)`. This is a setup/seed operation so impact is low but still suboptimal.

3. **WARN** `server/storage/qualifications.ts:121` — Loop with `await db.insert(employeeDocumentProofs)` inside `for (const doc of requiredDocs)`. Should batch-insert.

### Missing Pagination
**Found multiple unbounded queries:**

- `storage.getCustomers()` — Returns ALL non-deleted customers without limit. Used in `server/routes/customers.ts:79` for admin. **WARN**: Will degrade as customer count grows.
- `storage.getAppointments()` — Returns ALL non-deleted appointments without limit. **WARN**: Critical for large datasets.
- `server/storage/customer-mgmt/insurance.ts:15-17` — `insuranceProviders` returned without limit (acceptable: small dataset).
- `server/storage/service-catalog.ts:78-80` — Services returned without limit (acceptable: small dataset).
- `server/storage/customer-mgmt/contacts.ts`, `budgets.ts`, `care-level.ts`, `contracts.ts` — Per-customer queries without limit (acceptable: bounded by customer relationship).

**Positive:** `getAppointmentsWithCustomersPaginated()` exists with proper pagination support.

### JOINs
**22+ JOIN operations found** — All use proper `eq()` conditions on ID columns (foreign keys), which are indexed by default in PostgreSQL. No JOINs on non-indexed columns detected. Select fields are explicitly specified in `appointmentWithCustomerSelectFields` — no `SELECT *` on JOINed queries. **PASS**.

### Aggregations
- `count()` and `sql` template aggregations used properly in `budget-ledger.ts`, `prospects.ts`, `notifications.ts`.
- `Promise.all()` is used correctly to parallelize independent queries (6 instances found in `budget-ledger.ts`, `customer-management.ts`, `time-tracking.ts`). **PASS**.

### Missing Indexes
- `appointments.date`, `appointments.customerId`, `appointments.assignedEmployeeId` — Used frequently in WHERE conditions. Should verify indexes exist.
- `customers.primaryEmployeeId`, `customers.backupEmployeeId` — Used in `getAssignedCustomerIds`. Should verify indexes.

---

## Category 2: Frontend Rendering Performance

### Status: WARN

### Memoization
- **78 `useMemo`** calls vs **132 array operations** (`.filter()`, `.sort()`, `.reduce()`) across tsx files.
- **144 `useCallback`** calls — Good callback memoization.
- Not all array operations need memoization, but some large-dataset operations in admin pages likely should be memoized.

### Large Components
| File | Lines |
|------|-------|
| `admin/settings.tsx` | 1,279 |
| `admin/statistics.tsx` | 1,184 |
| `customer-detail.tsx` | 1,168 |
| `admin/document-templates.tsx` | 909 |
| `admin/customer-detail.tsx` | 867 |
| `admin/customer-new.tsx` | 855 |
| `profile.tsx` | 839 |
| `admin/components/customer-overview-tab.tsx` | 827 |
| `customer-convert.tsx` | 789 |
| `admin/prospects.tsx` | 744 |

**WARN**: 10 components exceed 500 lines. Top 3 exceed 1000 lines and should be decomposed into sub-components.

### TanStack Query Configuration
**Default config is well-configured:**
- `staleTime: 2 * 60 * 1000` (2 min) — Good default
- `gcTime: 10 * 60 * 1000` (10 min) — Good garbage collection
- `retry: 1` — Appropriate for mobile
- `refetchOnWindowFocus: true` — Ensures fresh data

**Per-query overrides found** (15 instances): staleTime ranges from 30s to 5min. All appropriate for their data freshness needs.

### useState Count
- **444 useState calls** across TSX files. Some may be storing derived state. Manual review recommended for the largest components.

---

## Category 3: Bundle Size & Code Splitting

### Status: PASS

### Lazy Loading
**Excellent**: 37 routes use `React.lazy()` with dynamic `import()`. Only `Dashboard`, `LoginPage`, and `NotFound` are eagerly loaded (appropriate as they are high-priority landing pages). All admin pages are lazy-loaded. **PASS**.

### Manual Chunk Splitting
Well-configured in `vite.config.ts`:
- `vendor-react`: react, react-dom, wouter
- `vendor-radix`: 16 Radix UI packages
- `vendor-utils`: date-fns, zod, clsx, tailwind-merge, cva
- `vendor-query`: @tanstack/react-query

### Dependency Imports
- **date-fns**: Tree-shakeable imports used (`from "date-fns"` with named imports like `format`, `parseISO`). **PASS**.
- **lodash**: Not used at all. **PASS**.
- **lucide-react**: Individual icon imports. **PASS**.

### Image Optimization
- `favicon.png`: 3.3KB — **PASS**
- `opengraph.jpg`: 23KB — **PASS**
- `logo-icon.jpg`: 30KB — **PASS**
- `logo-seniorenengel.png`: 77KB — **PASS** (under 100KB threshold)

---

## Category 4: Network & API Performance

### Status: WARN

### Server-Side Caching
**Good caching infrastructure:**
- `SimpleCache<T>` with TTL and garbage collection (`server/services/cache.ts`)
- `CustomerIdsCacheService` — 10 min TTL for assigned customer IDs
- `UsersCacheService` — 5 min TTL for user/employee lists
- `BirthdaysCache` — Dedicated cache for birthday data
- HTTP `Cache-Control` headers via `cache-headers.ts` middleware:
  - Stable data (`/api/services`, insurance providers): `max-age=300`
  - Semi-stable (`/api/admin/employees`, settings): `max-age=60`
  - Auth/CSRF: `no-store`
  - Default: `no-cache`

### Cache Invalidation
**Good**: 20+ cache invalidation calls found. Customer mutations invalidate `customerIdsCache` and `birthdaysCache`. Employee mutations invalidate `usersCache` and `birthdaysCache`. **PASS**.

### Duplicate Query Keys
| Query Key | Occurrences |
|-----------|-------------|
| `["customers"]` | 9 |
| `customerKeys.lists()` | 7 |
| `[QUERY_KEY]` | 6 |
| `["auth", "me"]` | 6 |
| `["/api/services"]` | 6 |

TanStack Query deduplicates by key, so concurrent mounts share the same request. **PASS**.

### Pages with Multiple Queries
| Page | Query Count |
|------|-------------|
| `profile.tsx` | 11 |
| `service-records.tsx` | 8 |
| `service-record-detail.tsx` | 7 |
| `admin/statistics.tsx` | 7 |
| `admin/document-templates.tsx` | 7 |
| `admin/birthday-cards.tsx` | 6 |
| `admin/customer-detail.tsx` | 6 |
| `admin/time-entries.tsx` | 6 |
| `admin/customer-pricing-section.tsx` | 6 |

**WARN**: `profile.tsx` makes 11 separate queries. Consider combining into a `/profile-data` endpoint. Pages with 5+ queries should evaluate combined endpoints.

### Prefetching
**WARN**: No prefetching found (`prefetch`, `preload`, `prefetchQuery` — 0 results). Critical navigation paths (appointment list → appointment detail, customer list → customer detail) should prefetch on hover.

### Request Waterfall
API client supports `AbortSignal` but TanStack Query signal is not explicitly passed through in the `getQueryFn` wrapper. Queries run in parallel by default via TanStack Query. No sequential `await` chains detected in frontend. **PASS**.

---

## Category 5: Mobile-Specific Performance

### Status: WARN

### Viewport Configuration
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1" />
```
**PASS**: Properly configured with `maximum-scale=1` to prevent unintended zoom.

### Font Loading
```html
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```
**PASS**: Uses `display=swap` and `preconnect`. However, 5 font weights loaded (300-700) — consider reducing to 3-4 weights for faster loading.

### Core Web Vitals

**LCP (Largest Contentful Paint):**
- Dashboard is eagerly loaded (not lazy) — **Good** for LCP.
- Logo images are small (30KB, 77KB) — **Good**.
- Main content on Dashboard depends on API calls (appointments, tasks). Above-the-fold relies on data fetch. **WARN**: Consider server-side rendering or stale-while-revalidate pattern.
- Estimated LCP: **medium** (depends on API response time).

**CLS (Cumulative Layout Shift):**
- **6 `<img>` tags without explicit width/height or className** found:
  - `signature-pad.tsx:295`
  - `admin/customer-documents-section.tsx:413`
  - `admin/settings.tsx:448, 510`
  - `login.tsx:99, 246`
- **WARN**: These images may cause layout shifts on load.
- **0 Skeleton placeholders** used in production (only defined in `skeleton.tsx`, never imported). All loading states use `Loader2` spinner which doesn't reserve space. **WARN**: Loading states cause layout shifts when content loads.

**INP (Interaction to Next Paint):**
- Only 1 heavy operation in event handler detected: `service-selector.tsx:54` — simple `.filter()` on small array. **PASS**.
- No `JSON.parse`, `JSON.stringify`, or heavy `.sort()` in click handlers. **PASS**.

### Touch/Scroll Performance
- No virtualization library (react-window, react-virtual) detected. Lists rendered with `.map()` directly.
- **WARN**: Appointment lists and customer lists could grow to 100+ items. Should add virtualization for large lists.

---

## Category 6: Memory & Resource Leaks

### Status: PASS

### useEffect Cleanup
Checked all `useEffect` with event listeners/timers:
- `App.tsx:241` — `addEventListener("restart-onboarding")` → Has `removeEventListener` in cleanup. **PASS**.
- `signature-pad.tsx:51` — `addEventListener("resize")` → Has cleanup. **PASS**.
- `responsive-tabs.tsx:55` — `media.addEventListener("change")` → Has cleanup. **PASS**.
- `layout.tsx:60` — `addEventListener("mousedown")` → Has cleanup. **PASS**.
- `session-timeout-warning.tsx:78,87` — `setInterval` stored in refs, cleared in cleanup. **PASS**.
- `use-mobile.tsx:13` — `addEventListener("change")` → Has cleanup. **PASS**.
- `address-autocomplete.tsx:79,128` — `setTimeout` with ref, `addEventListener` → Both have cleanup. **PASS**.
- `admin/customers.tsx:55` — `setTimeout` with `clearTimeout` in cleanup. **PASS**.
- `admin/customer-new.tsx:186` — `addEventListener("beforeunload")` → Has cleanup. **PASS**.

### AbortController
API client supports `AbortSignal` in all methods (`get`, `post`, `put`, `patch`, `delete`). However, TanStack Query's signal is not explicitly forwarded in the default `getQueryFn`. **WARN**: Minor — TanStack Query handles cancellation at the observer level.

### Server-Side Resource Cleanup
- `gracefulShutdown()` properly closes:
  - Puppeteer browser (`closeBrowser()`)
  - Database pool (`pool.end()`)
  - HTTP server (`httpServer.close()`)
  - Forced exit after 10s timeout
- **WARN**: Server-side `setInterval` instances (session cleanup, document review, birthday check, budget renewal) are NOT explicitly cleared in `gracefulShutdown()`. They are unreferenced. However, since `process.exit(0)` is called, this is acceptable.

### In-Memory Caches
- `SimpleCache<T>` — Has TTL and periodic garbage collection (`setInterval` for `evictExpired()`). **PASS**.
- `CustomerIdsCacheService` — 10 min TTL. **PASS**.
- `UsersCacheService` — 5 min TTL. **PASS**.
- `use-toast.ts:56` — `toastTimeouts` Map — Entries removed on dismiss. **PASS**.

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Largest component | 1,279 lines (`admin/settings.tsx`) |
| Components > 500 lines | 10 |
| `useMemo` count | 78 |
| `useCallback` count | 144 |
| `useState` count | 444 |
| Array operations in TSX | 132 |
| useQuery calls (total) | ~143 |
| Max queries per page | 11 (`profile.tsx`) |
| Pages with 5+ queries | 11 |
| Server-side caches | 3 (customers IDs, users, birthdays) — all with TTL |
| HTTP cache-control coverage | 4 tiers configured |
| Lazy-loaded routes | 37 |
| Eagerly loaded routes | 3 (Dashboard, Login, NotFound) |
| Prefetch strategies | 0 |
| Skeleton placeholders used | 0 |
| Images without dimensions | 6 |
| N+1 query patterns | 2 (1 in routes, 1 in storage) |
| Unbounded list queries | 2 (`getCustomers()`, `getAppointments()`) |
| Estimated LCP | Medium |
| CLS risk areas | Images without dimensions, spinner-only loading states |
| Memory leak risks | None detected |

---

## Response Time Budget Assessment

| Operation | Assessment | Notes |
|-----------|------------|-------|
| API list endpoints | **AT RISK** | `getCustomers()` and `getAppointments()` unbounded; OK now but will exceed 200ms budget at scale |
| API detail endpoints | **PASS** | Single record lookups with `eq(id)` are fast |
| API complex calculations | **AT RISK** | Budget summary runs 3 parallel aggregations; statistics page runs 7 queries |
| Page initial render (cached) | **PASS** | 2-min staleTime means most returns are from cache |
| Page initial render (first load) | **WARN** | Profile page: 11 queries; could exceed 2s on slow 3G |
| Form submission | **PASS** | Mutations are thin route → storage calls |

---

## Action Items

### FAIL Items (Must Fix)
_None — no critical failures detected._

### High Priority WARN Items
1. **Add pagination to `getCustomers()` and `getAppointments()`** — These unbounded queries will become the #1 bottleneck as data grows. Add `limit/offset` and update frontend to paginate.
2. **Fix N+1 in `billing.ts:391`** — Replace `for...of` + `getCustomer()` loop with `getCustomersByIds(uniqueCustomerIds)` batch call.
3. **Add Skeleton placeholders** — Replace spinner-only loading states with Skeleton components that match content layout to eliminate CLS.
4. **Add explicit dimensions to 6 `<img>` tags** — Prevents CLS on image load.
5. **Implement prefetching on critical paths** — Prefetch appointment detail on hover from appointment list; prefetch customer detail from customer list.

### Medium Priority WARN Items
6. **Decompose large components** — Split `admin/settings.tsx` (1279 lines), `admin/statistics.tsx` (1184 lines), and `customer-detail.tsx` (1168 lines) into focused sub-components.
7. **Add combined API endpoints** — `profile.tsx` (11 queries) and `service-records.tsx` (8 queries) would benefit from a single `/api/profile-data` and `/api/service-records-overview` endpoint.
8. **Add list virtualization** — Install `@tanstack/react-virtual` for appointment and customer lists that can exceed 50 items.
9. **Forward TanStack Query signal** — Pass `signal` from `queryFn` context to the `api.get()` call in `getQueryFn`.
10. **Reduce font weights** — Consider dropping `300` and `700` weight if not critical (saves ~20KB network).

### Low Priority
11. **Batch insert in `qualifications.ts:121`** — Use single `db.insert().values([...])` instead of loop.
12. **Verify database indexes** — Confirm indexes exist on `appointments.date`, `appointments.assignedEmployeeId`, `customers.primaryEmployeeId`, `customers.backupEmployeeId`.
13. **Clear server intervals in shutdown** — Store interval references and `clearInterval()` in `gracefulShutdown()` for cleanliness.

---

## Commands Executed

```bash
# Category 1: Database
grep -rn "for.*of|forEach|.map(" server/storage/ -A3 | grep "await.*db"
grep -rn "Promise.all" server/storage/ server/routes/ -A2
grep -rn ".select()|.from(" server/storage/ | grep -v "limit"
grep -rn ".innerJoin|.leftJoin" server/storage/
grep -rn "count(|sum(|avg(|sql\`" server/storage/ server/routes/

# Category 2: Frontend
find client/src/ -name "*.tsx" -exec wc -l {} \; | sort -rn | head -15
grep -rn "useQuery|useMutation" client/src/ -A3 | grep "staleTime|enabled"
grep -rn "useState" client/src/ --include="*.tsx" | wc -l
grep -rn "useMemo" client/src/ --include="*.tsx" | wc -l
grep -rn "useCallback" client/src/ --include="*.tsx" | wc -l

# Category 3: Bundle
grep -rn "import.*from ['\"]date-fns['\"]" client/src/
grep -rn "import.*from ['\"]lodash['\"]" client/src/
grep -rn "lazy|Suspense" client/src/App.tsx

# Category 4: Network
grep -rn "queryKey:" client/src/ | sort | uniq -c | sort -rn | head -10
grep -rn "prefetch|preload|prefetchQuery" client/src/
grep -rn "cache|Cache|ttl|TTL" server/services/cache.ts
grep -rn "invalidate|.delete|.clear" server/ | grep -i "cache"
for f in $(find client/src/pages -name "*.tsx"); do count=$(grep -c "useQuery" "$f"); if [ "$count" -gt 2 ]; then echo "$f: $count"; fi; done

# Category 5: Mobile
grep -rn "viewport|maximum-scale" client/index.html
grep -rn "fonts.googleapis|@font-face" client/ --include="*.css" --include="*.html"
grep -rn "<img" client/src/ --include="*.tsx" | grep -v "width|height|className"
grep -rn "isLoading.*&&|isPending.*&&" client/src/ --include="*.tsx"
grep -rn "Skeleton" client/src/ --include="*.tsx"

# Category 6: Memory
grep -rn "addEventListener|setInterval|setTimeout" client/src/ --include="*.tsx"
grep -rn "AbortController|signal" client/src/ --include="*.ts"
grep -rn "setInterval|setTimeout|.on(" server/ --include="*.ts"
grep -rn "const.*Map|const.*Set" server/ --include="*.ts"
cat server/middleware/cache-headers.ts
```
