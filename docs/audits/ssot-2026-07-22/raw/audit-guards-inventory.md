# CareConnect — Inventory of existing redundancy/SSoT enforcement and its gaps

Audit date: 2026-07-22. Sources read: `tests/architecture/*` (44 test files + helpers + README),
`tests/equality/*` (54 files) + `tests/helpers/equality-check.ts`, `tests/query-invalidation-discipline.test.ts`,
`eslint.config.js` + `eslint/soft-deletable-tables.mjs`, `knip.json`, `.github/workflows/ci.yml`,
`script/coverage-gate.ts`, `docs/budget-ssot-audit.md`, `replit.md`, `package.json`.

---

## 1. Enforcement mechanics (how guards work)

- **`tests/architecture/guard-helpers.ts`** — pure detector pattern: every guard is a pure function over
  `{rel, content}` file lists (`collectScanFiles(roots)`), so the *same* detector runs against the real tree
  AND against synthetic violation strings ("Negativ-Test proves a planted violation breaks CI").
  `stripComments()` avoids doc-mention false positives.
- **`tests/architecture/ast-grep-helpers.ts`** — `@ast-grep/napi` in-process TS/TSX AST parsing:
  `parseSource`, `walkTsFiles` (skips `.d.ts`/node_modules/dist), `collectNamedFunctions` (only real
  declarations, not call sites/comments/strings), `collectNamedScopes` + `enclosingScopeNames`
  (Task #1522: rate literals nested deep inside rate-named objects/functions are attributed to that scope).
- **`tests/helpers/equality-check.ts`** — `assertDisplayEqualsBooking` runtime drift harness: per scenario
  runs the real read ("Anzeige") path and the real write ("Buchung") path, extracts one number from each,
  fails on |Δ| > tolerance (default 0). Explicitly mocks nothing.
- **Typical guard scan scope**: `["server", "shared"]` for write-path guards, `["server", "shared",
  "client/src"] {includeTsx:true}` for display/SSoT guards. Most guards use allowlists that must be
  consciously edited.

## 2. Architecture fitness functions (tests/architecture/, 44 files — CI Gate 5 + full vitest Gate 4)

One line each: guard -> what it enforces.

| Guard | Enforces |
|---|---|
| `appointment-status-partition-consumers` | The 3 consumers of the FINAL/UNDOCUMENTED appointment-status partition import the SSoT lists from `shared/domain/appointments.ts` — no re-listed status literals (server+shared+client). |
| `asyncHandler-coverage` | Every Express route registration in the object-storage routes file wraps its handler in `asyncHandler(...)` (AST). |
| `billing-pipeline-stage-identity` | Billing-pipeline stage mapping is TOTAL and DISJOINT — every atomic € unit maps to exactly one stage/badge/exclusion. |
| `budget-allocation-source-write-path` | `budget_allocations` inserts only via the single write path and only with the 3 manual-fact sources; removed legacy sources (`monthly*`, `yearly_auto`…) banned. |
| `budget-anchor-ssot` | No reintroduction of stored budget-anchor columns/reads (`budget_start_date*`) — anchor is derived at runtime per pot. |
| `budget-backdate-override-surface` | Bypass flag `overrideBackdateGuard` may appear in exactly 3 server files (route gate, preferences-storage SSoT, storage facade). |
| `budget-default-pots-ssot` | `DEFAULT_BUDGET_POT_ORDER` is module-private; everyone must use `effectiveDefaultPots(customer)` (cross-tree mirror of the ESLint import ban). |
| `budget-hard-holds-production-enabled` | `BUDGET_HARD_HOLDS` feature flag must be enabled in the `.replit` production env scope. |
| `budget-legal-spec-conformance` | Budget code constants byte-match the statutory amounts in `docs/budget-legal-spec.md` (spec-vs-code drift gate). |
| `budget-sentinel-uniqueness` | The `"1970-01-01"` backfill sentinel literal exists only in `shared/domain/budget-settings-sentinel.ts` (+ SQL-migration whitelist). |
| `budget-single-reader` | ONE availability reader: reads of `.netUsedInWindowCents`, `netAvailable45bAt`, `computeNetAvailable45b` restricted to an allowlist (invariant I1). |
| `budget-transactions-write-path` | `budget_transactions` is append-only — no UPDATE/DELETE writers outside allowlist (GoBD; corrections only via storno insert). |
| `budget-typesettings-read-path` | Value-relevant paths read budget-type settings `forDate` (asOfDate-pinned); latest-intent `forEdit` reads only on allowlisted edit surfaces (C-03). |
| `budget-typesettings-write-path` | Only `preferences-storage.ts` (SSoT upsert) + deletion-cascade write `customer_budget_type_settings`. |
| `budget-write-off-classification` | Every file aggregating `write_off` together with `consumption` must be allowlisted per view (pot-view counts it, cap-window-view doesn't). |
| `calculations-in-shared` | New `calculate*`/`compute*` functions for hotspot categories (cap/45a/45b, Pflegegrad-price, pro-rata/vacation/entitlement, travel, cutoff/month-close) must live in `shared/domain|utils`; PLUS hardcoded catalog-rate/km-rate magic numbers (3800/1600/4200/1800 cents incl. hex/`16*100`/`38_00` obfuscations, 0.30/0.35 km) detected via money-keyword window + AST enclosing-scope names. |
| `content-disposition-via-helper` | All `Content-Disposition` headers built via `buildContentDisposition` SSoT (`shared/domain/invoice-export-filename.ts`). |
| `dev-db-guard-parity` | TS (`server/lib/dev-db-guard.ts`) and Bash (`scripts/lib/assert-dev-db.sh`) prod-guard implementations stay behavior-identical (cross-language fixtures). |
| `dev-db-scripts-guard` | Black-box guard: backup/reseed shell scripts refuse prod hosts / fail closed (always-on CI Gate 11). |
| `km-display-via-helper` | km quantity display only via `renderLineItemQuantity`/`formatKmQuantityDisplay` — no ad-hoc `${x} km` template strings (allowlist; server+client+shared). |
| `mock-export-completeness` | `vi.mock` factories of guarded helper modules must export a superset of the real module's function exports (AST; allowlist `GUARDED_MODULES`). |
| `no-bare-number-in-import` | No raw `Number(...)` on Excel cell values in `appointment-import.ts` — decimal columns must use `parseGermanDecimal` (AST). |
| `no-customer-budgets-reads` | No new read/write of the dropped legacy `customer_budgets` table. |
| `no-dead-object-download-url` | Every client download URL for stored objects points to an actually registered server route. |
| `no-firewall-url-in-lockfile` | No Replit-internal `package-firewall.replit.local` URLs in the committed lockfile. |
| `no-hardcoded-chromium-path` | No hardcoded Nix-store Chromium paths under `server/` (runtime resolution only). |
| `no-leaked-fetch-stub` | Any `vi.stubGlobal("fetch", …)` must be restored in the same test file. |
| `no-money-arithmetic-outside-helper` | No manual money formatting/arithmetic (`(x/100).toFixed(2)` & co.) outside `shared/utils/money.ts` (server+client+shared). |
| `no-null-appointment-id-in-reversal` | Reversal/consumption inserts keep the original `appointmentId` — no `appointmentId: null` ledger orphans. |
| `no-raw-service-vat-rate` | `services.vatRate` (percent) never raw-multiplied/divided outside the VAT SSoT `shared/domain/invoice-vat.ts` (`serviceVatRateBP`). |
| `no-render-inside-transaction` | No Puppeteer render inside a held DB transaction in invoice render/send paths. |
| `no-show-value-guard` | Every client surface rendering no-show values carries a stable `data-testid` guard (round-trip testability). |
| `phantom-storno-detector` | Pure SSoT logic (`shared/domain/budget/phantom-storno.ts`) detecting the phantom double-credit storno pattern — shared by reconcile script AND write guard. |
| `price-ssot-read-path` | No direct reads of the 3 legacy price tables outside the `priceFor` SSoT. ARMED since Task #1325 cutover (empty allowlist) — but the file header still claims `it.skip` (stale doc). |
| `replit-boot-path` | Workspace `runButton` boots only the app, never the 5 heavy check workflows. |
| `schema-table-allowlist` | The set of `pgTable` definitions in `shared/schema/` is frozen to an explicit allowlist — the only mechanized "replace, don't add" gate. |
| `sensitive-columns` | Schema columns whose DB name matches /secret\|token\|password\|key/i must use `encryptedText(...)`. |
| `soft-delete-coverage` | Snapshot per routes/storage/services file of referenced soft-deletable tables (complements the ESLint `restrictSoftDeleteFrom` rule). |
| `ssot-imports` (A1–A5) | A1 cap math (`computeCapSlot`/`computeCapRemaining`) imported budget-internally only; A2/A2b exactly one month-close readiness definition + no second blocker aggregation; A3 no hand-rolled `signature_data` "documented?" conditions; A4 `planCascade` call-site allowlist; A5 no hand-rolled `acceptsPrivatePayment \|\| selbstzahler` formula. |
| `startup-steps-fault-isolated` | Every step in `runStartupTasks` has its own try/catch (no cascade abort of the migration chain). |
| `sweep-dev-guard` | Sweep-script prod guards, DB-free (always-on CI Gate 12). |
| `team-workload-single-source` | Team capacity/workload math only via `computeTeamWorkload` SSoT (`shared/domain/team-workload.ts`); consumers are thin adapters. |
| `use-mutation-error-handler` | Every client `useMutation` has `onError` or a justified `onError-waived:` comment. |
| `wage-data-access-gate` | Pinned register of wage-bearing routes; each must carry `requireWageDataAccess` (superadmin-only) middleware. |

## 3. Runtime drift detectors (tests/equality/, 54 files + a dozen more in tests/ root)

`assertDisplayEqualsBooking` harness — real read path vs real write path, exact-equality default. Covered
hotspots: §45b/§45a/§39-42a caps & carryover & FIFO (13 files), budget overview/history/ledger display vs
booking, storno symmetry (4), invoice arithmetic/VAT/pot split/PDF-XML parity (8), ZUGFeRD roundtrip/XSD (3),
import midnight/update drift + preview-vs-booking, travel cost/km roundtrip, no-show wage/km/travel-pay SSoT,
pro-rata vacation, admin-vs-employee hours, month-close cutoff, Pflegegrad pricing, customer address SSoT,
appointment rebook (single/series/exception). Related root-level drift tests: `economics-effective-rate-drift`,
`economics-payroll-revenue-drift`, `mitarbeiterabrechnung-*-parity`, `lexware-export-unsigned-list-matches-*`,
`import-preview-vs-booking`, `audit-billed-import-drift`.
**Caveat:** `tests/helpers/known-failing.ts` quarantines the km-rebook/km-drift suites whenever `CI=true`
(pre-existing `budget_transactions_appointment_required_check` conflict) — those drift detectors do NOT run
in the mandatory pipeline, only locally/dev.

## 4. Other checks

- **`tests/query-invalidation-discipline.test.ts`** — forbids raw `queryClient.invalidateQueries` outside
  `client/src/lib/query-invalidation.ts` (marker opt-out) AND requires every budget-related queryKey to be
  registered in `DOMAIN_QUERY_KEYS.budget`. Regex-based; lives OUTSIDE tests/architecture (runs in Gate 4, not
  in the dedicated Gate 5); duplicates the ESLint rule (two mechanisms for one question).
- **ESLint (`eslint.config.js`)** — 3 custom bans: `restrictSoftDeleteFrom` (no direct
  `db.select().from(<soft-deletable>)` in routes/storage/services; table list SSoT in
  `eslint/soft-deletable-tables.mjs`), `restrictInvalidateQueries` (client), `restrictDefaultPotOrderImport`
  (client + server blocks). Plus `react-hooks/rules-of-hooks`.
  **BUT `package.json` lint script is `eslint client/src server/routes --max-warnings 0`** — see gaps.
- **knip (`knip.json`)** — dead-code/unused-export detection over client+server+shared; ignores
  `client/src/components/ui/**`, `server/replit_integrations/**`. In CI it is **warning-only**
  (`continue-on-error: true`, report artifact only uploaded on failure).
- **CI (`.github/workflows/ci.yml`)** — mandatory gates: 0 lockfile-guard, 1 `npm ci`, 2 tsc, 3 eslint,
  4 full vitest, 5 `vitest run tests/architecture/`, 6 npm audit, 7 Playwright smoke, 8 four targeted
  coverage gates, 9 OpenAPI drift (`gen:openapi --check`), 10 e-invoice validation (strict WASM-XSD always;
  Mustang/veraPDF path-gated), 11/12 dev-db & sweep prod-guards (always-on), + no-test-junk guard,
  + Stryker mutation gate (PR-only, incremental, 60% break) on **11 hardcoded hotspot modules** listed in
  ci.yml (invoice-line-items, budget-invoice-split, cost-estimate-outcome, cap-math, history-aggregation,
  budgets, vacation, cancellation-policy, money, import-cutoff, month-close-cutoff).
  **Caveat:** gates 4/5/7/8 skip silently without `TEST_USER_*` secrets (forks) — only static gates run.
- **`script/coverage-gate.ts`** — per-file line/branch floors for exactly 4 modules: `server/routes/billing.ts`
  (20/38, skips entirely in GitHub CI — no object storage), `server/services/qonto.ts` (48/60),
  `server/storage/budget/consumption-engine.ts` (82/62), `server/services/month-close-scheduler.ts` (33/21).
  Hard-fails on 0-measured-lines (no false-positive pass).
- **`docs/budget-ssot-audit.md` methodology** — per business question: name the SSoT, classify
  (SSoT vs hand-rolled), pin ≥1 build-breaking guard, date-pinning note, guard matrix. Executed for the four
  budget questions (Q1 available? Q2 cascade? Q3 default pots? Q4 private allowed?) and (via
  `docs/price-wage-km-rate-audit.md`) for price/wage/km rates. **Not repeated for any other domain.**

---

## 5. GAPS

### 5.1 Business domains/questions in `shared/domain/` with NO static SSoT guard

(unit/equality tests may exist, but nothing statically prevents a second, diverging implementation)

- **Statistics/economics** (`shared/domain/statistics/economics.ts`): drift tests exist
  (`economics-*-drift`) but no import-boundary/single-reader guard; a second economics/KPI calculator with a
  non-`calculate*` name passes all gates.
- **Time entries / hours** (`shared/domain/time-entries.ts`): "how many hours did employee X work?" has no
  single-reader guard; only pairwise parity tests (admin-vs-employee-hours, mitarbeiterabrechnung parity).
- **Vacation** (`shared/domain/vacation.ts`): name-pattern (`calculate*Vacation|Entitlement`) + mutation +
  pro-rata equality test, but no guard forcing all entitlement consumers through the SSoT.
- **Documents** (`document-triggers.ts`, `document-page-geometry.ts`, `documentation-diagnostics.ts`):
  only the Content-Disposition helper guard; document-trigger/type logic unguarded.
- **Cancellation** (`shared/domain/cancellation-policy.ts`): mutation hotspot only; a second
  cancellation-fee computation is undetectable (names outside hotspot patterns).
- **Imports** (`import-cutoff.ts`, `import-appointment-action.ts`, `import-documentation-only.ts`):
  bug-specific guards (`no-bare-number`, `no-null-appointment-id`) exist, but "preview == booking" is only a
  runtime equality test — no static single-path guard for import decision logic.
- **Invoicing** (invoice-line-items/-aggregation, budget-invoice-split, invoice-number, invoice-status,
  billing-drafts/-eligibility/-blockers beyond A2b): VAT + km display + pipeline-stage identity are guarded;
  invoice-number generation, line aggregation and status derivation have no import-boundary guard.
- **Qonto** (`shared/domain/qonto/` — 8 modules: avis-match, payment-difference, hide-rules, …): zero
  architecture guards; only a coverage floor on `server/services/qonto.ts`.
- **Wage ("Lohn?")** (`shared/domain/pricing/wage-for.ts`): `wage-data-access-gate` is authorization only —
  there is NO wage analog of `price-ssot-read-path` (nothing bans direct wage-table reads outside `wageFor`).
- **Customers lifecycle** (`shared/domain/customers/lifecycle.ts`), **appointment-attribution**,
  **appointment-party-name**, **excel-service-art**, **budget-rebook-triggers**: no guards.

### 5.2 Directories that escape linting

`npm run lint` (CI Gate 3) = `eslint client/src server/routes` ONLY. Consequences:
- `server/storage/**` and `server/services/**` have ESLint rule blocks in `eslint.config.js`
  (soft-delete ban, DEFAULT_BUDGET_POT_ORDER import ban) that are **dead config in CI** — those dirs are
  never passed to eslint.
- Never linted at all: `shared/**` (the SSoT layer itself!), `server/lib`, `server/startup`,
  `server/scripts`, `server/repos`, `scripts/`, `script/`, `tests/`, `e2e/`, root `*.ts`.
- Config also globally ignores `**/*.config.{js,ts,mjs,cjs}`.
- Partial compensation: `soft-delete-coverage.test.ts` snapshot does scan routes+storage+services, and the
  default-pots ban is mirrored by `budget-default-pots-ssot.test.ts` (cross-tree). No compensation exists
  for future ESLint-only rules.

### 5.3 Enforcement that exists only as convention/docs (no failing check)

- **"Ersetzen statt hinzufügen" (replace, don't add)** — replit.md rule; mechanized ONLY for DB tables
  (`schema-table-allowlist`). No allowlist/gate for new routes/endpoints, new `shared/domain` modules, new
  exported functions, new query keys, new npm scripts, new client pages.
- **"One SSoT per business question"** — enforced for budget Q1–Q4, price read path, month-close readiness,
  "documented?", team workload, VAT, money format, km display, appointment-status partition. Everything else
  (5.1 list) is convention.
- **Integer-cents-only** — money *formatting* patterns are guarded; no guard detects float-euro arithmetic
  or new `number`-euro fields per se.
- **docs/pricing-ssot.md, docs/budget-ssot-inventory.md decisions, docs/page-size-guideline.md,
  docs/permissions-matrix-appointments.md** — descriptive docs; only the wage subset of the permissions
  matrix has a test.
- **docs/budget-ssot-audit.md methodology itself** — a manual, one-off procedure (done for budget + rates);
  there is no repeatable script/checklist run for other domains, and nothing detects when a NEW business
  question appears without an assigned SSoT.

### 5.4 Systemic detection gaps (why duplicates still slip through)

- **No generic duplicate/similar-function detection**: no jscpd/copy-paste/structural-similarity tooling
  anywhere in the repo. `calculations-in-shared` only fires on `calculate*`/`compute*` names combined with
  ~6 keyword categories — a re-implementation named `getRemainingBudget`, `deriveHours`, `sumInvoiceTotal`
  etc. passes every gate.
- **Guards are reactive allowlist-per-bug**: nearly every fitness function encodes a *specific past
  incident* (task numbers). There is no proactive inventory gate ("every exported function in shared/domain
  must map to a registered business question").
- **knip never blocks** — duplicate/unused exports accumulate silently (`continue-on-error`).
- **Equality/drift coverage is enumerated by hand**: a new read-path (display) for an existing quantity gets
  no automatic equality scenario; nothing forces a new endpoint to register a drift test.
- **CI quarantine hole**: km-rebook/km-drift equality suites skipped whenever `CI=true`.
- **Fork/secret hole**: gates 4/5/8 (incl. ALL architecture guards except the two dev-db ones) silently skip
  when `TEST_USER_*` secrets are absent.
- **Coverage floors exist for only 4 files**; billing floor is calibrated low (20/38) and skips entirely in
  GitHub CI (`requiresObjectStorage`).
- **Mutation testing** limited to 11 hardcoded files, PR-event only, aggregate 60% break threshold.
- **OpenAPI drift gate** ensures spec sync only — it cannot flag two endpoints answering the same business
  question.
- **Stale guard doc**: `price-ssot-read-path.test.ts` header still says the real-tree scan is `it.skip`,
  though it has been armed since Task #1325 — misleading for auditors.
- **Duplicated enforcement mechanisms** (ironically): invalidateQueries ban exists twice (ESLint +
  root-level test), soft-delete twice (ESLint + snapshot test), default-pots twice (ESLint + arch test) —
  by design as cross-tree redundancy, but with no meta-check that the pairs stay in sync (only the dev-db
  TS/Bash pair has a parity test).
