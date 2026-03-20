---
name: team-orchestration
description: Master orchestration skill that coordinates all audit agents. Defines when which agent runs, conflict resolution hierarchy, and team-wide commands. Read this skill first to understand the full AI development team structure and how agents work together.
---

# AI Development Team — Master Orchestration

This skill defines how the virtual AI development team operates. It coordinates 9 specialized audit agents plus the Architect to ensure comprehensive code quality.

## The Team Roster

| # | Agent | Location | Specialty | Metaphor |
|---|-------|----------|-----------|----------|
| 🏛️ | **Architect** | Built-in tool | Strategy, planning, code review | Technical Lead |
| 📋 | **Business & Compliance** | `.agents/skills/business-logic-audit/` | Workflows, GoBD, domain rules, care terminology, idempotency | Business Analyst |
| 🔍 | **Code Quality** | `.agents/skills/code-quality-supervisor/` | DRY, conventions, dead code, documentation, tech debt registry | Senior Engineer |
| 🗄️ | **Database** | `.agents/skills/database-audit/` | Schema, queries, indexing, GDPR, data integrity, query optimization, transaction safety | DBA |
| ⚠️ | **Error Handling** | `.agents/skills/error-handling-audit/` | Mutations, onError, toast messages, DB error mapping, graceful degradation | Error UX Specialist |
| ⚡ | **Performance** | `.agents/skills/performance-audit/` | Speed, caching, bundle size, mobile optimization, CWV, memory leaks | Performance Engineer |
| 🔄 | **Regression Guard** | `.agents/skills/regression-guard/` | Dependency impact, API contract regression, critical paths, migration safety, permission regression | Regression Tester |
| 🛡️ | **Security** | `.agents/skills/security-audit/` | OWASP, OWASP API Top 10, auth, CSRF, secrets, DSGVO, supply chain | Security Officer |
| 🎨 | **UI/UX & A11y** | `.agents/skills/ui-ux-audit/` | Touch targets, feedback, skeleton loading, mobile, German wording, accessibility, PWA | UX Designer |
| 🧪 | **QA & Testing** | `.agents/skills/qa-testing/` | Happy path, edge cases, regression, contract testing, smoke tests, proactive test recommendations | QA Tester |
| 🚀 | **DevOps** | `.agents/skills/devops-release/` | Env vars, dependencies, build, logging, health checks, graceful shutdown, deployment | Release Manager |

---

## Risk-Based Testing Priorities

Not all code changes carry equal risk. Allocate testing effort proportionally:

| Risk Level | Modules | Testing Approach | Agents Required |
|---|---|---|---|
| **HOCH** (Critical) | Budget/Abrechnung, Auth/Sessions, Leistungsnachweise, Preisvereinbarungen, Unterschriften | Full audit: all paths, boundary values, idempotency, regression | Business Logic + Security + QA + Regression Guard + Database |
| **MITTEL** (Important) | Workflows (Dokumentation, Erstberatung), Terminplanung, Zeiterfassung, Kundenverwaltung | Standard audit: happy + sad path, key edge cases, error handling | Business Logic + QA + relevant specialists |
| **NIEDRIG** (Standard) | UI-Styling, Statistik-Anzeige, Settings, Onboarding | Quick check: happy path, visual verification | Code Quality + UI/UX |

**Rule**: Never skip HOCH-risk module testing. For MITTEL modules, skip only boundary testing if time-constrained. For NIEDRIG, skip only if completely isolated from other modules.

---

## When to Run Which Agent

### After EVERY Task (Mandatory)
- **Code Quality Supervisor** — horizontal check across all changed files
- **Architect (evaluate_task)** — final review before marking complete

### Based on What Changed

| What Changed | Agents to Run |
|---|---|
| Database schema, storage queries | Database + Code Quality + Regression Guard |
| API routes, endpoints | Security + Error Handling + Business Logic + Code Quality + Regression Guard |
| Business workflows, status transitions | Business Logic + QA + Code Quality + Regression Guard |
| Frontend components, pages | UI/UX + Performance + Code Quality |
| Forms, user input handling | Security + UI/UX + QA + Code Quality |
| Frontend mutations (useMutation) | Error Handling + Code Quality |
| Authentication, authorization | Security + Regression Guard (permission regression) + Code Quality |
| Dependencies (package.json) | DevOps + Security (supply chain) |
| Build config, env vars | DevOps |
| Shared modules (shared/, server/lib/) | Regression Guard + Code Quality + all affected specialists |
| Schema migration (ALTER TABLE) | Database + Regression Guard (migration safety) + Code Quality |
| Major feature (end-to-end) | ALL agents |
| Before deployment/publishing | ALL agents (full audit) |
| Multi-file change (3+ files) | Regression Guard + Code Quality + relevant specialists |

### Quick Reference: Minimum Audit Set

| Change Size | Agents |
|---|---|
| Small fix (< 10 lines) | Code Quality + Architect |
| Medium feature (10-100 lines) | Code Quality + 1-2 relevant specialists + Architect |
| Large feature (100+ lines) | Code Quality + Regression Guard + all relevant specialists + Architect |
| Multi-file refactor (3+ files) | Code Quality + Regression Guard + Architect |
| Pre-deployment | Full team audit (all 9 agents) |

### Small Fix Shortcut

For changes < 5 lines touching a single file, run Code Quality **Categories 2 + 7 only** (convention compliance + documentation alignment). Skip duplicate detection, dead code scan, and Knip. This keeps overhead proportional to risk.

### Quick Agent Selection Flowchart

Use this to quickly decide which agents to run:

```
Start: What did you change?
│
├── Auth, sessions, permissions?     → Security + Regression Guard
├── Database schema or queries?      → Database + Regression Guard
├── API routes or endpoints?         → Security + Error Handling + Business Logic + Regression Guard
├── Business workflows or status?    → Business Logic + QA + Regression Guard
├── Frontend components or pages?    → UI/UX + Performance
├── Forms or user input?             → Security + UI/UX + QA
├── Frontend mutations?              → Error Handling
├── Dependencies (package.json)?     → DevOps + Security (supply chain)
├── Build config or env vars?        → DevOps
├── Shared modules?                  → Regression Guard + ALL affected specialists
│
└── Always add: Code Quality + Architect
```

---

## Time Budgets Per Agent

Not every audit needs to be exhaustive. Use time budgets to keep audits proportional to risk:

| Agent | Quick Check | Standard Audit | Full Audit |
|---|---|---|---|
| Code Quality | 3 min (Cat 2, 7 only) | 10 min (all categories) | 15 min (+ Knip) |
| Business Logic | 5 min (Cat 1, 3 only) | 15 min (Cat 1-6, 9) | 25 min (all 11 categories) |
| Database | 5 min (Cat 1, 3, 6) | 15 min (Cat 1-10) | 25 min (all 13 categories) |
| Error Handling | 3 min (Cat 1, 2) | 10 min (Cat 1-5) | 15 min (all 7 categories) |
| Performance | 5 min (Cat 1, 4) | 10 min (Cat 1-5) | 15 min (all 6 categories) |
| Regression Guard | 5 min (Cat 1, 3) | 10 min (Cat 1-3) | 15 min (all 5 categories) |
| Security | 5 min (Cat 1, 2, 4) | 15 min (Cat 1-6) | 20 min (all 8 categories) |
| UI/UX | 3 min (Cat 1, 6) | 10 min (Cat 1-5) | 15 min (all 8 categories) |
| QA | 5 min (Cat 1 only) | 15 min (Cat 1-5) | 20 min (all 9 categories) |
| DevOps | 3 min (Cat 3, 4) | 10 min (Cat 1-5) | 15 min (all 7 categories) |

### Audit Profiles

| Profile | When to Use | Time Budget | Agents |
|---|---|---|---|
| **Quick** | Small fix (< 10 lines, 1 file) | < 5 min | Code Quality (Cat 2, 7) + Architect |
| **Standard** | Medium feature (10-100 lines) | ~15 min | Code Quality + 1-2 specialists (standard depth) + Architect |
| **Thorough** | Large feature (100+ lines) | ~45 min | Code Quality + Regression Guard + all relevant specialists (standard depth) + Architect |
| **Pre-deploy** | Before publishing to production | ~60 min | All 9 agents (full depth) + DevOps Category 6 checklist |

---

## Conflict Resolution Hierarchy

When agents give contradicting recommendations, resolve using this priority order:

```
1. 🛡️ Security & Compliance     (Safety and legal requirements first)
   └─ "If it's insecure or illegal, it doesn't ship."

2. 📋 Business Logic & GoBD      (Must correctly model the real-world process)
   └─ "If it doesn't match the business workflow, it's wrong."

3. 🔄 Regression Guard           (Existing features must not break)
   └─ "If it breaks something that was working, it's a regression."

4. 🎨 UX & ⚡ Performance        (User experience comes before code elegance)
   └─ "If the user can't use it or it's too slow, it doesn't matter how clean the code is."

5. 🔍 Code Quality               (Maintainability for the long term)
   └─ "If it works but is unmaintainable, it's technical debt."
```

### Example Conflicts:
- **Security says** "add rate limiting" vs **UX says** "don't slow down the user"
  → Security wins: Add rate limiting, but with generous limits and clear feedback
- **Performance says** "cache this query" vs **Business says** "data must be real-time"
  → Business wins: Don't cache, optimize the query instead
- **Regression Guard says** "this change breaks appointment list" vs **Code Quality says** "the old code was wrong"
  → Regression Guard wins: Fix the regression first, then refactor properly
- **Code Quality says** "extract this into a util" vs **UX says** "ship it now, the user is waiting"
  → UX wins short-term: Ship, but create a tech debt registry entry for refactoring

---

## Team Commands

These are conceptual commands that trigger specific agent combinations:

### `/audit` — Full Team Audit
Runs ALL 9 agents against the current codebase state (git diff).
**When**: Before deployment, after major milestones, monthly reviews.
**Execution**: All 9 agents run as parallel subagents, each producing their audit report.

### `/smoke` — Post-Deploy Quick Check
Quick validation that critical functionality still works after deployment.
**When**: Immediately after every deployment/publishing.
**Agents**: QA (Category 8: Smoke Test) + DevOps (Category 3: Health Check) + Regression Guard (Category 3: Critical Paths)
**Execution**:
1. Health check endpoint returns 200 OK with DB connected
2. Login flow works
3. Dashboard loads with data
4. Appointment creation succeeds
5. Documentation flow works (Kundentermin AND Erstberatung)
6. Budget overview shows correct data
**Time budget**: < 5 minutes

### `/plan [Feature]` — Architecture Planning
The Architect creates a step-by-step implementation plan.
**When**: Before starting a complex feature.
**Execution**: Architect (plan mode) → produces task list with dependencies.

### `/fix [Issue]` — Targeted Fix
The most relevant agent analyzes the issue and proposes a fix.
**When**: Bug report, user complaint, or audit finding.
**Execution**: Identify responsible agent → analyze → propose fix.

### `/preflight` — Pre-Commit Quick Check
Fast validation before committing code.
**When**: Before every significant commit.
**Execution**: Code Quality + Security + QA (happy path only) + Regression Guard (dependency impact only).

### `/review` — Code Review
Architect reviews recent changes for correctness and completeness.
**When**: After completing a task, before marking it done.
**Execution**: Architect (evaluate_task mode) with git diff.

### `/regression [files]` — Regression Analysis
Targeted regression check for specific changed files.
**When**: After modifying shared modules, critical paths, or multi-file changes.
**Execution**: Regression Guard full analysis on specified files.

---

## Audit Report Aggregation

When running a full team audit, the results are aggregated into a summary:

```
## Full Team Audit Summary

| Agent | PASS | WARN | FAIL | Critical Finding |
|-------|------|------|------|------------------|
| Business Logic | 9/11 | 2 | 0 | — |
| Code Quality | 6/8 | 2 | 0 | — |
| Database | 9/10 | 1 | 0 | — |
| Error Handling | 6/7 | 1 | 0 | — |
| Performance | 5/6 | 1 | 0 | — |
| Regression Guard | 4/5 | 1 | 0 | — |
| Security | 7/8 | 1 | 0 | — |
| UI/UX | 6/8 | 2 | 0 | — |
| QA Testing | 7/9 | 2 | 0 | — |
| DevOps | 5/6 | 1 | 0 | — |

### Overall: PASS (0 FAIL, 14 WARN)

### Risk Assessment
- HOCH-risk modules checked: [list]
- MITTEL-risk modules checked: [list]
- NIEDRIG-risk modules skipped: [list]

### FAIL Items (Must Fix Now)
[None / List]

### WARN Items (Should Fix)
[Consolidated list across all agents]

### Follow-Up Tasks
[Generated from WARN items that are deferred → added to Tech Debt Registry]
```

---

## How to Add New Agents

To extend the team with a new specialist:

1. Create a directory: `.agents/skills/<agent-name>/`
2. Create `SKILL.md` with:
   - YAML frontmatter: `name` and `description`
   - "When to Run" section
   - Numbered categories with specific grep/SQL commands
   - PASS/WARN/FAIL criteria per category
   - Output format template
   - Cross-references to other agents
3. Add the agent to this orchestration file's roster table
4. Update the "When to Run Which Agent" table
5. Update `replit.md` to document the new skill

---

## Integration with Development Workflow

```
┌─────────────────────────────────────────────────┐
│                 USER REQUEST                     │
│             "Build Feature X"                    │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│           ARCHITECT (plan mode)                  │
│   Break down into tasks, identify dependencies   │
│   Assign risk level: HOCH / MITTEL / NIEDRIG     │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│           IMPLEMENTATION LOOP                    │
│   For each task:                                 │
│   1. Implement the change                        │
│   2. Code Quality check (mandatory)              │
│   3. Architect review (evaluate_task)             │
│   4. Fix issues found                            │
│   5. Mark task complete                          │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│         SPECIALIST AUDITS (parallel)             │
│   Run based on risk level + change type          │
│   HOCH: All 9 agents                             │
│   MITTEL: Business + QA + Regression + relevant  │
│   NIEDRIG: Code Quality + UI/UX                  │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│           FIX FINDINGS                           │
│   FAIL → immediate fix                           │
│   WARN → fix or add to Tech Debt Registry        │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│           POST-DEPLOY SMOKE (/smoke)             │
│   Health check + Critical paths + Login          │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│            DELIVERY TO USER                      │
│   "Feature X ist fertig. Hier sind die Details." │
└─────────────────────────────────────────────────┘
```
