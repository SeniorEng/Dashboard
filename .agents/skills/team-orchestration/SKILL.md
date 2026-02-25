---
name: team-orchestration
description: Master orchestration skill that coordinates all audit agents. Defines when which agent runs, conflict resolution hierarchy, and team-wide commands. Read this skill first to understand the full AI development team structure and how agents work together.
---

# AI Development Team — Master Orchestration

This skill defines how the virtual AI development team operates. It coordinates 8 specialized audit agents plus the Architect to ensure comprehensive code quality.

## The Team Roster

| # | Agent | Location | Specialty | Metaphor |
|---|-------|----------|-----------|----------|
| 🏛️ | **Architect** | Built-in tool | Strategy, planning, code review | Technical Lead |
| 📋 | **Business & Compliance** | `.agents/skills/business-logic-audit/` | Workflows, GoBD, domain rules, care terminology | Business Analyst |
| 🔍 | **Code Quality** | `.agents/skills/code-quality-supervisor/` | DRY, conventions, dead code, documentation | Senior Engineer |
| 🗄️ | **Database** | `.agents/skills/database-audit/` | Schema, queries, indexing, GDPR, data integrity | DBA |
| ⚠️ | **Error Handling** | `.agents/skills/error-handling-audit/` | Mutations, onError, toast messages, DB error mapping | Error UX Specialist |
| ⚡ | **Performance** | `.agents/skills/performance-audit/` | Speed, caching, bundle size, mobile optimization | Performance Engineer |
| 🛡️ | **Security** | `.agents/skills/security-audit/` | OWASP, auth, CSRF, secrets, DSGVO | Security Officer |
| 🎨 | **UI/UX & A11y** | `.agents/skills/ui-ux-audit/` | Touch targets, feedback, mobile, German wording, accessibility | UX Designer |
| 🧪 | **QA & Testing** | `.agents/skills/qa-testing/` | Happy path, edge cases, regression, error handling | QA Tester |
| 🚀 | **DevOps** | `.agents/skills/devops-release/` | Env vars, dependencies, build, logging, deployment | Release Manager |

---

## When to Run Which Agent

### After EVERY Task (Mandatory)
- **Code Quality Supervisor** — horizontal check across all changed files
- **Architect (evaluate_task)** — final review before marking complete

### Based on What Changed

| What Changed | Agents to Run |
|---|---|
| Database schema, storage queries | Database + Code Quality |
| API routes, endpoints | Security + Error Handling + Business Logic + Code Quality |
| Business workflows, status transitions | Business Logic + QA + Code Quality |
| Frontend components, pages | UI/UX + Performance + Code Quality |
| Forms, user input handling | Security + UI/UX + QA + Code Quality |
| Frontend mutations (useMutation) | Error Handling + Code Quality |
| Authentication, authorization | Security + Code Quality |
| Dependencies (package.json) | DevOps + Security |
| Build config, env vars | DevOps |
| Major feature (end-to-end) | ALL agents |
| Before deployment/publishing | ALL agents (full audit) |

### Quick Reference: Minimum Audit Set

| Change Size | Agents |
|---|---|
| Small fix (< 10 lines) | Code Quality + Architect |
| Medium feature (10-100 lines) | Code Quality + 1-2 relevant specialists + Architect |
| Large feature (100+ lines) | Code Quality + all relevant specialists + Architect |
| Pre-deployment | Full team audit (all 8 agents) |

---

## Conflict Resolution Hierarchy

When agents give contradicting recommendations, resolve using this priority order:

```
1. 🛡️ Security & Compliance     (Safety and legal requirements first)
   └─ "If it's insecure or illegal, it doesn't ship."

2. 📋 Business Logic & GoBD      (Must correctly model the real-world process)
   └─ "If it doesn't match the business workflow, it's wrong."

3. 🎨 UX & ⚡ Performance        (User experience comes before code elegance)
   └─ "If the user can't use it or it's too slow, it doesn't matter how clean the code is."

4. 🔍 Code Quality               (Maintainability for the long term)
   └─ "If it works but is unmaintainable, it's technical debt."
```

### Example Conflicts:
- **Security says** "add rate limiting" vs **UX says** "don't slow down the user"
  → Security wins: Add rate limiting, but with generous limits and clear feedback
- **Performance says** "cache this query" vs **Business says** "data must be real-time"
  → Business wins: Don't cache, optimize the query instead
- **Code Quality says** "extract this into a util" vs **UX says** "ship it now, the user is waiting"
  → UX wins short-term: Ship, but create a follow-up task for refactoring

---

## Team Commands

These are conceptual commands that trigger specific agent combinations:

### `/audit` — Full Team Audit
Runs ALL 8 agents against the current codebase state (git diff).
**When**: Before deployment, after major milestones, monthly reviews.
**Execution**: All 8 agents run as parallel subagents, each producing their audit report.

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
**Execution**: Code Quality + Security + QA (happy path only).

### `/review` — Code Review
Architect reviews recent changes for correctness and completeness.
**When**: After completing a task, before marking it done.
**Execution**: Architect (evaluate_task mode) with git diff.

---

## Audit Report Aggregation

When running a full team audit, the results are aggregated into a summary:

```
## Full Team Audit Summary

| Agent | PASS | WARN | FAIL | Critical Finding |
|-------|------|------|------|------------------|
| Business Logic | 8/10 | 2 | 0 | — |
| Code Quality | 5/6 | 1 | 0 | — |
| Database | 9/10 | 1 | 0 | — |
| Performance | 4/5 | 1 | 0 | — |
| Security | 6/7 | 1 | 0 | — |
| UI/UX | 5/6 | 1 | 0 | — |
| QA Testing | 5/6 | 1 | 0 | — |
| DevOps | 5/6 | 1 | 0 | — |

### Overall: ✅ PASS (0 FAIL, 8 WARN)

### FAIL Items (Must Fix Now)
[None / List]

### WARN Items (Should Fix)
[Consolidated list across all agents]

### Follow-Up Tasks
[Generated from WARN items that are deferred]
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
│   Run relevant agents based on change type       │
│   Business + DB + Security + UX + QA + Perf      │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│           FIX FINDINGS                           │
│   FAIL → immediate fix                           │
│   WARN → fix or document as follow-up            │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│            DELIVERY TO USER                      │
│   "Feature X ist fertig. Hier sind die Details." │
└─────────────────────────────────────────────────┘
```
