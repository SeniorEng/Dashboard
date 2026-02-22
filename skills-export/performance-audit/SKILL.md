---
name: performance-audit
description: Automated performance audit agent that checks frontend rendering efficiency, backend query performance, bundle size, caching strategies, and mobile optimization. Use after adding new features, large components, complex queries, or before deployment. Ensures the app stays fast and responsive, especially on mobile devices used by caregivers in the field.
---

# Performance Audit Agent

This agent checks for performance issues that degrade user experience, especially on mobile devices. Caregivers use this app on phones in patient homes — performance directly impacts their workflow.

## When to Run

- After adding large new components or pages
- After adding complex database queries or new API endpoints
- After adding new npm dependencies (bundle size impact)
- Before deployment/publishing
- When users report slowness
- During periodic performance reviews (quarterly recommended)

## Core Principle

**Every millisecond counts on mobile.** A caregiver documenting an appointment in a patient's home with poor connectivity needs instant responses. Optimize for the worst-case scenario: slow 3G, old phone, large dataset.

---

## Category 1: Database Query Performance

**Goal**: All queries execute efficiently, no N+1 patterns, proper indexing.

### Steps:
1. **N+1 query detection** (expanded from database-audit Category 5):
   ```bash
   # Find loops with await inside (potential N+1)
   grep -rn "for.*of\|forEach\|\.map(" server/storage/ --include="*.ts" -A3 | grep "await.*db\|await.*storage\|await.*query"
   
   # Find Promise.all with individual queries
   grep -rn "Promise\.all" server/storage/ server/routes/ --include="*.ts" -B2 -A2
   ```

2. **Missing pagination**:
   ```bash
   # Find queries that return all records without limit
   grep -rn "\.select()\|findMany\|\.from(" server/storage/ --include="*.ts" | grep -v "limit\|\.limit("
   ```
   - Verify: List queries have pagination (limit/offset)
   - Verify: Frontend handles pagination (infinite scroll or page controls)

3. **Unoptimized JOINs**:
   ```bash
   # Find JOIN operations
   grep -rn "\.innerJoin\|\.leftJoin\|\.rightJoin\|\.fullJoin" server/storage/ --include="*.ts"
   ```
   - Verify: JOINs are on indexed columns
   - Verify: Only necessary columns are selected (no `SELECT *` on JOINed tables)

4. **Missing indexes for filter/sort columns**:
   ```bash
   # Find WHERE conditions in storage queries
   grep -rn "\.where\|eq(\|and(\|or(\|gt(\|lt(\|gte(\|lte(" server/storage/ --include="*.ts"
   ```
   - Cross-reference with schema indexes to verify coverage

5. **Expensive aggregations**:
   ```bash
   # Find aggregation queries
   grep -rn "count(\|sum(\|avg(\|sql\`" server/storage/ server/routes/ --include="*.ts"
   ```
   - Verify: Aggregations on large tables use indexes
   - Consider: Should results be cached?

### Red Flags:
- Query inside a loop → FAIL (N+1 pattern)
- List endpoint without pagination → WARN (will slow with data growth)
- JOIN on non-indexed column → WARN (slow for large tables)
- `SELECT *` on JOINed query → WARN (unnecessary data transfer)
- Aggregation on full table without cache → WARN

---

## Category 2: Frontend Rendering Performance

**Goal**: No unnecessary re-renders, proper memoization, efficient component structure.

### Steps:
1. **Missing memoization on expensive computations**:
   ```bash
   # Find components with .filter(), .map(), .reduce(), .sort() in render body
   grep -rn "\.filter(\|\.map(\|\.reduce(\|\.sort(" client/src/ --include="*.tsx" | grep -v "useMemo\|useCallback"
   ```
   - Check: Are expensive array operations wrapped in `useMemo`?
   - Note: Not all need memoization — only those with large datasets or expensive transforms

2. **Inline function creation in JSX**:
   ```bash
   # Find arrow functions in JSX props (potential re-render triggers)
   grep -rn "onClick={(" client/src/ --include="*.tsx" | head -20
   ```
   - Note: Most inline handlers are fine. Only flag if the component re-renders frequently and has many children

3. **Large component files**:
   ```bash
   # Find components over 300 lines
   find client/src/ -name "*.tsx" -type f -exec wc -l {} \; | sort -rn | head -10
   ```
   - Verify: Large components are split into focused sub-components
   - Verify: Heavy sub-trees have their own memoization boundaries

4. **TanStack Query configuration**:
   ```bash
   # Check query configurations
   grep -rn "useQuery\|useMutation" client/src/ --include="*.ts" --include="*.tsx" -A3 | grep "staleTime\|cacheTime\|refetchInterval\|enabled"
   ```
   - Verify: Appropriate staleTime for data freshness needs
   - Verify: No unnecessary refetching (e.g., every render)
   - Verify: Queries are disabled when not needed (`enabled: false`)

5. **Unnecessary state updates**:
   ```bash
   # Find state that could be derived
   grep -rn "useState" client/src/ --include="*.tsx" | wc -l
   ```
   - Check: Are any useState calls storing derived data that could be computed from other state/props?

### Red Flags:
- Array.sort() on 1000+ items without useMemo → WARN
- Component > 500 lines without sub-component extraction → WARN
- useQuery without staleTime on stable data → WARN
- Derived state stored in useState instead of computed → WARN
- Multiple sequential state updates that could be batched → WARN

---

## Category 3: Bundle Size & Code Splitting

**Goal**: Initial load is fast, unnecessary code is lazy-loaded.

### Steps:
1. **Check bundle size**:
   ```bash
   # Build and analyze
   npx vite build 2>&1 | tail -30
   ```
   - Note total bundle size and largest chunks

2. **Large dependency imports**:
   ```bash
   # Find imports of large libraries
   grep -rn "import.*from ['\"]date-fns['\"]" client/src/ --include="*.ts" --include="*.tsx"
   grep -rn "import.*from ['\"]lodash['\"]" client/src/ --include="*.ts" --include="*.tsx"
   ```
   - Verify: Tree-shakeable imports (e.g., `from "date-fns/format"` not `from "date-fns"`)
   - Verify: No full library imports when only one function is needed

3. **Lazy loading for routes**:
   ```bash
   # Check if routes use lazy loading
   grep -rn "lazy\|Suspense\|React\.lazy\|import(" client/src/App.tsx
   ```
   - Verify: Non-critical pages are lazy-loaded
   - At minimum: Admin pages should be lazy-loaded (not all users need them)

4. **Image optimization**:
   ```bash
   # Find image references
   grep -rn "\.png\|\.jpg\|\.jpeg\|\.svg\|\.gif\|\.webp" client/src/ --include="*.tsx" --include="*.ts"
   find client/public/ -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" 2>/dev/null | xargs ls -lh 2>/dev/null
   ```
   - Verify: Images are optimized (compressed, appropriate format)
   - Verify: Large images use lazy loading

### Red Flags:
- Total bundle > 500KB gzipped → WARN
- Single chunk > 200KB → WARN (consider splitting)
- Full library import when only one function needed → WARN
- No lazy loading on admin/settings pages → WARN
- Uncompressed images > 100KB → WARN

---

## Category 4: Network & API Performance

**Goal**: API responses are fast, minimal data transferred, proper caching.

### Steps:
1. **Response payload size**:
   ```bash
   # Check for large response objects
   grep -rn "res\.json\|res\.send" server/routes/ --include="*.ts" -B5
   ```
   - Verify: Only necessary fields returned (no full objects when list needs summary)
   - Verify: List endpoints return paginated results

2. **Missing server-side caching**:
   ```bash
   # Check for in-memory caching
   grep -rn "cache\|Cache\|memoize\|ttl\|TTL" server/ --include="*.ts"
   ```
   - Consider: Are there frequently-accessed, rarely-changing datasets that should be cached?
   - Examples: Customer list, employee list, insurance providers

3. **Duplicate API calls**:
   ```bash
   # Check for same queryKey used in multiple components
   grep -rn "queryKey:" client/src/ --include="*.ts" --include="*.tsx" | sed 's/.*queryKey://' | sort | uniq -c | sort -rn | head -10
   ```
   - Verify: TanStack Query deduplicates requests with same key
   - Verify: No manual fetching that bypasses TanStack Query

4. **Request waterfall**:
   ```bash
   # Check for sequential API calls that could be parallel
   grep -rn "await.*fetch\|await.*api" client/src/ --include="*.ts" --include="*.tsx" -A2 | grep -A2 "await"
   ```
   - Verify: Independent API calls are made in parallel, not sequentially

5. **Multiple frontend API calls per page load**:
   ```bash
   # Find pages/components that make multiple useQuery calls
   for f in $(find client/src/pages -name "*.tsx"); do
     count=$(grep -c "useQuery\|useSuspenseQuery" "$f" 2>/dev/null)
     if [ "$count" -gt 2 ]; then echo "$f: $count queries"; fi
   done
   ```
   - If a page makes 3+ independent queries on mount, consider combining into a single `/page-data` endpoint
   - Pattern: Backend endpoint uses `Promise.all` to parallelize queries, returns combined result
   - Example: `/api/time-entries/page-data/:year/:month` combines overview + vacation-summary + open-tasks

6. **Cache invalidation completeness**:
   ```bash
   # Find all cache instances and their invalidation calls
   grep -rn "invalidate\|\.delete\|\.clear" server/ --include="*.ts" | grep -i "cache"
   
   # Find all mutation operations (create/update/delete) in storage
   grep -rn "async create\|async update\|async delete\|db\.insert\|db\.update\|db\.delete" server/storage.ts
   ```
   - Cross-reference: Every mutation that changes cached data must invalidate the relevant cache
   - Known caches and their invalidation triggers (see replit.md for full list):
     - `customerIdsCache`: Customer CRUD, admin assignments, appointment creation with assignedEmployeeId
     - `sessionCache`: Logout, password change
     - `birthdayCache`: Customer CRUD
   - New mutations must check if they affect any existing cache

7. **Expensive subqueries replaceable by cache**:
   ```bash
   # Find UNION subqueries or complex WHERE IN subqueries in storage
   grep -rn "union\|UNION\|subquery\|\.where.*inArray.*select" server/storage.ts --include="*.ts"
   ```
   - Complex subqueries (e.g., UNION to find all customer IDs across assignments + appointments) should be replaced with cached ID lists when called frequently
   - Pattern: Cache the ID list with TTL, invalidate on relevant mutations

### Red Flags:
- List endpoint returning 100+ items without pagination → FAIL
- Same data fetched from multiple components without shared cache → WARN
- Sequential API calls that could be parallel → WARN
- Large response payloads (>50KB for list endpoints) → WARN
- Page making 3+ separate API calls that could be one combined endpoint → WARN
- Mutation operation that doesn't invalidate affected caches → FAIL
- Complex subquery running on every request when result could be cached → WARN

---

## Category 5: Mobile-Specific Performance

**Goal**: App performs well on mobile devices with limited resources.

### Steps:
1. **Touch responsiveness**:
   ```bash
   # Check for heavy computations on user interaction
   grep -rn "onClick\|onChange\|onSubmit" client/src/ --include="*.tsx" -A3 | grep "\.filter\|\.sort\|\.reduce\|for "
   ```
   - Verify: Heavy computations are debounced/throttled on mobile
   - Verify: No blocking operations in event handlers

2. **Scroll performance**:
   ```bash
   # Check for long lists without virtualization
   grep -rn "\.map(" client/src/ --include="*.tsx" -B3 | grep -i "list\|card\|item\|row"
   ```
   - Verify: Lists with potentially 50+ items use virtualization or pagination
   - Note: For this app, appointment lists and customer lists are the main concerns

3. **Font and asset loading**:
   ```bash
   # Check for external font loading
   grep -rn "fonts\.googleapis\|@import.*font\|@font-face" client/ --include="*.css" --include="*.html"
   ```
   - Verify: Fonts are loaded with `font-display: swap` to prevent invisible text

4. **Viewport and mobile meta tags**:
   ```bash
   grep -rn "viewport\|maximum-scale\|user-scalable" client/index.html
   ```
   - Verify: `maximum-scale=1` prevents unintended zoom
   - Verify: `viewport` is properly configured for mobile

### Red Flags:
- List rendering 100+ DOM nodes without virtualization → WARN
- Blocking computation in event handler → WARN
- External fonts without font-display: swap → WARN
- Missing viewport meta tag → FAIL

---

## Output Format

```
## Performance Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Query Performance | PASS/WARN/FAIL | Details |
| 2. Rendering | PASS/WARN/FAIL | Details |
| 3. Bundle Size | PASS/WARN/FAIL | Details |
| 4. Network/API | PASS/WARN/FAIL | Details |
| 5. Mobile | PASS/WARN/FAIL | Details |

### Performance Metrics
- Bundle size: XX KB (gzipped)
- Largest component: XX lines
- Query count on main page: XX
- Cached endpoints: XX/XX

### Action Items
- FAIL items: Must fix (user-facing performance impact)
- WARN items: Should optimize (future-proofing)

### Commands Executed
[List exact commands and key measurements]
```
