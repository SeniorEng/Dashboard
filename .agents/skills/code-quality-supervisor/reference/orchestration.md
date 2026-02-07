# Audit Skill Orchestration Guide

This document defines WHEN and HOW each audit skill runs, forming a complete quality gate system.

## The 5 Audit Skills

| # | Skill | Focus | Runs After |
|---|-------|-------|-----------|
| 1 | `code-quality-supervisor` | Horizontal: duplicates, conventions, completeness, dead code | **EVERY task** |
| 2 | `database-audit` | Vertical: schema, storage, queries, GDPR | Data layer changes |
| 3 | `business-logic-audit` | Vertical: workflows, domain rules, user journeys | Business logic changes |
| 4 | `security-audit` | Vertical: auth, CSRF, injection, secrets | Auth/API/input changes |
| 5 | `performance-audit` | Vertical: queries, rendering, bundle, mobile | New features, pre-deploy |

## Decision Matrix: Which Skills to Run

### After EVERY Task (Mandatory)
- **`code-quality-supervisor`** — Always runs. This is the gatekeeper.

### Based on What Changed

| What Changed | Also Run |
|-------------|----------|
| Database schema (`shared/schema.ts`) | `database-audit` |
| Storage queries (`server/storage/`) | `database-audit` |
| API routes (`server/routes/`) | `security-audit` |
| Authentication/session logic (`server/middleware/auth.ts`, `server/services/auth.ts`) | `security-audit` |
| Business workflows or status transitions | `business-logic-audit` |
| Domain rules (`shared/domain/`) | `business-logic-audit` |
| User input handling (forms, validation) | `security-audit` |
| New pages or large components | `performance-audit` |
| Complex database queries | `performance-audit` + `database-audit` |
| npm dependency changes | `security-audit` + `performance-audit` |
| Pre-deployment/publishing | ALL five skills |

### Quick Reference: File Path → Skills

```
shared/schema.ts          → code-quality-supervisor + database-audit
shared/domain/*.ts        → code-quality-supervisor + business-logic-audit
shared/utils/*.ts         → code-quality-supervisor
server/routes/*.ts        → code-quality-supervisor + security-audit
server/storage/*.ts       → code-quality-supervisor + database-audit
server/services/auth.ts   → code-quality-supervisor + security-audit
server/middleware/*.ts     → code-quality-supervisor + security-audit
client/src/pages/*.tsx    → code-quality-supervisor + (performance-audit if large)
client/src/features/*.ts  → code-quality-supervisor + business-logic-audit
package.json              → security-audit + performance-audit
```

## Execution Order

When multiple skills run, execute in this order:

1. **`code-quality-supervisor`** (fastest, catches structural issues early)
2. **`database-audit`** (if applicable)
3. **`security-audit`** (if applicable)
4. **`business-logic-audit`** (if applicable)
5. **`performance-audit`** (if applicable, slowest)

## Escalation Rules

### FAIL = Block
Any FAIL finding from any skill blocks task completion. Must be fixed before telling the user "fertig".

### WARN = Report
WARN findings are reported to the user with recommendations. They don't block completion but should be tracked.

### Efficiency
- Don't run ALL skills for trivial changes (typo fix, comment update)
- Focus each skill on the files that changed + their direct dependents
- The `code-quality-supervisor` can be scoped to just the changed files for small changes

## Pre-Deployment Checklist

Before publishing/deploying, run ALL five skills with FULL scope:

```
1. [ ] code-quality-supervisor — full codebase scan
2. [ ] database-audit — including schema drift check
3. [ ] security-audit — including npm audit
4. [ ] business-logic-audit — all critical workflows
5. [ ] performance-audit — including bundle size analysis
```

## Continuous Improvement

After each audit run:
1. If a new pattern/anti-pattern is discovered, add it to the relevant skill
2. If a false positive keeps appearing, refine the check to exclude it
3. If a skill consistently misses issues, add new check steps
4. Update `replit.md` if new conventions are established
