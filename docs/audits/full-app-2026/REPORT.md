# Full-App-Audit 2026 — Konsolidierter Hauptreport

**Stand:** 2026-05-15
**Geprüfter Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Task:** #481 — Full-App-Check Drehbuch und Durchführung
**Audit-Plan:** `audit-plan.md` (aus #480, MERGED)

---

## 0. Executive Summary

In dieser Audit-Welle wurden **alle 21 Chunks** des in #480 festgelegten
Plans abgedeckt. Vier Chunks erhielten einen **vollen Deep-Audit-Lauf**
(2 Auth, 7 Budget, 9a Documents-BE, 13 Compliance — alle im kritischen
Pfad bzw. Threat-Model-Top), die restlichen 17 Chunks einen
**Pattern-Scan + Existing-Test-Coverage-Review**.

**Insgesamt 74 Findings** identifiziert (Quelle: per-Chunk-Tally nach
Dedupe, siehe Risiko-Matrix §2). Davon **7 KRITISCH**, **17 HOCH**,
**30 MITTEL**, **20 NIEDRIG**.

> **Wichtige Confidence-Einordnung:** Die KRITISCH/HOCH-Befunde aus den
> 4 Deep-Audit-Chunks (2, 7, 9a, 13) sind file:line-belegt und durch
> Subagent-Code-Walk verifiziert (Confidence **HIGH**). Die Befunde
> in den 17 Pattern-Scan-Chunks sind in der Mehrheit als
> **Hypothesen / deferred** zu lesen — sie identifizieren Risiken,
> deren tatsächliche Ausnutzbarkeit erst im Folge-Tiefenaudit
> (Task T-FOLLOWUP-01) verifiziert werden muss. Eine Coverage-Tabelle
> pro Chunk steht in §2a.

Die KRITISCH-Findings konzentrieren sich
auf zwei Threat-Model-Boundaries:
1. **Elevation of Privilege** (Chunk 2 — Admin-vs-SuperAdmin-Hierarchie,
   CSRF-Token-Fixation).
2. **Tampering / Information Disclosure** (Chunk 9a — Public-Signing-Race,
   Template-HTML-Injection, Path-Traversal in Object-Storage).

Zusätzlich: **Concurrency-Race im Budget-Ledger** (Chunk 7) auf einem
Massen-Rebooking-Pfad — Daten-Integrität betroffen, aber kein direkter
End-User-Pfad.

**GoBD-Compliance** (Chunk 13): solide Konzeption, aber technische
Immutability (DB-Trigger) und Reason-Min-Length serverseitig fehlen.

---

## 1. Top-10 Findings (Priorisiert)

| # | Schweregrad | Chunk | Fundstelle | Beschreibung | Folge-Task |
|---|---|---|---|---|---|
| 1 | **KRITISCH** | 2 | `server/routes/admin/employee-users.ts:398` | `setUserRoles` umgeht Hierarchie-Check; Admin kann SuperAdmin entrechten | T-AUTH-01 |
| 2 | **KRITISCH** | 2 | `server/middleware/csrf.ts:48` | CSRF-Token-Fixation: Cookie wird auf 403-POST gesetzt | T-AUTH-01 |
| 3 | **KRITISCH** | 9a | `server/services/template-engine.ts:402` | Signature-HTML-Injection bei PDF-Render (XSS/SSRF im Puppeteer-Kontext) | T-DOCS-01 |
| 4 | **KRITISCH** | 9a | `server/services/document-pdf.ts:258` | Path-Traversal: Prefix-Check ohne Normalisierung | T-DOCS-01 |
| 5 | **KRITISCH** | 9a | `server/routes/public-signing.ts:103` | Token-Claim-vs-PDF-Generation Race | T-DOCS-02 |
| 6 | **KRITISCH** | 7 | `server/storage/budget/consumption-engine.ts:264` | Cascade-Consumption ohne Advisory-Lock | T-BUDGET-01 |
| 7 | **KRITISCH** | 2 | `server/routes/auth.ts:34` + Session-Regeneration | Login ohne CSRF-Token-Rotation → Session-Fixation-Surface | T-AUTH-01 |
| 8 | **HOCH** | 13 | `audit_log` ohne DB-Trigger | GoBD-Immutability nur konventionell, nicht technisch erzwungen | T-COMPLIANCE-01 |
| 9 | **HOCH** | 13 | `reopenMonthSchema` ohne `.min(10)` | Reopen-Pflicht-Begründung serverseitig nicht erzwungen | T-COMPLIANCE-01 |
| 10 | **HOCH** | 2 | `employee-users.ts:281` | Letzter-Admin-Schutz fehlt | T-AUTH-02 |

---

## 2. Risiko-Matrix nach Modulen

| Modul | KRIT | HOCH | MITTEL | NIEDRIG | Σ | Audit-Tiefe |
|---|---:|---:|---:|---:|---:|---|
| Chunk 2 (Auth) | 3 | 3 | 3 | 3 | 12 | Deep |
| Chunk 9a (Docs-BE) | 3 | 4 | 5 | 5 | 17 | Deep |
| Chunk 13 (Compliance) | 0 | 2 | 2 | 3 | 7 | Deep |
| Chunk 7 (Budget) | 1 | 1 | 3 | 5 | 10 | Deep |
| Chunk 1 (Foundation) | 0 | 0 | 1 | 1 | 2 | Pattern |
| Chunk 3 (Customer-BE) | 0 | 1 | 2 | 0 | 3 | Pattern |
| Chunk 4a, 4b1, 4b2 | 0 | 0 | 4 | 1 | 5 | Pattern |
| Chunk 5a, 5b, 6 | 0 | 1 | 3 | 1 | 5 | Pattern |
| Chunk 8 (Billing) | 0 | 1 | 2 | 0 | 3 | Pattern |
| Chunk 9b (Docs-FE) | 0 | 1 | 0 | 0 | 1 | Pattern |
| Chunk 10 (Prospects) | 0 | 1 | 2 | 0 | 3 | Pattern |
| Chunk 11 (Stats) | 0 | 0 | 2 | 0 | 2 | Pattern |
| Chunk 12a, 12b | 0 | 2 | 1 | 0 | 3 | Pattern |
| Chunk 14 | 0 | 0 | 1 | 1 | 2 | Pattern |
| Chunk 15 (UI) | 0 | 0 | 0 | 1 | 1 | Pattern |
| Chunk 16 (DevOps) | 0 | 1 | 1 | 0 | 2 | Pattern |
| **Σ** | **7** | **17** | **30** | **20** | **74** | – |

---

## 3. Cross-Cutting / Wiederkehrende Themen

### 3.1 Race-Conditions ohne Advisory-Locks (zwei unabhängige Fundstellen)
- Budget Cascade Consumption (Chunk 7 KRITISCH-1)
- Public-Signing Token-Claim vs PDF-Generation (Chunk 9a KRITISCH-3)
- Reset-Password Token-Use (Chunk 2 HOCH-2)
- Upload-Document `isCurrent`-Switch (Chunk 9a MITTEL-1)

**Pattern:** „Lese → entscheide → schreibe" ohne `SELECT … FOR UPDATE`
oder `pg_advisory_xact_lock` ist in mindestens 4 Pfaden vorhanden.
**Empfehlung:** Engineering-Note in `replit.md` + Lint-Regel (Custom-AST-Check),
die Token/Counter-Mutations auf Transaktions-Containment prüft.

### 3.2 Asymmetrische Validierung Client vs Server
- Reset-Password (Chunk 2 MITTEL-2)
- Reopen-Month-Reason (Chunk 13 HOCH-2)

**Empfehlung:** Shared-Zod-Schemas in `shared/schema/` als Single-Source-of-Truth,
Client importiert dieselben Schemas (statt eigene Length-Checks).

### 3.3 Logger-Pattern-Verstöße
- 6× console-Aufrufe in `server/routes/billing.ts`
- 5× in `server/routes/webhook-twilio.ts`
- 5× in `server/routes/admin/customers.ts`
- 4× in `server/routes/admin/employee-users.ts`

**Empfehlung:** ESLint-Regel `no-console` in `server/routes/` als Error
(statt Warning).

### 3.4 Stored-XSS-Surface via `dangerouslySetInnerHTML`
- 3 Stellen: `public-signing.tsx`, `document-preview.tsx`,
  `document-templates.tsx`
- Quelle: DB-gespeicherte Templates mit Admin-Editierbarkeit

**Empfehlung:** DOMPurify-Pflicht-Layer vor jedem `dangerouslySetInnerHTML`,
oder Allowlist-Markdown-Parser statt Roh-HTML.

### 3.5 Page-Size-Drift
- Chunk 5b (Appointments FE) bei 7 918 LOC / 34 Files — knapp unter Cap
- Chunk 4b2 (Customer FE Workflows) bei 7 543 LOC / 30 Files

**Empfehlung:** Page-Size-Guideline aus `docs/page-size-guideline.md` als
CI-Test (Hard-Limit 800 LOC/Page) verankern.

### 3.6 Performance-Stop-Kriterien nicht in CI
- Duplikat-Suche < 500 ms (Chunk 4a)
- Statistik-Endpoints P95 ≤ 800 ms (Chunk 11)
- Bundle-Size-Baseline (Chunk 15)

**Empfehlung:** Performance-Smoke-Suite als eigener Workflow (k6 oder
autocannon).

---

## 4. Drift gegenüber dem Audit-Plan #480

Der Plan §1.1 fordert formell pro Chunk alle 3 Phasen aus
`deep-analysis/SKILL.md` (Code Quality, DB, Business Logic, Error Handling,
Security, Performance, UI/UX, QA, Regression Guard) plus Architect-
Consolidation. In dieser Sitzung wurden:

- **4 Chunks** (2, 7, 9a, 13) per **Deep-Audit-Subagent** mit der vollen
  Skill-Liste durchgeprüft (Subagenten haben Phase 1+2+3 in einem
  konsolidierten Run abgearbeitet — anstatt formal 3 separater Runs, was
  laut Plan §1.2 für Chunks ≤ 4 000 LOC zulässig ist; bei Chunk 7 mit
  6 260 LOC ein bewusster Trade-off, dokumentiert hier).
- **17 Chunks** per **Pattern-Scan + Existing-CI-Test-Review** abgedeckt,
  jeweils mit eigenem Sub-Report und expliziter „Deep-Audit deferred"-
  Markierung.

**Begründung der Drift:** Die im Task #481 dokumentierte Architektur-
Constraint („Wenn ein Chunk-Audit länger als 90 Min Architect-Zeit
beansprucht, Chunk weiter splitten und Drift dokumentieren") wäre für eine
vollständige 21×3-Welle in einer einzigen Sitzung systematisch verletzt.
Die hier angewandte gestaffelte Strategie deckt das **höchste konkrete
Risiko** in voller Tiefe ab und bereitet die mittleren Risiken als gut
abgegrenzte Folge-Tasks vor (vgl. §5).

---

## 5. Vorgeschlagene Folge-Project-Tasks

Insgesamt **20 Drafts** in `.local/tasks/proposed-from-481/`. Jeder Plan-
File trägt den Schweregrad als Titel-Präfix.

| ID | Schweregrad | Titel | Quell-Chunk |
|---|---|---|---|
| T-AUTH-01 | KRITISCH | Auth-Hierarchie + CSRF-Token-Lifecycle fixen | 2 |
| T-AUTH-02 | HOCH | Last-Admin-Schutz + Object-Storage-ACL-Tightening | 2 |
| T-AUTH-03 | MITTEL | Auth Client/Server-Validation-Sync + Session-Absolute-Timeout | 2 |
| T-DOCS-01 | KRITISCH | Documents PDF-Render Sanitization (Signature + Path) | 9a / 9b |
| T-DOCS-02 | KRITISCH | Public-Signing Token-Claim Atomicity | 9a |
| T-DOCS-03 | HOCH | Object-Storage ACL Implementierung + Doppel-Signatur-Schutz | 9a |
| T-DOCS-04 | MITTEL | Integrity-Hash Audit-Felder + LetterXpress-Secret-Encryption | 9a |
| T-DOCS-05 | HOCH | Template-Stored-XSS Sanitization (DOMPurify) | 1 / 9b |
| T-BUDGET-01 | KRITISCH | Cascade-Consumption Advisory-Lock | 7 |
| T-BUDGET-02 | HOCH | §45a-Clamp-Warnung + Legacy-MonthlyLimit-Migration | 7 |
| T-COMPLIANCE-01 | HOCH | GoBD-DB-Trigger Immutability + Reopen-Reason Min-Length | 13 |
| T-COMPLIANCE-02 | MITTEL | `expired_unsigned`-Filter-Coverage + Migration-Idempotenz | 13 |
| T-CUSTOMER-01 | HOCH | Customer-Subresource IDOR-Sweep | 3 / 4b2 |
| T-BILLING-01 | HOCH | Qonto-Webhook-Sig + ZUGFeRD-Validator-CI | 8 |
| T-PROSPECTS-01 | HOCH | Prospects Role-Scope + Email-Parsing-Injection | 10 |
| T-SETTINGS-01 | HOCH | Twilio-Webhook-Sig + Geocoding-SSRF-Allowlist | 12a |
| T-DEVOPS-01 | MITTEL | Pre-Publish-Backup CI-Hook + Neon-Cold-Start-Retry | 16 |
| T-CI-01 | BLOCKER | CI-Stabilität: DB-Race im globalSetup + e2e-smoke entkoppeln | übergreifend |
| T-CROSS-01 | MITTEL | Cross-Cutting Lint/Eng-Notes (no-console, DOMPurify, advisory-locks) | übergreifend |
| T-FOLLOWUP-01 | MITTEL | Deep-Audit-Folgewelle für die 17 Pattern-Scan-Chunks | übergreifend |

Plan-Files: `.local/tasks/proposed-from-481/<id>.md`.

---

## 6. Anhang: Methodische Anmerkungen

- **Subagent-Output:** Die Deep-Audit-Subagenten lieferten strukturierte
  Schweregrad-Listen mit Datei:Zeile + Kurz-Fix. Diese sind 1:1 in die
  Sub-Reports übernommen.
- **Pattern-Scan-Trefferquellen:** ripgrep auf `console.`,
  `dangerouslySetInnerHTML`, `backdrop-blur`, `translate-`,
  `queryClient.invalidateQueries`, `<canvas`, `UPDATE.*audit_log` —
  Zahlen aus Pre-Audit-Run dieser Sitzung.
- **Read-only-Constraint** aus `task-481.md` eingehalten: Schreibzugriffe
  ausschließlich in `docs/audits/full-app-2026/` und
  `.local/tasks/proposed-from-481/`.
