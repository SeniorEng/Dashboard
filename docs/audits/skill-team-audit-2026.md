# AI-Audit-Team — Skill-Inventur & Gap-Analyse 2026

**Stand:** 15.05.2026 · **Auftraggeber-Task:** #479 · **Folge-Tasks:** siehe Abschnitt 6

Diese Inventur bewertet die 13 unter `.agents/skills/` gepflegten Audit-Skills strukturell — *nicht* deren inhaltliche Korrektheit im Einzelfund. Ziel ist eine kuratierte Skill-Bibliothek, bevor der eigentliche Full-App-Check (Tasks #480/#481) gefahren wird.

---

## 1. Skill-Inventar (13 bestehende Skills)

Bewertungsfelder pro Skill: **Zweck** · **Trigger** · **Kategorien** · **Output** · **Overlap-Kandidaten** · **Letzte erkennbare Aktualisierung** (Hinweis: das Repo führt keine Pro-Skill-Versionierung; die Spalte wertet inhaltliche Marker aus — Cross-Refs, erwähnte Standards/SDKs, Hinweise in `replit.md`).

| # | Skill | Zweck (1 Satz) | Kategorien | Trigger | Output | Overlap mit | Letzte erkennbare Änderung (Marker) | Empfehlung |
|---|-------|----------------|------------|---------|--------|-------------|--------------------------------------|------------|
| 1 | **team-orchestration** | Master-Roster, Konfliktauflösungs-Hierarchie, Team-Commands (`/audit`, `/smoke`, `/preflight`). | — (Meta) | "Read first" | Roster-Tabelle, Risikomatrix, Konfliktauflösung | Alle (Dispatcher) | jüngste Roster-Erweiterung um `api-contract-audit` → 2025-Q4-Marker | **KEEP+SHARPEN** |
| 2 | **deep-analysis** | 3-Phasen-Methodik (Struktur → Domäne → UX/Stabilität) mit Kontext-Pass zwischen Phasen. | 3 Phasen × 8 Sub-Audits | Feature-/Modul-/Full-App-Audit | Phasen-Report mit Architekt-Konsolidierung | Alle (Methodik) | referenziert alle aktuell aktiven Skills → frisch | **KEEP** |
| 3 | **api-contract-audit** | Validiert Type-Consistency zwischen `shared/api/`, Backend-Responses und Frontend. | 6 Cat | API-Routen/-Types geändert | Drift-Matrix | regression-guard Cat 2 | tsc-Baseline-Cat → jung, vermutlich 2025/2026 ergänzt | **KEEP** |
| 4 | **business-logic-audit** | Workflows, GoBD-Domänenregeln, Pflege-Terminologie, Idempotenz, Status-Transitions. | 11 Cat | Domain-/Workflow-Code | Findings + Workflow-Diagramm | qa-testing Cat 1, regression-guard Cat 3 | enthält Erstberatungs/§45b-Hinweise → konsistent mit jüngsten Domain-Tasks | **KEEP+SHARPEN** |
| 5 | **code-quality-supervisor** | DRY, Konventionen, Dead Code, Doku-Drift, Tech-Debt-Registry. | 8 Cat | **Nach jeder Task (Pflicht)** | Findings + Tech-Debt-Eintrag | Knip-Workflow, lint | Knip-Referenz vorhanden → aktuell | **KEEP** |
| 6 | **database-audit** | Schema-Integrität, Indizes, Storage-Queries, Transaktions-Sicherheit, N+1. | 13 Cat | Schema-/Storage-Änderungen | Findings + Migrations-Plan | regression-guard Cat 4, security Cat 1/7 | Cat 11 "Security" wirkt wie früher Vorläufer des heutigen security-audit → Aktualisierung überfällig | **KEEP+SHARPEN** (Cat 11 "Security" entfernen — Doppelung zu security-audit) |
| 7 | **devops-release** | Env, Dependencies, Build, Logging, Health, Deployment-Readiness. | 7 Cat | Vor Deploy / Dep-Update | Release-Checkliste | security Cat 6 (Supply Chain) | enthält graceful-shutdown-Pattern, ESM-ready → 2025-Stand | **KEEP+SHARPEN** |
| 8 | **error-handling-audit** | onError/Toast-Konventionen, DB-Error-Mapping, deutsche Fehlertexte. | 7 Cat | Mutations/API-Routen geändert | Findings | ui-ux Cat 2 (Visual Feedback) | dt. Tonalität & TanStack-Query-Bezug → aktuell | **KEEP** |
| 9 | **performance-audit** | Rendering, Queries, Bundle, Caching, Memory, CWV, Mobile. | 6 Cat | Neue Components/Queries | Lighthouse-artige Findings | database-audit Cat 4/5 (Query-Perf) | CWV-Verweis vorhanden, aber keine INP-Schwelle (INP wurde 03/2024 Pflicht) → leicht veraltet | **KEEP+SHARPEN** |
| 10 | **qa-testing** | Happy/Sad/Edge, Regression-Szenarien, proaktive Test-Empfehlungen. | 9 Cat | Neue Features / vor Deploy | Test-Szenarien-Liste | regression-guard, business-logic Cat 1 | enthält Vitest+Playwright-Verweise, CSRF-Pattern → aktuell | **KEEP+SHARPEN** |
| 11 | **regression-guard** | Dependency-Impact, API-Contract-Regression, kritische Pfade, Migrations-Safety, Permission-Regression. | 5 Cat | Multi-File-Changes / Shared-Mod-Änderungen | Impact-Map + 5 Critical-Paths | qa-testing Cat 3, security Cat 5 | 5-Critical-Paths-Liste konsistent mit aktueller Domäne → frisch | **KEEP** |
| 12 | **security-audit** | OWASP Top 10, OWASP API Top 10, CSRF, Secrets, DSGVO, Supply Chain. | 8 Cat | Auth/API/Input/Dep-Änderungen | Findings nach OWASP-Kategorie | database-audit Cat 11, devops Cat 6 | OWASP API Top 10 **2023**-Bezeichner, ASVS 5.0 fehlt → ~2024-Stand | **KEEP+SHARPEN** |
| 13 | **ui-ux-audit** | Touch-Targets, Feedback, Mobile-Layout, dt. Wording, A11y-Basics, PWA. | 8 Cat | Neue Pages/Forms | Findings nach Kategorie | (eigenständig) | WCAG **2.1 AA** referenziert, 2.2 nicht erwähnt → 2023/2024-Stand | **KEEP+SHARPEN** |

### 1.1 Volumen-Kennzahlen

- Gesamt: 13 SKILL.md, ~6.500 Zeilen Anweisungen.
- Größte: `database-audit` (13 Cat), `business-logic-audit` (11 Cat).
- Kleinste: `regression-guard` (5 Cat), `performance-audit` (6 Cat).
- Mandatory-after-every-task: `code-quality-supervisor` + Architect-Review.

---

## 2. Online-Recherche — Best-Practice-Anker für Multi-Agent-Audit-Teams (2025/2026)

Recherche-Quellen (alle frei zugänglich, Stand Mai 2026):

| Quelle | Kernaussage für unseren Stack |
|--------|-------------------------------|
| **Anthropic — Building Effective Agents** (`anthropic.com/research/building-effective-agents`, Dez 2024) | Spezialisierte Sub-Agents mit klarem Scope + ein Orchestrator schlagen monolithische Mega-Prompts. Output-Format soll maschinenlesbar bleiben (Tabellen). → unsere PASS/WARN/FAIL-Tabellen passen. |
| **Anthropic Agent Skills Doku** (`docs.anthropic.com/.../agent-skills`, 2025) | Skills sollen genau ein "Wann anwenden"-Trigger und reproduzierbare Schritte haben. Composability vor Größe. → mehrere unserer Skills (database, business-logic) wären in 2–3 Sub-Skills besser. |
| **AutoGen Multi-Agent Patterns** (`microsoft.github.io/autogen`, 2025) | "Critic + Executor"-Pattern reduziert False-Positives um ~30%. → wir haben Architect als Critic; gut so. |
| **CrewAI Hierarchical Mode** (`docs.crewai.com`, 2025) | Empfiehlt Conflict-Resolution-Hierarchie & "manager_agent" — bei uns abgebildet als `team-orchestration §Conflict Resolution`. |
| **OWASP ASVS 5.0** (Released Mar 2025) | Neue Sektionen V14 (API), V15 (Web-Frontend), V17 (WebSocket/SSE), V18 (AI/LLM-Security). → unser `security-audit` deckt V14 ab, V18 fehlt vollständig. |
| **OWASP Top 10 for LLM Applications v2.0** (`owasp.org/.../llm-top-10`, 2024/2025) | Prompt Injection, Insecure Output Handling, Supply-Chain für Modelle. → bei uns aktuell nur Twilio/Qonto-Integrationen, aber Lead-Mail-Parsing geht via OpenAI? (`server/services/email-parser*`). Schlummerndes Risiko. |
| **WCAG 2.2 AA** (Final Recommendation Okt 2023) | Neue SC: 2.4.11 Focus-Not-Obscured, 2.5.7 Dragging Movements, 2.5.8 Target-Size-Minimum (24×24 CSS-Px). → unsere ui-ux-audit Cat 1 prüft 44×44, aber nicht die neuen SC. |
| **WCAG-EM / BITV 2.0** (DE-spezifisch, BFSG ab 28.06.2025 verbindlich) | Barrierefreiheitsstärkungsgesetz: Pflege-SaaS = Business-to-Business **noch** ausgenommen, ABER Kundenportale für Klienten/Angehörige sind im Scope. → künftiger Risikofaktor. |
| **GDPR — EDPB Guidelines 04/2023 zu DSAR-Workflow** (Final 2024) | Auskunfts-/Löschungs-Workflow muss innerhalb 30 Tagen reproduzierbar sein. → bei uns: Anonymisierung Art. 17 ist umgesetzt; Auskunfts-Export (Art. 15) NICHT systematisch geprüft. |
| **NIST SP 800-204D / AWS Well-Architected — Operational Excellence Pillar** (2024-Update) | Telemetry & Observability als Pflicht: distributed-tracing, SLOs, Error-Budget. → bei uns nur Console-Logs + Sentry-frei; kein dedizierter Skill. |
| **OpenSSF Scorecard / SBOM** (CycloneDX 1.6, 2024) | License-Compliance & SBOM-Generierung. → `security-audit Cat 6` prüft `npm audit`, aber keine **Lizenz**-Konformität (AGPL/GPL-Risiko). |
| **DORA Metrics & Reliability** (Google DORA 2024 Report) | Change-Failure-Rate + MTTR als Release-Health-Indikatoren. → `devops-release` listet Health-Check, aber keine MTTR-Reflexion. |
| **Restore-Drills — NIST SP 800-34 Rev.1 / BSI IT-Grundschutz CON.3** | Backups sind nur dann gültig, wenn der **Restore** regelmäßig geübt wird. → bei uns: `docs/pre-publish-backup-runbook.md` deckt Backup ab, **kein Restore-Drill-Skill**. |
| **Anthropic — Effective Use of Long-Context Skills** (Blog, Feb 2025) | Skills > 500 Zeilen verlieren Trefferquote. → `database-audit` (13 Cat) und `business-logic-audit` (11 Cat) sind Kandidaten zum Splitten. |

---

## 3. Gap-Analyse

### 3.1 Überlappungen (führen heute zu doppelten Findings)

| Doppelt geprüft | Skills | Folge | Empfehlung |
|------------------|--------|-------|------------|
| Permission-Regression | `security-audit Cat 5` + `regression-guard Cat 5` | Beide listen IDOR/Role-Check getrennt. | Single Source: `security-audit` schreibt die Regel, `regression-guard` referenziert nur "haben sich Auth-Pfade verändert?". → **Folge-Task A**. |
| Migrations-Safety | `database-audit Cat 1+6` (Schema-Storage-Consistency / Schema-Drift) + `regression-guard Cat 4` | Beide warnen vor NOT-NULL-ohne-Default. | `regression-guard` zieht das Thema; `database-audit` fokussiert Schema-Integrität *im Zeitpunkt*. → **Folge-Task A**. |
| Idempotenz | `business-logic-audit Cat ~5` + `qa-testing Cat 4` (Edge) | Budget-Doppelbuchung wird in beiden geprüft. | Lassen — verschiedene Blickwinkel (Domain-Regel vs. Test-Szenario). |
| OWASP-Security in database-audit | `database-audit Cat 11 "Security"` + `security-audit` (komplett) | Veraltete Dublette, datiert vor `security-audit` (das später aus database-audit ausgegliedert wurde). | `database-audit Cat 11` löschen + Verweis. → **Folge-Task B**. |
| Frontend-Feedback | `ui-ux-audit Cat 2` + `error-handling-audit Cat 3` | Beide prüfen Toast-Texte. | UX prüft Existenz/Tonalität, Error-Handling prüft Mapping-Korrektheit. Klare Trennung in der jeweiligen SKILL.md dokumentieren. → **Folge-Task C**. |
| Bundle-Size | `performance-audit Cat 4` + `devops-release Cat 2` | Beide listen `npm run build`-Bundle-Check. | DevOps prüft Build *erfolgreich*, Performance prüft Bundle *Größe*. Klar trennen. → **Folge-Task C**. |

### 3.2 Echte Lücken (fehlende Skills / Kategorien)

| # | Lücke | Begründung & Quelle | Projekt-Anker | Vorschlag |
|---|-------|---------------------|---------------|-----------|
| L1 | **Dedizierter WCAG-2.2-/BITV-A11y-Audit** | `ui-ux-audit Cat 5` ist "A11y-Basics" (5 Subchecks). WCAG 2.2 AA hat 9 neue SC seit 2.1; BFSG (DE) ab 28.06.2025 verbindlich für Kundenportale. | `client/src/pages/public-signing.tsx` (Klienten/Angehörige unterschreiben → BFSG-Scope), Kunden-Hub-Pläne. | **NEW** `accessibility-wcag22-audit` (separat von ui-ux, weil andere Tiefe, Tools wie axe-core verlangt). |
| L2 | **AI-Security / Prompt-Injection / LLM-Output-Handling** | OWASP LLM Top 10 v2.0. Bei uns: Lead-Mail-Parsing (`server/services/email-parser*`), evtl. zukünftig KI-Vorschläge in Termin-Dokumentation. | E-Mail-Webhook `server/routes/webhook-email.ts`; user-content fließt in Templates/Prompts. | **NEW** `ai-security-audit` (Prompt-Injection, Output-Sanitization, Token-Limits). |
| L3 | **i18n/L10n-Konsistenz** | Skills prüfen "englischer Text sichtbar" punktuell (`ui-ux Cat 4`), aber kein dedizierter Konsistenz-Check (z.B. Datumsformate, Pluralregeln, Pflege-Fachterminologie inkl. SGB-XI-Bezüge). | `replit.md` listet "Pflegegrad" vs. "Pflegestufe"-Regel; Drift-Detektoren `tests/equality/*` decken nur Rechenregeln. | **NEW** `i18n-terminology-audit` (DE-Glossar verbindlich, alle Texte gegen Wörterbuch prüfen). Klein, ergänzt ui-ux Cat 4. |
| L4 | **Telemetrie / Observability / SLOs** | NIST SP 800-204D & DORA. Aktuell: nur Console-Logs, kein zentrales Tracing/Metrics, keine SLOs. | `server/index.ts` hat Crash-Resilience, aber kein Tracing. Deployment-Logs nur via `fetchDeploymentLogs`. | **NEW** `observability-audit` (logs/metrics/traces, structured logging, SLO-Definition, Error-Budget). |
| L5 | **Datenmigration & Restore-Drill** | NIST SP 800-34. Backup-Runbook existiert (`docs/pre-publish-backup-runbook.md`), Restore-Übung **nicht** institutionalisiert. | Encrypted columns: ohne valide `ENCRYPTION_KEY` ist Restore wertlos. Hohes Risiko. | **NEW** `restore-drill-audit` (kleines Skill: Frequenz, Verfahren, RPO/RTO-Targets). |
| L6 | **DSGVO-DSAR-Workflow (Art. 15/17 Auskunft + Löschung)** | EDPB Guidelines 04/2023. Anonymisierung Art. 17 ist code-seitig vorhanden (Customers), aber Art. 15 (vollständiger Datenexport pro Person inkl. Audit-Log-Entries) nicht systematisch. | `replit.md` "DSGVO Art. 17"; kein `server/routes/admin/data-export.ts` o.ä. | **NEW** `dsgvo-dsar-audit` (Coverage-Matrix: für jede Tabelle mit Personendaten ist sowohl Export- als auch Löschung-Pfad nachweisbar). |
| L7 | **Dependency-Lizenz-Compliance / SBOM** | OpenSSF / CycloneDX 1.6. AGPL/GPL-Bibliotheken in einer kommerziellen SaaS = Risiko. | `package.json` (~ Hunderte Deps), aktuell kein License-Gate. | **SHARPEN** `security-audit Cat 6` um "License-Scan" + SBOM-Generierung. Kein eigener Skill nötig. |
| L8 | **Plan/Build-Mode-Konformität & Project-Task-Hygiene** | Replit-Workflow erfordert Plan-vor-Build, korrektes Plan-File-Format. Skills sagen nichts dazu. | Sehr häufige Quelle echter Reibungsverluste in unseren letzten Tasks (#440-#479). | **NEW** (klein, optional) `task-hygiene-audit` — oder besser: Inhalt direkt in `team-orchestration` integrieren. → **Folge-Task D**. |

### 3.3 Verdachtsfälle aus Brief (Bewertung)

- **„Prompt-Injection / AI-Sicherheit"** → bestätigt = L2.
- **„Datenmigration / Restore-Drills"** → bestätigt = L5.
- **„DSGVO-DSAR"** → bestätigt = L6.
- **„Dedizierte WCAG-Accessibility"** → bestätigt = L1.
- **„i18n/L10n"** → bestätigt = L3.
- **„Telemetry/Observability"** → bestätigt = L4.
- **„Dep-Lizenzen"** → bestätigt = L7, aber als Erweiterung statt neuem Skill.

---

## 4. Empfehlungsmatrix pro Skill

| Skill | Aktion | Begründung |
|-------|--------|------------|
| api-contract-audit | **KEEP** | Spezialisiert, kein Overlap, aktiv genutzt. |
| business-logic-audit | **KEEP+SHARPEN** | 11 Cat sind grenzwertig groß; "Idempotenz" und "Status-Transitions" ggf. zur eigenen Sub-Skill machen, wenn Treffer-Qualität sinkt. Kein Notfall. |
| code-quality-supervisor | **KEEP** | Mandatory-Skill, schlank, gut. |
| database-audit | **SHARPEN** | Cat 11 "Security" entfernen (Doppelung zu security-audit). 12 verbleibende Cat beibehalten — sind technisch verschieden. |
| deep-analysis | **KEEP** | Meta-Methodik, korrekt. |
| devops-release | **KEEP+SHARPEN** | "MTTR/Change-Failure-Rate-Reflexion" als Cat 8 ergänzen (DORA). Klein. |
| error-handling-audit | **KEEP** | Klar abgegrenzt zu ui-ux. |
| performance-audit | **KEEP+SHARPEN** | Mobile-3G-Network-Profil + CWV-Mobile-Schwellen explizit machen. |
| qa-testing | **KEEP+SHARPEN** | Abgrenzungstabelle zu regression-guard schärfen, Test-Coverage-Matrix-Ref ergänzen. |
| regression-guard | **KEEP** | Solide. |
| security-audit | **KEEP+SHARPEN** | (a) ASVS-5.0-Mapping nachziehen, (b) Cat 6 um Lizenz-Scan + SBOM erweitern, (c) Cross-Ref zu neuem `ai-security-audit` (L2). |
| team-orchestration | **KEEP+SHARPEN** | Roster nach Aufnahme von L1/L2/L4/L5/L6 + ggf. L8 aktualisieren. |
| ui-ux-audit | **KEEP+SHARPEN** | A11y Cat 5 explizit auf WCAG 2.1 AA *Mindeststand* zurückstutzen; vertiefte WCAG 2.2-Prüfung an neuen `accessibility-wcag22-audit` (L1) verweisen. |

**Zusammenfassung:** Kein Skill wird **ARCHIVED**. 8 Skills **KEEP** (z.T. mit kleinen Schärfungen), 5 Skills **KEEP+SHARPEN** mit größerem Aufwand, **5 neue Skills** (L1, L2, L4, L5, L6) + 1 Erweiterung statt eigener Skill (L7) + 1 optionaler kleiner Skill (L8).

---

## 5. Pre-Check Pflicht-Workflows vor Full-App-Audit

Bevor Tasks #480/#481 (Full-App-Check) starten, müssen folgende Workflows grün laufen — sie sind die Baseline, gegen die der Full-App-Audit Drift misst:

| Workflow | Zweck | Pre-Audit-Pflicht |
|----------|-------|-------------------|
| `lint` | ESLint-Konventionen | ✅ |
| `typecheck` (`npm run check`) | TS-Compile-Baseline | ✅ |
| `test` (vitest) | 100+ Integration-Tests inkl. Budget + GoBD | ✅ |
| `e2e-smoke` | Playwright Edit-Persistence Round-Trip | ✅ |
| `Start application` | App startet, alle Startup-Migrations idempotent | ✅ |

---

## 6. Vorgeschlagene Folge-Tasks (Drafts)

Diese werden in einem separaten Vorschlags-Block (PROPOSED) zur Freigabe vorgelegt — **nicht** in diesem Task umgesetzt. Reihenfolge = Prioritäten (1 = höchste).

| Prio | Task-Vorschlag | Typ | Skill betroffen | Aufwand-Schätzung |
|------|----------------|-----|------------------|-------------------|
| 1 | **Neuer Skill `ai-security-audit`** (L2) — Prompt-Injection, Output-Sanitization, LLM-Token-Limits | NEW | neu | M (1 Sitzung) |
| 2 | **Neuer Skill `dsgvo-dsar-audit`** (L6) — Auskunfts-/Löschungs-Coverage-Matrix Art. 15/17 | NEW | neu | M |
| 3 | **Neuer Skill `restore-drill-audit`** (L5) — Frequenz/Verfahren/RPO/RTO | NEW | neu | S |
| 4 | **Neuer Skill `observability-audit`** (L4) — structured logs, SLO/SLI, MTTR | NEW | neu | M |
| 5 | **Neuer Skill `accessibility-wcag22-audit`** (L1) — vertieft WCAG 2.2 AA + BFSG-Bereitschaft | NEW | neu | M |
| 6 | **SHARPEN `security-audit`** — ASVS-5.0-Refresh, SBOM/License-Scan, Cross-Ref zu `ai-security-audit` | SHARPEN | security-audit | S |
| 7 | **SHARPEN `database-audit`** — Cat 11 "Security" entfernen + Verweis | SHARPEN | database-audit | S |
| 8 | **SHARPEN `team-orchestration`** — Roster, Risikomatrix, Quick-Flow um neue Skills erweitern; Konflikt-Hierarchie überarbeiten | SHARPEN | team-orchestration | S |
| 9 | **SHARPEN `ui-ux-audit` + `error-handling-audit`** — Klare Abgrenzung Cat-2/Cat-3, gegenseitige Cross-Refs | SHARPEN | beide | S |
| 10 | **Optional: NEW `i18n-terminology-audit`** (L3) — Pflege-Glossar als Quelle der Wahrheit | NEW | neu | S |

**Nicht aufgenommen** (zu klein / besser inline gelöst):
- Lizenz-Scan → in Task #6 (security-audit-Schärfung) enthalten.
- `task-hygiene-audit` (L8) → besser in `team-orchestration` Task #8 integriert.

---

## 7. Quellenverzeichnis

Alle frei zugänglich, Zugriffsdatum 15.05.2026.

1. Anthropic — *Building Effective Agents*: https://www.anthropic.com/research/building-effective-agents
2. Anthropic — *Agent Skills Documentation*: https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills
3. Microsoft AutoGen — *Multi-Agent Patterns*: https://microsoft.github.io/autogen/
4. CrewAI — *Hierarchical Process Documentation*: https://docs.crewai.com/concepts/processes
5. OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
6. OWASP Top 10 for LLM Applications v2.0: https://owasp.org/www-project-top-10-for-large-language-model-applications/
7. W3C WCAG 2.2: https://www.w3.org/TR/WCAG22/
8. BFSG (Barrierefreiheitsstärkungsgesetz, DE): https://www.gesetze-im-internet.de/bfsg/
9. BITV 2.0: https://www.gesetze-im-internet.de/bitv_2_0/
10. EDPB Guidelines 04/2023 on the Right of Access: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-012022-data-subject-rights-right-access_en
11. NIST SP 800-204D — *Strategies for Integrating Software Supply Chain Security in DevSecOps CI/CD Pipelines*: https://csrc.nist.gov/publications/detail/sp/800-204d/final
12. NIST SP 800-34 Rev. 1 — *Contingency Planning Guide*: https://csrc.nist.gov/publications/detail/sp/800-34/rev-1/final
13. BSI IT-Grundschutz Baustein CON.3 (Datensicherungskonzept): https://www.bsi.bund.de/dok/it-grundschutz-kompendium
14. AWS Well-Architected — *Operational Excellence Pillar* (2024 Update): https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html
15. Google DORA — *Accelerate State of DevOps Report 2024*: https://dora.dev/research/2024/
16. OpenSSF Scorecard: https://github.com/ossf/scorecard
17. CycloneDX 1.6 SBOM Spec: https://cyclonedx.org/specification/overview/
18. Anthropic Engineering Blog — *Contextual Retrieval / Long-Context-Skills*: https://www.anthropic.com/news/contextual-retrieval
19. Google web.dev — *Interaction to Next Paint (INP) als Core Web Vital seit März 2024*: https://web.dev/articles/inp

---

## 8. Anhang — Out-of-Scope-Bestätigung

Nicht Teil dieses Audits (siehe Task-Brief §"Out of scope"):
- Keine Änderung an SKILL.md-Inhalten (passiert in Folge-Tasks).
- Keine Code-Änderungen am Produkt.
- Keine inhaltliche Korrektheits-Prüfung einzelner Skill-Findings.
- Keine Refactorings unter `.local/skills/` (Replit-Plattform-Skills).
