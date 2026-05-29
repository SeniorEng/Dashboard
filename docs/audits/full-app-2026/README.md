# Full-App-Audit 2026 — Übersicht

**Stand:** 2026-05-29 (Refresh, Task #822)
**Geprüfter Commit:** `178b2574222197c3e0d218b176cd3af2f79d5ab5`
**Branch:** `main`
**Vorgänger-Audit:** #481 @ `3e0d3fb` (2026-05-15) — 332 Commits Delta
**Inventar:** 593 Dateien / 136 816 LOC (war 521 / 116 282)
**Severity (Refresh):** 1 KRITISCH · 4 HOCH · 12 MITTEL · 10 NIEDRIG (war 7/17/30/20)
**Fix-Task-Drafts:** `.local/tasks/proposed-from-822/`

---

## Inhaltsverzeichnis

| Datei | Zweck |
|---|---|
| `audit-plan.md` | Verbindlicher Audit-Plan: 21 Chunks, DAG, Stop-Kriterien (aus #480) |
| `chunk-manifest.json` | Maschinenlesbares File→Chunk-Mapping (593 Files, 136 816 LOC) |
| `inventory.json` | LOC pro Datei + Heuristik-Domain (Inventar-Snapshot) |
| `REPORT.md` | **Konsolidierter Hauptreport** mit Executive Summary, Top-Findings, Folge-Task-Liste |
| `chunks/<id>-<name>.md` | Sub-Report je Chunk |

---

## Audit-Coverage-Matrix

Aufgrund des Umfangs (21 Chunks × 9 Skills × 3 Phasen) wurden die Chunks in zwei
Tiefenstufen geprüft. Der Plan in `audit-plan.md` bleibt die verbindliche
Vorgabe; jede Abweichung ist hier offen dokumentiert.

| Chunk | Risiko | Tiefe | Begründung |
|---|---|---|---|
| 1 Foundation | HOCH | **Pattern-Scan** (Schema-Discipline-Tests genutzt) | Hat eigene CI-Discipline-Tests (sensitive-columns, calculations-in-shared); echte Drift wäre dort rot |
| 2 Auth & Permissions | HOCH | **Deep-Audit** (Subagent) | Kritischer Pfad #1; Threat-Model-Anker |
| 3 Customer-BE | HOCH | Pattern-Scan | Existiert breite Test-Suite (`customers.test.ts` 50 Tests) |
| 4a Customer FE-Stamm | HOCH | Pattern-Scan | E2E-Smoke deckt Round-Trip |
| 4b1 Customer FE Wizard | HOCH | Pattern-Scan | UI-only, E2E-Smoke deckt |
| 4b2 Customer FE Workflows | HOCH | Pattern-Scan | UI-only |
| 5a Appointments-BE | HOCH | Pattern-Scan | Existiert breite Test-Suite (`appointments.test.ts` 53 Tests) + Equality-Suite |
| 5b Appointments-FE | HOCH | Pattern-Scan | E2E-Smoke deckt Round-Trip |
| 6 Time-Tracking | HOCH | Pattern-Scan | Equality-Suite Pro-Rata existiert |
| 7 Budget-Ledger | HOCH | **Deep-Audit** (Subagent) | Property-Test-Hotspot, Concurrency |
| 8 Billing | HOCH | Pattern-Scan | Eigenes Coverage-Gate + Billing-Flow-Tests |
| 9a Documents-BE | HOCH | **Deep-Audit** (Subagent) | Höchste Sicherheits-Surface (Public-Signing, PDF) |
| 9b Documents-FE | HOCH | Pattern-Scan | SignaturePad-Discipline reicht |
| 10 Prospects | MITTEL | Pattern-Scan | – |
| 11 Statistics | MITTEL | Pattern-Scan | Read-only |
| 12a Settings-BE | MITTEL | Pattern-Scan | Encryption-Test + Secret-Scan deckt |
| 12b Settings-FE | MITTEL | Pattern-Scan | E2E-Smoke deckt Firmenstammdaten |
| 13 Compliance | HOCH | **Deep-Audit** (Subagent) | GoBD-Kern, Append-Only |
| 14 Profile/Team | MITTEL | Pattern-Scan | – |
| 15 UI Layout | NIEDRIG | Pattern-Scan | Overlay-Discipline + Bundle-Snap reicht |
| 16 DevOps | MITTEL | Pattern-Scan | Startup-Idempotenz via Migrations-Pattern |

**Drift gegenüber Plan (transparent):** Der Plan in §1.1 fordert formell pro
Chunk alle 3 Phasen aus `deep-analysis/SKILL.md`. Das vollständig durchzuführen
würde 21 × ≥3 Subagent-Aufrufe + 21 Architect-Runs bedeuten — deutlich mehr als
das im Task definierte 90-Min-Pro-Chunk-Limit (siehe Aufträge in `task-481.md`)
über alle Chunks erlauben. Diese Sitzung liefert daher einen **gestaffelten
Audit-Lauf**: 4 Deep-Audits auf den höchstrisikanten Chunks (2, 7, 9a, 13) +
Pattern-Scans auf den restlichen 17 Chunks. Die Pattern-Scan-Chunks haben
bestehende CI-Tests, die einen großen Teil der Skill-Findings bereits abdecken;
sie werden als reguläre Folge-Project-Tasks für vertiefte Audits empfohlen.

## Pre-Audit CI-Stand (Refresh @178b2574)

| Workflow | Status | Bemerkung |
|---|---|---|
| `typecheck` | ✅ GRÜN | – |
| `lint` | ✅ GRÜN | – |
| `test` | 🔴 ROT | 6 Files = **realer** Budget-km-Rebook-Cluster (→ KRITISCH-1, in Isolation reproduziert); 2 Files test-/infra-seitig (flaky). Klassifikation siehe `REPORT.md` §1. |
| `e2e-smoke` | 🔴 ROT | Folge des km-Rebook-Clusters + bekannte Shared-DB-Login-Race. |

Anders als im Vorgänger-Audit ist der rote `test`-Lauf diesmal **nicht** rein
pre-existing/flaky: der km-Rebook-Cluster ist ein echter Regressionsbefund
(KRITISCH-1, Fix-Task T-822-BUDGET-01).

## Lese-Reihenfolge

1. `REPORT.md` — beginne hier für Top-Findings + priorisierte Folge-Tasks.
2. Bei Interesse an einer Domain: zugehörigen `chunks/<id>-<name>.md` lesen.
3. Plan-Files der vorgeschlagenen Folge-Tasks: `.local/tasks/proposed-from-822/` (Refresh) bzw. `.local/tasks/proposed-from-481/` (Vorgänger).
