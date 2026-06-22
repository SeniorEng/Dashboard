# CareConnect
Streamlines elderly care service management for caregivers, enhancing efficiency and data integrity.

## Run & Operate
- **Run Dev**: `npm run dev` (client & server)
- **Run Server**: `npm run start` (server only)
- **Build**: `npm run build`
- **Typecheck**: `npm run check`
- **Test**: `npm run test` (= `vitest run`). Vitest ist in zwei Projects getrennt: `unit` (reine Logik-/Fitness-Tests aus `tests/unit/` + `tests/architecture/`, **parallel**, kein Server/DB) und `integration` (alle übrigen `tests/**`). Einzelnes Project: `vitest run --project unit`. Die Workflows `test`/`e2e-smoke` laufen über den Orchestrator `scripts/with-ephemeral-db.ts` (isolierte Wegwerf-DBs pro Worker + dedizierte App-Server + geseedeter Template-Cache), NICHT gegen die Dev-DB. Vollständiges Runbook (Configs, Orchestrator, Template-Cache, Env-Schalter): [`docs/test-infrastructure.md`](docs/test-infrastructure.md). Bekannte Flakes + Policy: [`docs/flaky-tests.md`](docs/flaky-tests.md).
- **DB Push**: `drizzle-kit push`
- **Dev-DB Backup/Reseed**: `npm run db:backup-dev` (Pre-Phase-Snapshot der Dev-DB, hält letzte 5 pro Format vor) · `npm run db:reseed-dev` (Trockenlauf; `-- --apply` setzt die Dev-DB auf saubere synthetische Basis zurück, danach `Start application`-Workflow neu starten). NUR Dev, nie Prod (Guards). Runbook: [`docs/dev-database-runbook.md`](docs/dev-database-runbook.md).
- **Mutation Test**: `npm run mutation` (Stryker, Incremental-Mode, nur die kritischen puren Berechnungs-Module — Runbook: `docs/mutation-testing.md`). Eigener CI-Job `mutation` (nur bei `pull_request`, nur auf geänderten Hotspot-Dateien, Score-Gate break 60 %).
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) läuft bei jedem Push und Pull-Request mit 10 Pflicht-Gates (typecheck, lint, `vitest run`, Architektur-Fitness-Functions, `npm run audit:ci` (better-npm-audit + `.nsprc`-Allowlist), e2e-smoke, Targeted-Coverage-Gates, OpenAPI-Drift, E-Rechnung-Validierung EN 16931/PDF/A-3). DB-/Server-Gates brauchen die Repo-Secrets `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` (werden sonst sauber übersprungen). `main` auf `SeniorEng/Dashboard` ist branch-protected (Required-Checks `static-analysis`/`tests`/`e2e-smoke`/`erechnung-validation`). Vollständiges Runbook (alle 10 Gates, Neon-Proxy in CI, Test-User-Seed, Branch-Protection): [`docs/ci-pipeline.md`](docs/ci-pipeline.md).
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
- **Backend**: Express.js, TypeScript, Zod (German error map)
- **Database**: PostgreSQL (Neon serverless) · **ORM**: Drizzle ORM
- **Build**: esbuild (server), Vite (client)

## Where things live
- **Frontend**: `client/src/` (Design System `client/src/design-system/` + `client/src/index.css`; UI lib `client/src/components/ui/`)
- **Backend**: `server/src/`; Routes `server/routes/` (modular, e.g. `server/routes/admin/customers/`); Storage `server/storage/`; Startup-Migrations `server/startup/`
- **Shared**: `shared/` (domain logic, API contracts `shared/api/`, schemas `shared/schema/`)
- **OpenAPI**: `docs/api/openapi.json`, generiert aus den Zod-Schemas in `shared/api/openapi.ts` via `npm run gen:openapi` (Drift-Gate `--check`). Zod-Schemas sind per Compile-Time-`Exact<…>`-Assertions gegen die TS-Interfaces abgesichert (bricht `tsc`).
- **Tests**: `tests/` (Vitest) · **Deployment Config**: `.replit`

## Architecture decisions
- **Mobile-First & Accessibility**: Responsive `shadcn/ui` (Radix), touch-optimiert; Dialoge/Overlays via `fixed inset-0 flex items-center justify-center` für scharfen Text.
- **Strict Data Consistency**: Zentrale TanStack-Query-Invalidierung via `invalidateRelated()` (`@/lib/query-invalidation`) — alle Mutation-`onSuccess` MÜSSEN diesen Helper nutzen, nicht `queryClient.invalidateQueries()` direkt. Legitime Ausnahmen mit `// invalidate-direct-allowed: <reason>` markieren. Enforced durch `tests/query-invalidation-discipline.test.ts`. `RELATED_DOMAINS` ist nicht-transitiv (alle berührten Domains aufzählen). Budget-Spezifika: [`docs/architecture/budget.md`](docs/architecture/budget.md#query-invalidation-budget-spezifika).
- **GoBD Compliance**: Soft-Deletes, Historisierung, Audit-Logging aller kritischen Operationen, server-seitige PDF-Generierung mit Integritäts-Hash. Budget-Historisierung: [`docs/architecture/budget.md`](docs/architecture/budget.md#gobd-historisierung-budget-tabellen).
- **Centralized Logic**: Telefon-/Adress-Formatierung, Error-Handling, Logging und Access-Control liegen zentral in shared Utilities / Middleware.
- **Budget-Domäne**: Three-Pot-Ledger (§45b/§45a/§39+§42a) mit Cascading-Allocation, FIFO für §45b, Auto-Renewal und Selbstzahler-Routing. Detail: [`docs/architecture/budget.md`](docs/architecture/budget.md).
- **Automatischer Monatsabschluss**: Cutoff = 8. des Folgemonats (auf vorherigen Werktag verschoben bei Wochenende/Feiertag, `shared/utils/month-close-cutoff.ts`). `month-close-scheduler` schließt am Cutoff-Tag 23:00 Berlin alle Mitarbeiter mit Vormonats-Aktivität; Reminder T-3/T-1/T-0 (WhatsApp+Email+Banner). Undokumentierte Termine → Status `expired_unsigned` (aus Export & Statistik ausgeschlossen, Filter `status='completed'`). Nach Auto-Close ändern/öffnen nur Superadmins (Wieder-Öffnen mit Pflicht-Begründung ≥10 Zeichen, Audit-Log).

## Product
- **Core**: Terminplanung, Tracking und Dokumentation (digitale Unterschriften).
- **Customer Management**: Multi-Step-Anlage, Detailansichten, DE-Validierung (Pflegegrad), Deaktivierung, Anonymisierung (DSGVO Art. 17).
- **Employee Management**: Zeiterfassung (Kunde/Nicht-Kunde, Urlaub), Pro-Rata-Urlaub, Verfügbarkeit, Blocker, Bulk-Handover.
- **Financials**: Budgetierung (Three-Pot), kundenspezifische temporale Preise, GoBD-konforme Rechnungen (ZUGFeRD/XRechnung), Qonto-Payment-Matching.
- **Document Management**: HTML-Templates mit Platzhaltern, server-seitige PDFs, trigger-basierte Dokumentpflichten, Mitarbeiter-Nachweise, digitales Signing.
- **Lead Management**: Prospect-Pipeline (9 Status), automatische E-Mail-Antworten, Twilio-Call-Bridge.
- **Reporting & Statistics**: Dashboard-Tagesansicht, Stunden-Übersicht, Statistik-Seite (Cockpit, Team, Kunden, Planung).
- **Compliance**: DE-Arbeitsrecht (ArbZG Auto-Pausen), GoBD für Historisierung/Audit.

## User preferences
- Preferred communication style: Simple, everyday language
- Keine Avatare/Profilbilder: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.
- Keine Blur-Effekte: Kein `backdrop-blur`, kein `bg-black/80` oder ähnlich starke Overlay-Verdunkelung. Dialog-/Sheet-/Drawer-Overlays verwenden maximal `bg-black/50` ohne Blur-Filter. Die UI soll klar und technisch scharf bleiben.
- Keine CSS-Transforms in Overlay-Komponenten: Dialog, AlertDialog, Sheet und Drawer dürfen KEINE `translate`, `scale`, `zoom` or `slide` CSS-Transforms verwenden. Diese verursachen Sub-Pixel-Rendering und unscharfen Text. Stattdessen: Flexbox-Zentrierung (`fixed inset-0 flex items-center justify-center`) und reine Fade-Animationen (`fade-in-0`/`fade-out-0`, nur opacity). Drawer: `shouldScaleBackground = false`. Ausnahme: Sheet-Slide-Animationen (`slide-in-from-*`/`slide-out-to-*`) sind erlaubt, da Sheets am Bildschirmrand positioniert sind und keine Sub-Pixel-Probleme verursachen.
- Standard-Unterschrift-Komponente: Für ALLE Unterschriften im System MUSS die zentrale `SignaturePad`-Komponente (`@/components/ui/signature-pad.tsx`) verwendet werden. KEINE eigenen Signature-Dialoge, Canvas-Implementierungen oder alternative Unterschriftenlösungen bauen. `SignaturePad` bietet eine konsistente Fullscreen-Unterschriftserfahrung mit „Tippen zum Unterschreiben"-Platzhalter, X-Markierung und einheitlichem Styling. Wird verwendet in: Kundenanlage (signatures-step), Leistungsnachweis-Unterschrift, digitaler Dokumentenfluss.
- **Ersetzungs-Regel (ersetzen statt hinzufügen)**: Jede neue Funktion, Tabelle, Spalte oder jeder neue Mechanismus MUSS benennen, welche bestehende Sache er ERSETZT. Lautet die Antwort „keine, kommt zusätzlich hinzu", wird NICHT gebaut, sondern zuerst bei Alrik rückgefragt. Die Regel gilt ausdrücklich auch für die KI selbst und bekämpft die Wurzel der zufälligen Komplexität (additives Wachstum). Vorhandenes konsolidieren/ersetzen geht vor Neuanlage.
- **Eine SSoT pro fachlicher Frage (+ Integer-Cents)**: Für jede fachliche Frage existiert genau EINE Funktion; Anzeige- UND Schreibpfade importieren dieselbe — nie zwei parallele Berechnungen. Bestehende Orte heute: „verfügbar?" → der eine Budget-Reader (`server/storage/budget/unified-reader.ts` + Domänenlogik in `shared/domain/budget/`); „dokumentiert?" → `server/lib/appointment-signed.ts`; „Monat zu?" → die gemeinsame Monatsabschluss-Readiness; „Preis?" → die konsolidierte Preis-Logik. Geldbeträge sind ausnahmslos Integer-Cents (keine Floats/Euro-Strings in Berechnungen).

## Gotchas
- **Database Unique Constraints**: Bei `unique`-Constraints, die existierende PG-Indizes (Endung `_key`) matchen, `unique("constraint_name").on(col)` statt `.unique()` nutzen, sonst versucht `drizzle-kit push` einen Duplikat-Constraint.
- **Drizzle ORM Bundling**: `drizzle-orm`, `drizzle-zod`, `@neondatabase/serverless`, `ws` dürfen vom esbuild-Server-Build NICHT gebundlet werden (bricht SQL-Template-Komposition).
- **Company Settings Encryption**: API-Secrets in `company_settings` sind AES-256-GCM at-rest; `ENCRYPTION_KEY` nötig (Graceful Fallback unverschlüsselt, nicht für Prod).
- **Sensitive Column Annotation**: Sensible Spalten via `encryptedText("col")` (`shared/schema/encrypted-columns.ts`) deklarieren, nicht `text(...)`; Storage ver-/entschlüsselt via `encryptRow`/`decryptRow` automatisch — keine manuelle Allow-Liste. Neue Spalte `/secret|token|password|key/i` ohne `encryptedText`/Allowlist → `tests/architecture/sensitive-columns.test.ts` failed.
- **Legacy Schema Fields**: Mehrere als "legacy" markierte Felder/Tabellen sind weiterhin aktiv (Migration/Sonderfälle) — nicht ohne Dependency-Check entfernen.
- **Chromium / PDF-Rendering**: Chromium-Pfad zur Laufzeit aufgelöst (`CHROMIUM_PATH` → `which chromium` → `/usr/bin/chromium*`, kein hartcodierter Hash); Boot-Preflight unter `/api/health → chromium`; fehlendes Binary → schneller `ChromiumUnavailableError`. Diagnose: `npm run chromium:smoke`. Detail: [`docs/pdf-chromium.md`](docs/pdf-chromium.md).
- **Rechnungs-Line-Item-Mengen**: Kilometer-Lines (`travel_km`/`customer_km`) MÜSSEN über `shared/domain/invoice-line-items.ts` quantisiert werden (`quantizeKm`, 2 NK, identisch in `totalCents` UND PDF) — nie `km*rate` ungerundet + `Math.round(km)` parallel. Detail: [`docs/invoice-line-items.md`](docs/invoice-line-items.md).
- **KM-/Geo-Spalten = `numeric`**: KM-Spalten `numeric(10,3)`, Geo (Lat/Lng) `numeric(9,6)`, gebunden via `numeric(..., { mode: "number" })`. Migration idempotent in `server/startup/migrate-km-geo-to-numeric.ts`, KEIN `drizzle-kit push`. Detail: [`docs/migration-km-geo-numeric.md`](docs/migration-km-geo-numeric.md).
- **Rechnungs-Split pro Topf**: Multi-Pot-Lauf → N Rechnungen (pro `budget_type` + optional Selbstzahler-Rest), verbunden über `invoices.billing_run_id`; Σ-Garantie via `shared/domain/budget-invoice-split.ts`. Spalten idempotent via `server/startup/ensure-invoice-per-pot-columns.ts`, KEIN `drizzle-kit push`. Detail: [`docs/architecture/budget.md`](docs/architecture/budget.md).
- **WhatsApp-Provider = Twilio**: Versand nur über Twilio WhatsApp Content API; `whatsapp_notification_rules.templateName` enthält Twilio Content SIDs (`HX…`). Detail: [`docs/whatsapp-twilio.md`](docs/whatsapp-twilio.md).
- **Test Data Hygiene**: Cleanup-Skripte brauchen `--apply` + Hostname-Guard; nie auf Prod. `globalSetup` räumt seit den Wegwerf-DBs keine stale Daten mehr; Bulk-Purge-Routen (Superadmin-only, in Prod deaktiviert) sind manuelle Werkzeuge. Detail: [`docs/test-infrastructure.md`](docs/test-infrastructure.md#test-daten-hygiene--bulk-purge).

## Pointers
- **Budget-Architektur**: [`docs/architecture/budget.md`](docs/architecture/budget.md) (Pot-Regeln, Historisierung, Selbstzahler, §45b, SSoT). Inventur/Beschlüsse: `docs/budget-ssot-inventory.md`. Rechts-Spezifikation (gesetzliche Beträge R-45B/45A/39/SZ, Stand 2026): `docs/budget-legal-spec.md`. SSoT-Vollständigkeits-Audit (welcher Code beantwortet welche der 4 Fragen + Guards): `docs/budget-ssot-audit.md`.
- **Audit Methodology**: `.agents/skills/deep-analysis/SKILL.md` · **Error Handling Conventions**: `.agents/skills/error-handling-audit/SKILL.md`
- **Page-Size Guideline**: `docs/page-size-guideline.md` (≤500 LOC soft, 800 hard; Pages sind dünne Wrapper, Domain-Code in `client/src/features/<domain>/`)
- **Test Coverage Matrix**: `tests/README.md`
- **Targeted-Coverage-Gates**: `script/coverage-gate.ts` — Per-File-Gates (aktuell `billing`, `qonto`, `consumption-engine`, `month-close-scheduler`). Modi `server` (c8) / `vitest`. Neues Gate = Eintrag in `MODULES` + CI-Step. Details: `tests/README.md`.
- **Drift-Detektoren "Anzeige vs. Buchung"**: `tests/helpers/equality-check.ts` + `tests/equality/*` (5 Hotspots); `tests/architecture/calculations-in-shared.test.ts` verbietet `calculate*`/`compute*` außerhalb `shared/domain/`. Property-Based: `tests/equality/zugferd-roundtrip.test.ts`, `tests/equality/storno-symmetrie.test.ts`.
- **E2E Edit-Persistence Smoke-Suite**: `e2e/smoke/edit-persistence.spec.ts` (`npm run test:e2e:smoke`). Jedes neue Bearbeitungsformular braucht einen Round-Trip-Test über `expectFieldPersisted` (`e2e/helpers/round-trip.ts`) mit vollständigem `page.reload()` nach Save.
- **E-Rechnungs-Validierung (ZUGFeRD/Factur-X EN 16931)**: `docs/erechnung-validation.md` — `npm run validate:erechnung` (Mustang/KoSIT + veraPDF, ohne Java sauberer Skip), CI-Gate `erechnung-validation`. Standard-Profil = `en16931`; Non-Strict-Fallback per Audit-Log `invoice_zugferd_nonstrict_seal`. **Abgrenzung**: die eingebettete XML ist die EN-16931-USt-Rechnung, NICHT der §105 SGB XI / §302 SGB V Sozialdaten-Austausch.
- **Sozialdaten-Austausch §105 SGB XI / §302 SGB V (Sondierung)**: `docs/research/sgb-datenaustausch-302-105.md` — Entscheidungsvorlage (keine Implementierung), Empfehlung Abrechnungszentrum (z.B. DMRZ), strikt getrennt von der ZUGFeRD-Rechnung.
- **Runbooks**: Mutation-Testing `docs/mutation-testing.md` · Pre-Publish-Backup (Prod) `docs/pre-publish-backup-runbook.md` · Dev-DB-Reseed/Backup `docs/dev-database-runbook.md` · Deployment-Log `docs/deployment-log.md`
- **Configs**: `knip.json` (Dead-Code), `tailwind.config.ts`, `vite.config.ts`
