# CareConnect
Streamlines elderly care service management for caregivers, enhancing efficiency and data integrity.

## Run & Operate
- **Run Dev**: `npm run dev` (client & server)
- **Run Server**: `npm run start` (server only)
- **Build**: `npm run build`
- **Typecheck**: `npm run check`
- **DB Push**: `drizzle-kit push:pg`
- **Required Env Vars**: `DATABASE_URL`, `ENCRYPTION_KEY` (64-char hex), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `QONTO_SECRET_KEY`, `QONTO_LOGIN`, `LETTEREXPRESS_API_KEY`, `NODE_ENV`. (WhatsApp läuft ebenfalls über die Twilio-Credentials; Meta-Cloud-API-Token werden nicht mehr benötigt.)

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
- **Theme/Design System**: `client/src/design-system/`, `client/src/index.css`
- **Component Library**: `client/src/components/ui/`
- **Server Routes**: `server/routes/` (modular, e.g., `server/routes/admin/customers/`)
- **DB Storage Layer**: `server/storage/`
- **Startup Migrations**: `server/startup/`
- **Tests**: `tests/` (Vitest)
- **Deployment Config**: `.replit`

## Architecture decisions
- **Mobile-First & Accessibility**: Responsive design with `shadcn/ui` (Radix UI primitives), touch-optimized. UI components use `fixed inset-0 flex items-center justify-center` for dialogs/overlays for sharp text rendering.
- **Strict Data Consistency**: Centralized TanStack Query invalidation via `invalidateRelated()` (`@/lib/query-invalidation`) to maintain cross-domain consistency. All mutation `onSuccess` handlers must use this helper instead of calling `queryClient.invalidateQueries()` directly. Legitimate exceptions (e.g. record-id-scoped keys not covered by a domain) must be marked with a `// invalidate-direct-allowed: <reason>` comment on the line above. The discipline is enforced by `tests/query-invalidation-discipline.test.ts`.
- **GoBD Compliance**: Extensive use of soft-deletes, historization, audit logging for all critical operations (budget mutations, customer changes), server-side PDF generation with integrity hashing.
- **Centralized Logic**: Key functionalities like phone/address formatting, error handling, logging, and access control are centralized in shared utilities or middleware for consistency and maintainability.
- **Budgeting System**: Three-pot budget ledger with cascading allocation, FIFO for §45b, and a virtual auto-renewal model for §45b to avoid materializing monthly allocations as DB rows. Concurrent budget consumption is serialized.
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
- **Test Data Hygiene**: Test cleanup scripts exist but require careful execution (e.g., `--apply` flag, hostname guard). Do not run cleanup scripts directly on production.
- **Legacy Schema Fields**: Several fields and tables are marked as "legacy" but are still actively used for migration paths or specific functionalities. Do not remove them without thorough dependency checks.
- **WhatsApp-Provider = Twilio**: Versand erfolgt ausschließlich über die Twilio WhatsApp Content API (`twilio` SDK, `client.messages.create({ contentSid, contentVariables })`). Die `templateName`-Spalte in `whatsapp_notification_rules` enthält Twilio Content SIDs (`HX…`), nicht mehr Meta-Template-Namen. Die DB-Spalten `whatsapp_phone_number_id` und `whatsapp_business_account_id` sind veraltet (durch Startup-Migration auf NULL gesetzt) und werden nicht mehr gelesen — bleiben aber zur Vermeidung destruktiver Drizzle-Push-Warnungen erhalten. `whatsapp_access_token` dient jetzt als optionaler Override für `TWILIO_AUTH_TOKEN`.

## Pointers
- **Audit Methodology**: `.agents/skills/deep-analysis/SKILL.md`
- **Error Handling Conventions**: `.agents/skills/error-handling-audit/SKILL.md`
- **Page-Size Guideline**: `docs/page-size-guideline.md` (≤500 LOC soft, 800 LOC hard limit; pages are thin wrappers, domain code lives in `client/src/features/<domain>/`)
- **Pre-Publish Backup Runbook**: `docs/pre-publish-backup-runbook.md`
- **Test Coverage Matrix**: `tests/README.md`
- **Drift-Detektoren "Anzeige vs. Buchung"** (Task #427): `tests/helpers/equality-check.ts` plus `tests/equality/*` (5 Hotspots: §45b-Cap, Pflegegrad-Preise, Reisekosten, Pro-Rata-Urlaub, Monatsabschluss-Cutoff) und `tests/architecture/calculations-in-shared.test.ts` (verhindert neue `calculate*`/`compute*`-Funktionen außerhalb `shared/domain/`).
- **E2E Edit-Persistence Smoke-Suite**: `e2e/smoke/edit-persistence.spec.ts` (Playwright, `npm run test:e2e:smoke`). Jedes neue Bearbeitungsformular braucht einen Round-Trip-Test über `expectFieldPersisted` (`e2e/helpers/round-trip.ts`). Pflicht: nach dem Save vollständiger `page.reload()`, sonst wird nur Frontend-State getestet.
- **Deployment Log**: `docs/deployment-log.md`
- **Knip Configuration**: `knip.json` (for dead code detection)
- **Tailwind Config**: `tailwind.config.ts`
- **Vite Config**: `vite.config.ts`