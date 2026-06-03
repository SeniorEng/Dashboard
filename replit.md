# CareConnect
Streamlines elderly care service management for caregivers, enhancing efficiency and data integrity.

## Run & Operate
- **Run Dev**: `npm run dev` (client & server)
- **Run Server**: `npm run start` (server only)
- **Build**: `npm run build`
- **Typecheck**: `npm run check`
- **Test**: `npm run test` (= `vitest run`). Vitest ist in zwei Projects getrennt: `unit` (reine Logik-/Fitness-Tests aus `tests/unit/` + `tests/architecture/`, **parallel**, kein Server/DB) und `integration` (alle übrigen `tests/**`). Einzelnes Project: `vitest run --project unit`. Die Workflows `test`/`e2e-smoke` laufen über den Orchestrator `scripts/with-ephemeral-db.ts` (isolierte Wegwerf-DBs pro Worker + dedizierte App-Server + geseedeter Template-Cache), NICHT gegen die Dev-DB. Vollständiges Runbook (Configs, Orchestrator, Template-Cache, Env-Schalter): [`docs/test-infrastructure.md`](docs/test-infrastructure.md). Bekannte Flakes + Policy: [`docs/flaky-tests.md`](docs/flaky-tests.md).
- **DB Push**: `drizzle-kit push`
- **Mutation Test**: `npm run mutation` (Stryker, Incremental-Mode, nur die kritischen puren Berechnungs-Module — Runbook: `docs/mutation-testing.md`). Eigener CI-Job `mutation` (nur bei `pull_request`, nur auf geänderten Hotspot-Dateien, Score-Gate break 60 %).
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) läuft bei jedem Push und Pull-Request mit 9 Pflicht-Gates (typecheck, lint, `vitest run`, Architektur-Fitness-Functions, `npm audit`, e2e-smoke, Targeted-Coverage-Gates, OpenAPI-Drift). DB-/Server-Gates brauchen die Repo-Secrets `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` (werden sonst sauber übersprungen). `main` auf `SeniorEng/Dashboard` ist branch-protected (Required-Checks `static-analysis`/`tests`/`e2e-smoke`). Vollständiges Runbook (alle 9 Gates, Neon-Proxy in CI, Test-User-Seed, Branch-Protection): [`docs/ci-pipeline.md`](docs/ci-pipeline.md).
- **Env Vars**: vollständige Liste siehe Tabelle unten. (WhatsApp läuft ebenfalls über die Twilio-Credentials; Meta-Cloud-API-Token werden nicht mehr benötigt.)
- **Dependencies / Renovate**: Dependency-Updates werden automatisch über den [Renovate-Bot](https://docs.renovatebot.com/) (`renovate.json`) gemanagt — gruppierte Wochen-PRs, nur grüne **Patch**-Updates auf **Dev-Dependencies** auto-mergen, Vulnerability-Alerts sofort. Renovate läuft als self-hosted Action `.github/workflows/renovate.yml` (Repo-Secret `RENOVATE_TOKEN` als PAT nötig). Vollständiges Runbook (Gruppierung, Auto-Merge-Regeln, Pausieren, PAT-Anforderungen): [`docs/dependency-management.md`](docs/dependency-management.md).

### Environment Variables

| Name | Required/Optional | Default | Zweck |
|---|---|---|---|
| `DATABASE_URL` | Required | — | PostgreSQL-Connection-String (Neon serverless). |
| `ENCRYPTION_KEY` | Required | — | 64-char Hex-Key für AES-256-GCM-Verschlüsselung sensibler Spalten (`encryptedText`) und `company_settings`-API-Secrets. Fehlt der Key, werden Secrets unverschlüsselt gespeichert/gelesen (Graceful Fallback, nicht für Prod). |
| `NODE_ENV` | Required | — | `development` / `production` / `test`. Steuert u.a. Puppeteer-Launch-Flags (`--single-process` AUS in Prod) und Logging. |
| `TWILIO_ACCOUNT_SID` | Required | — | Twilio-Account-SID (Voice-Call-Bridge + WhatsApp Content API). |
| `TWILIO_AUTH_TOKEN` | Required | — | Twilio-Auth-Token. Per Kunde via `whatsapp_access_token` in `company_settings` overridebar. |
| `TWILIO_PHONE_NUMBER` | Required | — | Twilio-Absendernummer für Voice-Call-Bridge / Lead-Anrufe. |
| `QONTO_SECRET_KEY` | Required | — | Qonto-Bank-API Secret für Payment-Matching. |
| `QONTO_LOGIN` | Required | — | Qonto-Bank-API Login. |
| `LETTEREXPRESS_API_KEY` | Required | — | LetterExpress API-Key für postalischen Dokumentversand. |
| `APP_URL` | Optional | `""` | Öffentliche Basis-URL für ausgehende Links (WhatsApp-Buttons etc.). Fallback hinter `REPLIT_DEV_DOMAIN`. |
| `REPLIT_DOMAINS` | Optional (Replit-Runtime) | — | Komma-separierte Prod-Domains. Erste Domain wird für E-Mail-Absender und Twilio-Webhook-URLs verwendet. |
| `REPLIT_DEV_DOMAIN` | Optional (Replit-Runtime) | — | Dev-Domain-Hostname als Fallback hinter `REPLIT_DOMAINS` für E-Mails / WhatsApp-Links. |
| `REPL_OWNER` | Optional (Replit-Runtime) | — | Repl-Owner-Slug für Twilio-Call-Bridge-Webhook-URL-Generierung. |
| `REPL_SLUG` | Optional (Replit-Runtime) | — | Repl-Slug für Twilio-Call-Bridge-Webhook-URL-Generierung. |
| `PORT` | Optional | `5000` | HTTP-Listen-Port des Express-Servers. |
| `SUPER_ADMIN_EMAIL` | Optional | — | E-Mail eines Users, der beim Startup automatisch zum Superadmin promoted wird. Fehlt = Promotion übersprungen. |
| `EMAIL_TRANSPORT` | Optional | Auto (stub in Dev/Test, real in Prod) | `real` erzwingt echten SMTP-Versand, `stub` erzwingt In-Memory-Stub. |
| `EMAIL_WEBHOOK_SECRET` | Optional | — | Shared Secret für Inbound-E-Mail-Webhook (`/api/webhook/inbound-email`). Fehlt = Webhook akzeptiert keine Requests. |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Required für Object Storage | — | Komma-separierte Such-Pfade für öffentliche Assets im Object-Storage-Bucket. |
| `PRIVATE_OBJECT_DIR` | Required für Object Storage | — | Pfad für private Uploads (Dokumente, Signaturen, generierte PDFs) im Object-Storage-Bucket. |
| `CHROMIUM_PATH` | Optional | Auto (`which chromium` / `which chromium-browser` / `/usr/bin/chromium*`) | Override für Chromium-Binary-Pfad (Puppeteer). In Deployments empfohlen zu setzen. |
| `PUPPETEER_SINGLE_PROCESS` | Optional | `1` in Dev/Test, `0` in Prod | `1`/`true` erzwingt `--single-process`, `0`/`false` verbietet es. |
| `PUPPETEER_NO_ZYGOTE` | Optional | unset | `1`/`true` erzwingt `--no-zygote`, `0`/`false` verbietet es. |
| `PDF_RENDER_CONCURRENCY` | Optional | `2` | Max. paralleler PDF-Renderings (ein laufender + ein wartender bei Default). |
| `STATS_HEALTH_YELLOW` | Optional | `5` | Schwellwert (Tage) für gelben Health-Status in Statistik-Cockpit. |
| `STATS_HEALTH_RED` | Optional | `20` | Schwellwert (Tage) für roten Health-Status in Statistik-Cockpit. |
| `NEON_LOCAL_WS_PROXY` | Optional (nur CI/Local) | unset | Host:Port eines Neon-WebSocket-Proxys (z.B. `localhost:4444`). Gesetzt = `server/lib/db.ts` schaltet Secure-WS/TLS-Pipelining ab und routet den WebSocket über den Proxy, um gegen plain Postgres zu testen. NICHT in Produktion setzen (echter Neon-Host braucht Secure-WS). |

## Stack
- **Frontend**: React 19, TypeScript, Vite, Wouter, `shadcn/ui`, Tailwind CSS v4, TanStack Query
- **Backend**: Express.js, TypeScript, Zod
- **Database**: PostgreSQL (Neon serverless)
- **ORM**: Drizzle ORM
- **Validation**: Zod (with German error map)
- **Build Tool**: esbuild (server), Vite (client)

## Where things live
- **Frontend Source**: `client/src/`
- **Backend Source**: `server/src/`
- **Shared Code**: `shared/` (domain logic, API types, schemas)
- **DB Schema**: `shared/schema/`
- **API Contracts**: `shared/api/`
- **OpenAPI Spec (Schema-First)**: `docs/api/openapi.json` (generiert aus den Zod-Schemas in `shared/api/openapi.ts` via `npm run gen:openapi`; Drift-Gate `npm run gen:openapi -- --check`). Die Zod-Schemas spiegeln die TS-Interfaces in `shared/api/` und werden per Compile-Time-`Exact<…>`-Assertions gegen Drift abgesichert (bricht `tsc`).
- **Theme/Design System**: `client/src/design-system/`, `client/src/index.css`
- **Component Library**: `client/src/components/ui/`
- **Server Routes**: `server/routes/` (modular, e.g., `server/routes/admin/customers/`)
- **DB Storage Layer**: `server/storage/`
- **Startup Migrations**: `server/startup/`
- **Tests**: `tests/` (Vitest)
- **Deployment Config**: `.replit`

## Architecture decisions
- **Mobile-First & Accessibility**: Responsive design with `shadcn/ui` (Radix UI primitives), touch-optimized. UI components use `fixed inset-0 flex items-center justify-center` for dialogs/overlays for sharp text rendering.
- **Strict Data Consistency**: Centralized TanStack Query invalidation via `invalidateRelated()` (`@/lib/query-invalidation`) to maintain cross-domain consistency. All mutation `onSuccess` handlers must use this helper instead of calling `queryClient.invalidateQueries()` directly. Legitimate exceptions (e.g. record-id-scoped keys not covered by a domain) must be marked with a `// invalidate-direct-allowed: <reason>` comment on the line above. The discipline is enforced by `tests/query-invalidation-discipline.test.ts`. `RELATED_DOMAINS` ist **nicht-transitiv** — Aufrufer müssen alle berührten Domains aufzählen. Budget-Spezifika (Customer-Scoping, Refetch-vor-UI-Schließen) siehe [`docs/architecture/budget.md`](docs/architecture/budget.md#query-invalidation-budget-spezifika).
- **GoBD Compliance**: Extensive use of soft-deletes, historization, audit logging for all critical operations (budget mutations, customer changes), server-side PDF generation with integrity hashing. Budget-Tabellen-Historisierung (`budget_allocations` no-resurrect, `customer_budget_type_settings` append-only, Startup-Migration) siehe [`docs/architecture/budget.md`](docs/architecture/budget.md#gobd-historisierung-budget-tabellen).
- **Centralized Logic**: Key functionalities like phone/address formatting, error handling, logging, and access control are centralized in shared utilities or middleware for consistency and maintainability.
- **Budget-Domäne**: Three-Pot-Ledger (§45b/§45a/§39+§42a) mit Cascading-Allocation, FIFO für §45b, virtuellem Auto-Renewal-Modell und Selbstzahler-Routing. Detaillierte Architektur, Pot-spezifische Regeln (Startwert/Carryover/„Unser Anteil") und aktuelle SSoT-Konsolidierung siehe [`docs/architecture/budget.md`](docs/architecture/budget.md).
- **Automatischer Monatsabschluss**: Cutoff = 8. des Folgemonats (auf vorherigen Werktag verschoben bei Wochenende/bundeseinheitlichem Feiertag, siehe `shared/utils/month-close-cutoff.ts`). Auto-Close läuft täglich im `month-close-scheduler` (server/services/month-close-scheduler.ts) und schließt am Cutoff-Tag um 23:00 Berlin-Zeit alle Mitarbeiter mit Aktivität im Vormonat. Reminder-Wellen T-3, T-1 und T-0 (WhatsApp + Email + In-App-Banner). Undokumentierte Termine werden auf Status `expired_unsigned` ("Nicht abgerechnet") gesetzt, automatisch aus Lexware-Export & Statistiken ausgeschlossen (Filter `status='completed'`). Nach dem Auto-Close können nur Superadmins (`isSuperAdmin`) Termine/Zeiteinträge im geschlossenen Monat ändern oder den Monat mit Pflicht-Begründung (≥10 Zeichen, im Audit-Log dokumentiert) wieder öffnen.

## Product
- **Core Functionality**: Appointment scheduling, tracking, and documentation (with digital signatures).
- **Customer Management**: Multi-step customer creation, detailed customer views, German-specific validation (Pflegegrad), deactivation, anonymization (DSGVO Art. 17).
- **Employee Management**: Time tracking (client/non-client work, vacation), pro-rata vacation entitlement, availability, blockers, bulk handover.
- **Financials**: Budgeting (three-pot system with historization), customer-specific temporal pricing, invoicing (GoBD compliant, ZUGFeRD/XRechnung), Qonto bank integration for payment matching.
- **Document Management**: HTML-based templates with placeholders, server-side PDF generation, trigger-based document requirements, employee document proofs, digital signing.
- **Lead Management**: Prospect pipeline with 9 statuses, automatic email replies, Twilio-based call bridge for new leads.
- **Reporting & Statistics**: Dashboard day view, hours overview, comprehensive statistics page (Cockpit, Team, Kunden, Planung).
- **Compliance**: Adherence to German labor laws (ArbZG for auto-breaks), GoBD for data historization and auditing.

## User preferences
- Preferred communication style: Simple, everyday language
- Keine Avatare/Profilbilder: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.
- Keine Blur-Effekte: Kein `backdrop-blur`, kein `bg-black/80` oder ähnlich starke Overlay-Verdunkelung. Dialog-/Sheet-/Drawer-Overlays verwenden maximal `bg-black/50` ohne Blur-Filter. Die UI soll klar und technisch scharf bleiben.
- Keine CSS-Transforms in Overlay-Komponenten: Dialog, AlertDialog, Sheet und Drawer dürfen KEINE `translate`, `scale`, `zoom` oder `slide` CSS-Transforms verwenden. Diese verursachen Sub-Pixel-Rendering und unscharfen Text. Stattdessen: Flexbox-Zentrierung (`fixed inset-0 flex items-center justify-center`) und reine Fade-Animationen (`fade-in-0`/`fade-out-0`, nur opacity). Drawer: `shouldScaleBackground = false`. Ausnahme: Sheet-Slide-Animationen (`slide-in-from-*`/`slide-out-to-*`) sind erlaubt, da Sheets am Bildschirmrand positioniert sind und keine Sub-Pixel-Probleme verursachen.
- Standard-Unterschrift-Komponente: Für ALLE Unterschriften im System MUSS die zentrale `SignaturePad`-Komponente (`@/components/ui/signature-pad.tsx`) verwendet werden. KEINE eigenen Signature-Dialoge, Canvas-Implementierungen oder alternative Unterschriftenlösungen bauen. `SignaturePad` bietet eine konsistente Fullscreen-Unterschriftserfahrung mit „Tippen zum Unterschreiben"-Platzhalter, X-Markierung und einheitlichem Styling. Wird verwendet in: Kundenanlage (signatures-step), Leistungsnachweis-Unterschrift, digitaler Dokumentenfluss.

## Gotchas
- **Database Unique Constraints**: When adding `unique` constraints in Drizzle that match existing PostgreSQL unique indexes (e.g., those ending in `_key`), use `unique("constraint_name").on(col)` instead of `.unique()` to prevent `drizzle-kit push` from attempting to create duplicate constraints.
- **Drizzle ORM Bundling**: `drizzle-orm`, `drizzle-zod`, `@neondatabase/serverless`, and `ws` must NOT be bundled by esbuild for the server build, as bundling `drizzle-orm` breaks SQL template fragment composition.
- **Company Settings Encryption**: API secrets in `company_settings` are AES-256-GCM encrypted at-rest. `ENCRYPTION_KEY` env var is required for encryption/decryption. Graceful fallback if not present, but secrets will be stored/read unencrypted.
- **Sensitive Column Annotation**: Sensitive Spalten werden im Drizzle-Schema mit `encryptedText("col_name")` aus `shared/schema/encrypted-columns.ts` deklariert statt mit `text(...)`. Der Storage-Layer ver-/entschlüsselt diese Felder via `encryptRow`/`decryptRow` (`server/lib/encrypted-row.ts`) automatisch — KEINE manuelle Allow-Liste pflegen. CI-Test `tests/architecture/sensitive-columns.test.ts` failed, wenn eine neue Spalte mit Namen `/secret|token|password|key/i` ohne `encryptedText` oder Allowlist-Eintrag (`ALLOWED_PLAINTEXT_COLUMNS`) angelegt wird.
- **Test Data Hygiene**: Test cleanup scripts exist but require careful execution (`--apply` flag, hostname guard). Do not run cleanup scripts directly on production. Seit der Umstellung auf isolierte Wegwerf-Test-DBs pro Lauf räumt `globalSetup` keine stale Test-Daten mehr auf; die Bulk-Purge-Routen (`purge-prospects`/`purge-customers`/`purge-test-users`, Superadmin-only, in Prod deaktiviert) bleiben als manuelle Werkzeuge. Detail: [`docs/test-infrastructure.md`](docs/test-infrastructure.md#test-daten-hygiene--bulk-purge).
- **Legacy Schema Fields**: Several fields and tables are marked as "legacy" but are still actively used for migration paths or specific functionalities. Do not remove them without thorough dependency checks.
- **Chromium / PDF-Rendering (Tasks #544/#550)**: `server/services/pdf-generator.ts` löst den Chromium-Pfad zur Laufzeit auf (`CHROMIUM_PATH` → `which chromium` → `/usr/bin/chromium*`, KEIN hartcodierter Nix-Store-Hash); beim Boot prüft `runChromiumPreflight()` die Ausführbarkeit (exponiert unter `/api/health → chromium`). Fehlendes/nicht-startfähiges Binary → schneller `ChromiumUnavailableError` statt Hänger, Startup-PDF-Backfill überspringt sich. Rechnungs-PDFs werden im Hintergrund persistiert; Cache-Miss rendert on-demand. Diagnose: `npm run chromium:smoke`. Detail (Launch-Härtung, `--single-process`-Schalter, Ring-Buffer-Diagnose): [`docs/pdf-chromium.md`](docs/pdf-chromium.md).
- **Rechnungs-Line-Item-Mengen (Task #561)**: Kilometer-Lines (`serviceCode IN ('travel_km','customer_km')`) MÜSSEN über `shared/domain/invoice-line-items.ts` quantisiert werden — `quantizeKm` (2 NK) speist denselben Wert in `totalCents` UND ins PDF. Niemals `km * rate` ungerundet rechnen und parallel `Math.round(km)` anzeigen (Drift-Bug RE-2026-0003). Detail (persistierte Spalten, GoBD-Fallback, Drift-Detektor): [`docs/invoice-line-items.md`](docs/invoice-line-items.md).
- **KM-/Geo-Spalten = `numeric`, nicht `real` (Task #678)**: Alle Kilometer-Spalten sind `numeric(10,3)`, alle Geo-Spalten (Lat/Lng) `numeric(9,6)`, gebunden via `numeric(..., { mode: "number" })` (Runtime-Typ bleibt JS-`number`, Storage = exakte Dezimalarithmetik). Migration idempotent im Startup-Hook `server/startup/migrate-km-geo-to-numeric.ts`, KEIN `drizzle-kit push` für diese Spalten. Betroffene Spalten, Audit-/Backfill-Plan: [`docs/migration-km-geo-numeric.md`](docs/migration-km-geo-numeric.md).
- **Rechnungs-Split pro Topf (Task #759)**: Ein Abrechnungslauf mit Anteilen aus mehreren Budget-Töpfen erzeugt N Rechnungen (eine pro `budget_type` + optional Selbstzahler-Rest), verbunden über `invoices.billing_run_id`. Σ-Drift-Garantie via `shared/domain/budget-invoice-split.ts` (Largest-Remainder). Spalten/Tabelle idempotent via `server/startup/ensure-invoice-per-pot-columns.ts`, KEIN `drizzle-kit push`. Detail (Empfänger-Auflösung, Cascade-Storno, PDF/ZUGFeRD): [`docs/architecture/budget.md`](docs/architecture/budget.md) → „Rechnungs-Split pro Topf".
- **WhatsApp-Provider = Twilio**: Versand ausschließlich über die Twilio WhatsApp Content API (`twilio` SDK); `whatsapp_notification_rules.templateName` enthält Twilio Content SIDs (`HX…`), keine Meta-Template-Namen mehr. Detail (veraltete Spalten, Token-Override): [`docs/whatsapp-twilio.md`](docs/whatsapp-twilio.md).

## Pointers
- **Budget-Architektur (Detail)**: `docs/architecture/budget.md` (Pot-Regeln, Historisierung, Selbstzahler, §45b-Spezifika, laufende SSoT-Konsolidierung)
- **Budget-SSoT-Inventur & Beschlüsse**: `docs/budget-ssot-inventory.md` (Konflikt-Matrix, Drei-View-Vorschlag, Phasen-Reihenfolge 1.1 → 1.2 → 1.3 → 2)
- **Audit Methodology**: `.agents/skills/deep-analysis/SKILL.md`
- **Error Handling Conventions**: `.agents/skills/error-handling-audit/SKILL.md`
- **Page-Size Guideline**: `docs/page-size-guideline.md` (≤500 LOC soft, 800 LOC hard limit; pages are thin wrappers, domain code lives in `client/src/features/<domain>/`)
- **Pre-Publish Backup Runbook**: `docs/pre-publish-backup-runbook.md`
- **Test Coverage Matrix**: `tests/README.md`
- **Targeted-Coverage-Gates** (Task #771): `script/coverage-gate.ts` — Per-File-Coverage-Gates statt globalem Gate. Aktuell abgedeckte Module: `billing` (`server/routes/billing.ts`), `qonto` (`server/services/qonto.ts`), `consumption-engine` (`server/storage/budget/consumption-engine.ts`), `month-close-scheduler` (`server/services/month-close-scheduler.ts`). Zwei Modi: `server` (instrumentierter HTTP-Server + c8) und `vitest` (`@vitest/coverage-v8`). Neues Gate = Eintrag in `MODULES` (Schwelle = Ist − ~5 %, kalibrierbar via `COVERAGE_MEASURE_ONLY=1`) + eigener CI-Step in `.github/workflows/ci.yml`. Details: `tests/README.md`.
- **Drift-Detektoren "Anzeige vs. Buchung"** (Task #427): `tests/helpers/equality-check.ts` plus `tests/equality/*` (5 Hotspots: §45b-Cap, Pflegegrad-Preise, Reisekosten, Pro-Rata-Urlaub, Monatsabschluss-Cutoff) und `tests/architecture/calculations-in-shared.test.ts` (verhindert neue `calculate*`/`compute*`-Funktionen außerhalb `shared/domain/`). Property-Based-Detektoren (Task #773, reine fast-check-Properties seed=42/numRuns=100, kein DB-/Server-Setup): `tests/equality/zugferd-roundtrip.test.ts` (ZUGFeRD-XML rendern → parsen → Beträge/Steuersätze/Empfänger/BT-22-Note bit-genau) und `tests/equality/storno-symmetrie.test.ts` (Storno + identische Neuanlage → Σ-Aggregate unverändert, Pot-/Termin-/Kunden-Saldo).
- **E2E Edit-Persistence Smoke-Suite**: `e2e/smoke/edit-persistence.spec.ts` (Playwright, `npm run test:e2e:smoke`). Jedes neue Bearbeitungsformular braucht einen Round-Trip-Test über `expectFieldPersisted` (`e2e/helpers/round-trip.ts`). Pflicht: nach dem Save vollständiger `page.reload()`, sonst wird nur Frontend-State getestet.
- **Mutation-Testing-Runbook**: `docs/mutation-testing.md` (Stryker, Scope/Out-of-scope, CI-Gate, neue Module aufnehmen)
- **Deployment Log**: `docs/deployment-log.md`
- **Knip Configuration**: `knip.json` (for dead code detection)
- **Tailwind Config**: `tailwind.config.ts`
- **Vite Config**: `vite.config.ts`