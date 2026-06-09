# Documentation Index

This is the single entry point for all CareConnect documentation. Every Markdown
doc under `docs/` (top-level and subfolders) plus the two root docs is linked
below, grouped into categories. Each entry has a one-line summary.

> **Durable references vs. dated snapshots:** The first sections
> (Architecture, Runbooks, Testing, User docs, Research, Root reference) are
> living reference material kept up to date. The
> [Historical reports & analyses](#historical-reports--analyses-dated-snapshots)
> and [Audits](#audits), [Tasks & Backups](#tasks--backups) sections are
> **point-in-time snapshots** — accurate as of the date in the filename or
> content, not maintained going forward.

## Architecture & Domain

- [architecture/budget.md](architecture/budget.md) — Budget-Domäne: Three-Pot-Ledger, Pot-Regeln, Historisierung, Selbstzahler, §45b-Spezifika, SSoT-Konsolidierung.
- [architecture/budget-greenfield-architecture.md](architecture/budget-greenfield-architecture.md) — North-Star-Zielarchitektur für den Budget-Ledger (Reservation/Financial-Split, Phasenplan).
- [architecture/budget-verfahrensdokumentation.md](architecture/budget-verfahrensdokumentation.md) — GoBD-Verfahrensdokumentation des Budget-Ledgers (Nachvollziehbarkeit, Unveränderbarkeit).
- [architecture/adr/README.md](architecture/adr/README.md) — Index der Architecture Decision Records (ADR-0001…0004, Budget-Greenfield Phase 0).
- [budget-ssot-inventory.md](budget-ssot-inventory.md) — Inventur aller Budget-Berechnungs-/Anzeigestellen, Konflikt-Matrix, Drei-View-Vorschlag, Phasen-Reihenfolge.
- [concept-budget-initialization.md](concept-budget-initialization.md) — Konzept für Budget-Startwert & Carryover bei der Kundenanlage.
- [permissions-matrix-appointments.md](permissions-matrix-appointments.md) — Berechtigungs-Matrix für Termin-Operationen (Rollen × Aktionen).
- [invoice-line-items.md](invoice-line-items.md) — Rechnungs-Line-Item-Mengen: km-Quantisierung, persistierte Spalten, GoBD-Fallback, Drift-Detektor.
- [erechnung-validation.md](erechnung-validation.md) — E-Rechnungs-Validierung (ZUGFeRD/Factur-X EN 16931) via Mustang/KoSIT + veraPDF, CI-Gate.
- [migration-km-geo-numeric.md](migration-km-geo-numeric.md) — Migration der KM-/Geo-Spalten von `real` auf `numeric`, idempotenter Startup-Hook, Backfill-Plan.
- [page-size-guideline.md](page-size-guideline.md) — Page-Size-Guideline (≤500 LOC soft, 800 LOC hard; Pages sind dünne Wrapper).

## Runbooks & Operations

- [ci-pipeline.md](ci-pipeline.md) — CI-Pipeline-Runbook (GitHub Actions): alle Pflicht-Gates, Neon-Proxy, Test-User-Seed, Branch-Protection.
- [dependency-management.md](dependency-management.md) — Dependency-Management mit Renovate: Gruppierung, Auto-Merge-Regeln, Pausieren, PAT-Anforderungen.
- [deployment-log.md](deployment-log.md) — Deployment-Logbuch (chronologische Einträge zu Releases/Deployments).
- [month-close-automation-runbook.md](month-close-automation-runbook.md) — Runbook für den automatischen Monatsabschluss (Cutoff, Scheduler, Reminder-Wellen).
- [pre-publish-backup-runbook.md](pre-publish-backup-runbook.md) — Pre-Publish-Backup-Runbook für die Produktions-DB (Schritte vor jedem Release).
- [pdf-chromium.md](pdf-chromium.md) — PDF-Rendering & Chromium (Puppeteer): Launch-Härtung, `--single-process`-Schalter, Pfadauflösung, Diagnose.
- [whatsapp-twilio.md](whatsapp-twilio.md) — WhatsApp-Versand über Twilio Content API (Content SIDs, veraltete Spalten, Token-Override).

## Testing & Quality

- [test-infrastructure.md](test-infrastructure.md) — Test-Infrastruktur: Vitest-Configs, Ephemeral-DB-Orchestrator, Template-Cache, Env-Schalter.
- [flaky-tests.md](flaky-tests.md) — Register bekannter flaky Tests + Policy zum Umgang damit.
- [mutation-testing.md](mutation-testing.md) — Mutation-Testing-Runbook (Stryker): Scope/Out-of-scope, CI-Gate, neue Module aufnehmen.
- [../tests/README.md](../tests/README.md) — API-Integrationstest-Übersicht: Domänen-Abdeckungsmatrix, Coverage-Gates, Test-Daten-Konventionen, E2E-Smoke.
- [../tests/architecture/README.md](../tests/architecture/README.md) — Architektur-Fitness-Functions: zentrale Berechnungen, Soft-Delete-/Error-Handling-Schranken, ast-grep-Pilot.

## User / Team docs

- [mitarbeiter-handbuch.md](mitarbeiter-handbuch.md) — Mitarbeiter-Handbuch (Bedienungsanleitung für Endnutzer/Pflegekräfte).

## Research

- [research/sgb-datenaustausch-302-105.md](research/sgb-datenaustausch-302-105.md) — Sondierung elektronischer Sozialdaten-Austausch §105 SGB XI / §302 SGB V (Entscheidungsvorlage, keine Implementierung).

## Root reference

- [../replit.md](../replit.md) — Projekt-README: Überblick, Run/Operate, Stack, Architektur-Entscheidungen, Env-Vars, User-Preferences, Gotchas, Pointers.
- [../threat_model.md](../threat_model.md) — Threat Model: Assets, Trust Boundaries, Scan-Anchors, STRIDE-Bedrohungskategorien.
- [api/openapi.json](api/openapi.json) — Generierte OpenAPI-Spezifikation (aus den Zod-Schemas in `shared/api/openapi.ts`).

## Audits

Strukturierte Audit-Läufe. Diese sind **Momentaufnahmen** zum jeweils geprüften
Commit/Stand und werden nicht laufend gepflegt.

- [audits/full-app-2026/README.md](audits/full-app-2026/README.md) — Full-App-Audit 2026 (21 Chunks): Übersicht, Coverage-Matrix, Lese-Reihenfolge; verlinkt `REPORT.md`, `audit-plan.md` und die Chunk-Sub-Reports unter `chunks/`.
- [audits/PERFORMANCE_GUIDE.md](audits/PERFORMANCE_GUIDE.md) — Performance-Analyse & Optimierungsguide (Hotspots, Empfehlungen).
- [audits/REFACTORING_PLAN.md](audits/REFACTORING_PLAN.md) — Refactoring-Plan (priorisierte Tech-Debt-Maßnahmen).
- [audits/TIEFENANALYSE_REFACTORING_2026-04-18.md](audits/TIEFENANALYSE_REFACTORING_2026-04-18.md) — Vollständige Tiefenanalyse & Refactoring-Plan (Snapshot 2026-04-18).
- [audits/tech-refactoring-2026-05-07.md](audits/tech-refactoring-2026-05-07.md) — Technisches Refactoring-Audit (Snapshot 2026-05-07).
- [audits/skill-team-audit-2026.md](audits/skill-team-audit-2026.md) — AI-Audit-Team Skill-Inventur & Gap-Analyse 2026.
- [audits/task-393-cache-invalidation-findings.md](audits/task-393-cache-invalidation-findings.md) — Cache-Invalidierungs-Findings (Paket D1, Snapshot).

## Historical reports & analyses (dated snapshots)

Punktuelle Analysen/Berichte, gültig zum jeweiligen Erstellungsdatum. Sie
dokumentieren einen vergangenen Zustand und werden **nicht** aktualisiert.

- [dead-code-report.md](dead-code-report.md) — Dead-Code-Bericht (Knip-Befund, Momentaufnahme).
- [dependency-audit-report.md](dependency-audit-report.md) — Dependency-Audit-Bericht (Schwachstellen/Veraltung, Momentaufnahme).
- [schema-audit-report.md](schema-audit-report.md) — Schema-Audit-Report (Drizzle-Schema-Befunde, Momentaufnahme).
- [quality-sweep-2026-05-27.md](quality-sweep-2026-05-27.md) — Full Quality Sweep (Snapshot 2026-05-27).
- [stabilitaets-check-2026-04.md](stabilitaets-check-2026-04.md) — Stabilitäts-Check nach großen Änderungen (Snapshot April 2026).
- [import-budget-drift-report-20260527.md](import-budget-drift-report-20260527.md) — Budget-Ledger-Drift nach Excel-Import — Diagnose-Report (Snapshot 2026-05-27).
- [erstberatung-orphan-source.md](erstberatung-orphan-source.md) — März-2026-Karteileichen — Quellenanalyse verwaister Erstberatungs-Datensätze.
- [erstberatung-prod-analysis.md](erstberatung-prod-analysis.md) — Erstberatungs-Kunden in Produktion — Read-only-Analyse (Momentaufnahme).
- [phantom-pot-split-analysis.md](phantom-pot-split-analysis.md) — Phantom-Topf-Splits in der Rechnungserzeugung — Analyse & Bestandsvermessung.
- [refactor-masterplan.md](refactor-masterplan.md) — Refactor-Masterplan (übergreifender Plan, Momentaufnahme).

## Tasks & Backups

- [tasks/462-verification.md](tasks/462-verification.md) — Verifikation des Termin-Detail-Mobile-Layouts (Task #468 prüft #462), Snapshot.
- [backups/snapshot-2026-04-28T21-22-53-207Z.md](backups/snapshot-2026-04-28T21-22-53-207Z.md) — Vollständiger logischer Production-DB-Backup-Snapshot (2026-04-28).
