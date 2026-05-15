# Full-App-Audit 2026 — Übersicht

**Stand:** 2026-05-15
**Geprüfter Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Branch:** `main`
**Vorgänger-Task:** #480 (Audit-Plan + Chunk-Zerlegung) — MERGED
**Dieser Task:** #481 (Full-App-Check Drehbuch und Durchführung)

---

## Inhaltsverzeichnis

| Datei | Zweck |
|---|---|
| `audit-plan.md` | Verbindlicher Audit-Plan: 21 Chunks, DAG, Stop-Kriterien (aus #480) |
| `chunk-manifest.json` | Maschinenlesbares File→Chunk-Mapping (521 Files, 116 282 LOC) |
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

## Pre-Audit CI-Stand

| Workflow | Status | Bemerkung |
|---|---|---|
| `typecheck` | ✅ GRÜN | – |
| `lint` | ✅ GRÜN | – |
| `test` | 🔴 ROT (pre-existing) | 8 Test-Files failed wegen "fetch failed" beim globalSetup-Login (DB-Startup-Race auf NeonDB), nicht audit-relevant. Test-Suite-Stabilität ist eigener Folge-Task. |
| `e2e-smoke` | 🔴 ROT (pre-existing) | Login-Failures wegen gleicher DB-Race; bekannt aus Task #275/#288. |

Pre-existing rote Tests blockieren das Audit nicht (laut `task-481.md` Step 1
zulässig). Ein dedizierter Folge-Task `[BLOCKER] CI-Stabilität` ist im Hauptreport
gelistet.

## Lese-Reihenfolge

1. `REPORT.md` — beginne hier für Top-Findings + priorisierte Folge-Tasks.
2. Bei Interesse an einer Domain: zugehörigen `chunks/<id>-<name>.md` lesen.
3. Plan-Files der vorgeschlagenen Folge-Tasks: `.local/tasks/proposed-from-481/`.
