---
name: api-contract-audit
description: Automated API contract audit that validates type consistency between shared API types, backend route responses, and frontend consumption. Use after ANY code change that touches API routes, response shapes, shared/api/ types, or frontend API type imports. Ensures a single source of truth for API contracts and catches drift between layers.
---

# API Contract Audit Agent

This agent ensures that the API contract — the shape of data exchanged between backend and frontend — is defined once in `shared/api/` and consistently used on both sides. It catches type drift, untyped responses, duplicate type definitions, and missing generic parameters in API calls.

## Architecture Overview

The project uses a 3-layer type contract system:

```
shared/api/          ← Canonical type definitions (single source of truth)
  ├── index.ts       ← Barrel re-export
  ├── pagination.ts  ← PaginationParams, PaginatedResponse
  ├── customers.ts   ← CustomerDetail, CustomerListItem, ...
  ├── billing.ts     ← InvoiceItem, GenerateResponse, ...
  ├── appointments.ts
  ├── time-tracking.ts
  ├── employees.ts
  └── insurance.ts

server/routes/       ← Backend: imports from @shared/api, annotates responses
client/src/lib/api/  ← Frontend: re-exports from @shared/api via types.ts
```

**Key files:**
- `shared/api/index.ts` — barrel export, all types accessible via `@shared/api`
- `client/src/lib/api/types.ts` — re-exports from `@shared/api` for frontend use
- `server/routes/*.ts` — backend routes that should annotate responses with shared types

## When to Run

- After adding or modifying API routes or endpoints
- After changing response shapes (adding/removing fields from API responses)
- After modifying `shared/api/` type definitions
- After adding new `useMutation` or `useQuery` hooks in the frontend
- After migrating types from local definitions to shared definitions
- After refactoring that touches API client code (`client/src/lib/api/`)
- Before deployment (as part of full team audit)

## Audit Process

Work through all 6 categories. For each, report: PASS, WARN, or FAIL.

---

## Category 1: Shared Type Coverage

**Goal**: Every API route that returns structured data has a corresponding type in `shared/api/`.

### Steps:
1. **Inventory all API routes**:
   ```bash
   grep -rn "router\.\(get\|post\|patch\|put\|delete\)" server/routes/ --include="*.ts" | grep -v "node_modules"
   ```
2. **Inventory all shared API types**:
   ```bash
   grep -rn "^export interface\|^export type" shared/api/ --include="*.ts"
   ```
3. **Cross-reference**: For each route that returns `res.json(data)`, verify a matching type exists in `shared/api/`.
4. **Check barrel export**: Every type in a `shared/api/*.ts` module must be re-exported from `shared/api/index.ts`:
   ```bash
   grep -rn "^export" shared/api/index.ts
   ```

### Red Flags:
- API route returns complex JSON but no shared type exists → FAIL: create type in `shared/api/`
- Type exists in `shared/api/` module but not in barrel `index.ts` → WARN: add to barrel export
- Route returns `res.json({...})` with inline object literal (no typed variable) → WARN: extract to typed const

---

## Category 2: Backend Route Annotation

**Goal**: Backend routes annotate response variables with shared types so TypeScript validates response shape consistency.

### Steps:
1. **Find routes importing from `@shared/api`**:
   ```bash
   grep -rn "from ['\"]@shared/api['\"]" server/routes/ --include="*.ts"
   ```
2. **For each import, verify usage**: Check that imported types are actually used as annotations:
   ```bash
   # For each imported type, search for its usage in the same file
   # Good: `const data: CustomerDetail = { ... }`
   # Good: `const items: BillingCustomerItem[] = await db.select(...)`
   # Bad: `import type { CustomerDetail } from "@shared/api"` but never referenced
   ```
3. **Find untyped `res.json()` calls** in routes that have shared types available:
   ```bash
   grep -rn "res\.json(" server/routes/ --include="*.ts" | grep -v "error\|message\|status"
   ```
4. **Check for type assertions**: When server-internal types don't perfectly align with shared types, `as unknown as SharedType` is acceptable but should be documented:
   ```bash
   grep -rn "as unknown as" server/routes/ --include="*.ts"
   ```

### Red Flags:
- Shared type imported but never used in file → FAIL: either annotate or remove import
- Route returns complex data without any shared type annotation → WARN: add annotation
- More than 3 `as unknown as` casts in a single route file → WARN: shared types may need alignment with server internals

---

## Category 3: Frontend Type Consumption

**Goal**: Frontend uses `@shared/api` types exclusively — no local interface duplication.

### Steps:
1. **Check re-export layer** (`client/src/lib/api/types.ts`):
   ```bash
   grep -n "export" client/src/lib/api/types.ts
   ```
   All exports should be `export { ... } from "@shared/api"` or `export type { ... } from "@shared/api"`.
2. **Search for local interface definitions** that duplicate shared types:
   ```bash
   grep -rn "^interface \|^export interface " client/src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v "\.d\.ts"
   ```
   Cross-reference with `shared/api/` — if a local interface matches a shared type name, it's a duplicate.
3. **Check import paths**: Frontend files should import API types from `@shared/api` or `client/src/lib/api/types`:
   ```bash
   # Good imports
   grep -rn "from ['\"]@shared/api['\"]" client/src/ --include="*.ts" --include="*.tsx"
   grep -rn "from ['\"].*lib/api/types['\"]" client/src/ --include="*.ts" --include="*.tsx"
   
   # Suspicious: local type definitions that shadow shared types
   grep -rn "interface.*Response\|interface.*Item\|interface.*Detail" client/src/pages/ --include="*.tsx"
   ```

### Red Flags:
- Local interface in `client/src/pages/` that duplicates a `shared/api/` type → FAIL: import from shared
- `client/src/lib/api/types.ts` defines own interfaces instead of re-exporting → FAIL: convert to re-exports
- Frontend file imports from `server/` directory → FAIL: use shared types only

---

## Category 4: Mutation Type Safety

**Goal**: All `api.post<T>()`, `api.patch<T>()`, `api.put<T>()`, `api.delete<T>()` calls have explicit generic type parameters.

### Steps:
1. **Find all mutation API calls**:
   ```bash
   grep -rn "api\.\(post\|patch\|put\|delete\)(" client/src/ --include="*.ts" --include="*.tsx"
   ```
2. **Check for missing generics**: Lines without `<...>` after the method name produce `Promise<unknown>`:
   ```bash
   # Lines WITHOUT generic type parameter (bad)
   grep -rn "api\.post(" client/src/ --include="*.tsx" | grep -v "api\.post<"
   grep -rn "api\.patch(" client/src/ --include="*.tsx" | grep -v "api\.patch<"
   grep -rn "api\.put(" client/src/ --include="*.tsx" | grep -v "api\.put<"
   grep -rn "api\.delete(" client/src/ --include="*.tsx" | grep -v "api\.delete<"
   ```
3. **Verify response type usage**: After `unwrapResult(result)`, the return value should have a known type, not `unknown`:
   ```bash
   grep -rn "unwrapResult" client/src/ --include="*.tsx" -A 1
   ```
4. **Cross-reference with `onSuccess` handlers**: If `onSuccess` has a typed parameter like `(data: GenerateResponse)`, the mutation function must return that type:
   ```bash
   grep -rn "onSuccess.*data:" client/src/ --include="*.tsx"
   ```

### Red Flags:
- `api.post(` without generic → FAIL: add `api.post<ResponseType>(...)`
- `unwrapResult` returns `unknown` due to missing generic → FAIL: add type parameter
- `onSuccess: (data: any)` → FAIL: use specific shared type
- GET queries using `api.get(` without generic → WARN: add type for strict type safety

---

## Category 5: Response Shape Drift Detection

**Goal**: Track `tsc --noEmit` error baseline and ensure no new type errors are introduced by API contract changes.

### Steps:
1. **Run TypeScript compiler**:
   ```bash
   npx tsc --noEmit 2>&1 | grep -c "error TS"
   ```
2. **Record baseline**: Note the current error count. Check `replit.md` for the documented baseline.
3. **Categorize errors by source**:
   ```bash
   # Errors in our changed files (should be 0)
   npx tsc --noEmit 2>&1 | grep "error TS" | grep -E "(shared/api|client/src/lib/api|server/routes)" 
   
   # Pre-existing errors in untouched files (acceptable)
   npx tsc --noEmit 2>&1 | grep "error TS" | grep -v -E "(shared/api|client/src/lib/api|server/routes)"
   ```
4. **Detect new errors introduced by type changes**:
   ```bash
   # Compare current error count with baseline
   # If current > baseline → FAIL
   # If current <= baseline → PASS
   ```

### Red Flags:
- New `tsc` errors introduced by shared type changes → FAIL: fix type definitions or annotations
- Error count increased from documented baseline → WARN: investigate and document
- Type errors in `shared/api/*.ts` files → FAIL: canonical types must compile cleanly
- `any` type used in shared API types → FAIL: shared types must be fully typed

---

## Category 6: Unused & Orphaned Types

**Goal**: No dead imports, no orphaned type definitions, no types that exist but are never consumed.

### Steps:
1. **Find unused imports from `@shared/api`**:
   ```bash
   # For each file importing from @shared/api, check if the imported names are used
   grep -rn "import.*from ['\"]@shared/api['\"]" server/routes/ client/src/ --include="*.ts" --include="*.tsx"
   # Then for each imported name, verify it appears elsewhere in the file
   ```
2. **Find orphaned shared types** (defined but never imported anywhere):
   ```bash
   # List all exported types from shared/api/
   grep -h "^export interface\|^export type" shared/api/*.ts | sed 's/export \(interface\|type\) //' | sed 's/[< {].*//'
   
   # For each type name, search for imports across the codebase
   # If a type is never imported → orphaned
   ```
3. **Check server storage re-exports**: Server storage files should import from `@shared/api` for types that are shared, not redefine them:
   ```bash
   grep -rn "^export interface\|^export type" server/storage/ --include="*.ts" | grep -v "IStorage\|Filters\|I[A-Z]"
   ```
   Cross-reference with `shared/api/` — if a server storage type matches a shared type name, the server should import from shared.

### Red Flags:
- Type imported but never used in file → FAIL: remove unused import
- Type defined in `shared/api/` but never imported anywhere → WARN: remove orphaned type or document why it exists
- Same type name defined in both `shared/api/` and `server/storage/` → FAIL: server should import from shared
- Same type name defined in both `shared/api/` and `client/src/` → FAIL: frontend should import from shared

---

## Output Format

```
## API Contract Audit Results

| Category | Result | Findings |
|----------|--------|----------|
| 1. Shared Type Coverage | PASS/WARN/FAIL | [details] |
| 2. Backend Route Annotation | PASS/WARN/FAIL | [details] |
| 3. Frontend Type Consumption | PASS/WARN/FAIL | [details] |
| 4. Mutation Type Safety | PASS/WARN/FAIL | [details] |
| 5. Response Shape Drift | PASS/WARN/FAIL | [details] |
| 6. Unused & Orphaned Types | PASS/WARN/FAIL | [details] |

### Overall: [PASS / WARN / FAIL]
### tsc Baseline: [X errors] (documented: [Y])

### FAIL Items (Must Fix)
[list]

### WARN Items (Should Fix)
[list]
```

---

## Cross-References to Other Agents

- **Code Quality Supervisor** — Category 1 (Duplicate Detection) overlaps: if Code Quality finds duplicate types, this agent determines which should be the canonical shared version
- **Database Audit** — Category 2 (Storage-Frontend Consistency) complements: Database Audit checks data flow correctness, this agent checks type correctness
- **Regression Guard** — Category 2 (API Contract Regression) overlaps: Regression Guard catches structural breaks, this agent catches type-level drift
- **Error Handling Audit** — Complements: Error Handling checks error response types, this agent checks success response types

---

## Time Budgets

| Depth | Time | Categories |
|-------|------|------------|
| Quick Check | 5 min | Cat 4, 5 only (mutation safety + tsc baseline) |
| Standard Audit | 10 min | Cat 1-5 |
| Full Audit | 15 min | All 6 categories |
