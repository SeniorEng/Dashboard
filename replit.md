# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack, mobile-first web application designed to streamline operations for caregivers managing elderly care services. It provides functionalities for scheduling, tracking, and documenting appointments, including digital signatures and real-time data management. The system aims to enhance efficiency for care professionals, offer comprehensive customer management, unify service models, ensure robust data historization for compliance, and adhere to German labor laws. The business vision includes expanding customer management capabilities, unifying service models, and ensuring data integrity for auditing.

## User Preferences
- Preferred communication style: Simple, everyday language
- **Keine Avatare/Profilbilder**: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.
- **Keine Blur-Effekte**: Kein `backdrop-blur`, kein `bg-black/80` oder ähnlich starke Overlay-Verdunkelung. Dialog-/Sheet-/Drawer-Overlays verwenden maximal `bg-black/50` ohne Blur-Filter. Die UI soll klar und technisch scharf bleiben.
- **Keine CSS-Transforms in Overlay-Komponenten**: Dialog, AlertDialog, Sheet und Drawer dürfen KEINE `translate`, `scale`, `zoom` oder `slide` CSS-Transforms verwenden. Diese verursachen Sub-Pixel-Rendering und unscharfen Text. Stattdessen: Flexbox-Zentrierung (`fixed inset-0 flex items-center justify-center`) und reine Fade-Animationen (`fade-in-0`/`fade-out-0`, nur opacity). Drawer: `shouldScaleBackground = false`. Ausnahme: Sheet-Slide-Animationen (`slide-in-from-*`/`slide-out-to-*`) sind erlaubt, da Sheets am Bildschirmrand positioniert sind und keine Sub-Pixel-Probleme verursachen.
- **Standard-Unterschrift-Komponente**: Für ALLE Unterschriften im System MUSS die zentrale `SignaturePad`-Komponente (`@/components/ui/signature-pad.tsx`) verwendet werden. KEINE eigenen Signature-Dialoge, Canvas-Implementierungen oder alternative Unterschriftenlösungen bauen. `SignaturePad` bietet eine konsistente Fullscreen-Unterschriftserfahrung mit „Tippen zum Unterschreiben"-Platzhalter, X-Markierung und einheitlichem Styling. Wird verwendet in: Kundenanlage (signatures-step), Leistungsnachweis-Unterschrift, digitaler Dokumentenfluss.

## System Architecture

### Frontend
- **Frameworks**: React 19 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme. Centralized `@/design-system` for consistent styling. Touch-optimized UI components. Layouts use a warm beige gradient background.
- **State Management**: TanStack Query for data fetching.
- **Date/Time Handling**: German local time, no UTC conversion.
- **API Calls**: Central API client (`@/lib/api/client.ts`) for all HTTP requests, including CSRF protection, with `unwrapResult()` for data extraction. Direct `fetch()` calls are forbidden.
- **Feedback**: German toast notifications on success and error for all `useMutation` hooks.
- **Phone Number Handling**: `libphonenumber-js/min` for German numbers in E.164 format.

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, modular routing.
- **Business Logic**: Separated service layer with dependency injection.
- **Error Handling**: Centralized `asyncHandler` and `AppError` for consistent JSON error responses. `extractUserFriendlyDbError()` translates PostgreSQL error codes (22P02, 23505, 23503, 23502, 22003) into German user messages. Every `useMutation` MUST have `onError` with `toast({ title: "Fehler", description: error.message, variant: "destructive" })`. See `.agents/skills/error-handling-audit/SKILL.md` for full conventions.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection (including auth routes), session management, rate limiting (global API + login + password-reset), helmet security headers with Content Security Policy (CSP). Object Storage downloads authorized per-user via DB lookup (`server/middleware/object-storage-auth.ts`): admins unrestricted, employees only own docs + assigned customer docs. Centralized `sanitizeUser()` helper (`server/utils/sanitize-user.ts`) strips `passwordHash` from all API responses; `SafeUser` type exported from schema. Password validation enforces uppercase, lowercase, and digit requirements (Zod-validated on change-password route).
- **Access Model**: Two-tiered access. Non-admin employees see only their own appointments (filtered by `assignedEmployeeId`/`performedByEmployeeId`). Admins see all appointments. This applies to appointment lists, counts, undocumented appointments, and travel suggestions.

### Data Storage
- **Database**: PostgreSQL via Neon serverless with Drizzle ORM.
- **Schema**: Tables include `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, with historization (`valid_from`/`valid_to`) and `withTimezone: true` for all timestamps.
- **Soft-Delete**: `deletedAt` for GoBD compliance. Partial indexes on appointments for `deleted_at IS NULL` queries.
- **Data Layer**: `IStorage` interface abstraction.
- **Caching**: In-memory cache for assigned customer IDs, sessions, and birthdays.
- **Performance**: Combined API endpoints, scoped auth middleware, single JOIN for session validation, batch cleanup. Configurable `staleTime` for frontend data stability.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth.
- **Appointment Workflow**: Status-driven field editing, overlap checking. Completed appointments can be reopened to `documenting` via `POST /api/appointments/:id/reopen` for documentation correction — reverses budget transactions (atomically in a DB transaction), clears signature, preserves all other documentation data. Blocked by Leistungsnachweis lock or month-closing (admin bypass). Frontend: "Dokumentation korrigieren" button on detail page for completed+unlocked appointments, with confirmation dialog.
- **Customer Management**: Multi-step creation with localStorage draft auto-save (key: `careconnect_customer_draft`, 24h expiry, debounced 500ms). Detailed views with 6 tabs (Übersicht, Vertrag, Dokumente, Kontakte, Budgets, Versicherung). German-specific validation (`Pflegegrad`) with historization. Deactivation tracking with predefined reasons. Inline editing of customer fields (address, phone, email, Pflegegrad, pet info, medical history, agreed services) directly within tabs, with all changes logged via `auditService`. DSGVO Art. 17 customer anonymization (`POST /admin/customers/:id/anonymize`). Erstberatungs-Kunden: Decision flow after appointment completion (convert to active customer or decline with "Kein Interesse"), decline endpoint (`POST /admin/customers/:id/decline-erstberatung`) atomically deactivates customer and updates linked prospect.
- **Document Templates**: HTML-based templates with placeholders (`{{input:Feldname}}`, company placeholders) supporting fragments or full HTML documents, billing-type associations, and versioning. Supports `documentTypeId`, `context`, `targetType`, and dual signatures. Digital document flow: select template → fill inputs → preview → sign → generate PDF.
- **PDF Generation**: Server-side HTML→PDF using Puppeteer/Chromium for GoBD-compliant documents. Digital signature capture, integrity hashing, and visible audit stamps including IP, location, and hash.
- **Insurance Providers**: Admin management, historized assignment, IK-Nummer validation.
- **Budgeting & Pricing**: Three-pot budget ledger system based on German care law, cascading allocation, FIFO for §45b, carryover budgets. Budget mutations (manual adjustments, reversals, type settings, preferences, initial setup) are fully audit-logged for GoBD compliance. Concurrent budget consumption is serialized per customer via `pg_advisory_xact_lock` to prevent race conditions.
- **Service Catalog**: Central management of services with code, name, unit type, price, VAT, `isBillable` flag, `employeeRateCents`.
- **Employee Time Tracking**: Comprehensive tracking for client/non-client work, vacation. Past entries locked for non-admins. German labor law compliance (e.g., missing break documentation with "Nachtragen" CTA). TimeEntryDialog uses Drawer on mobile, Dialog on desktop. CalendarGrid uses memoized DayCell for render performance. All non-full-day entry types (Büroarbeit, Vertrieb, Schulung, Besprechung, Sonstiges) support optional kilometer tracking for business travel. Km are shown in day detail panel and included in monthly km summary as "Sonstige Fahrten".
- **Month-Closing Workflow**: Employee-initiated month closing locks CRUD operations.
- **Task System**: Centralized page for system notices and personal tasks.
- **In-App Notifications**: `notifications` table with events: `customer_assigned`, `appointment_created`, `task_assigned`. Fire-and-forget creation via `notificationService`. Frontend: `NotificationList` component on Aufgaben page, `useUnreadCount` hook with 60s polling, badge in navigation, one-time startup toast per session. Routes: `GET /api/notifications`, `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id/read`, `POST /api/notifications/mark-all-read`. Notifications only for actions done by others (no self-notifications).
- **Customer Kilometers**: Separate tracking for travel with/for the customer.
- **Birthdays**: Integrated tab showing upcoming birthdays.
- **Employee Self-Service Profile**: Employees manage contact data, emergency contact, pet acceptance, password, and document uploads.
- **Document Type System**: `document_types` table defines document types with `context`, `targetType`, `reviewIntervalMonths`, and optional linkage to `document_template`.
- **Customer Documents**: Document-type-centric UI for existing documents. "Hinzufügen" allows digital creation via template or upload. Customer creation wizard (`signatures-step.tsx`) handles template-based and upload-only documents. Wizard signatures step includes document preview: each document card has a "Vorschau" button that renders the template with all wizard form data (via `POST /admin/document-templates/render-preview`) so the customer can review the filled-in document before signing.
- **Employee Document Upload**: Employees can upload and view customer documents (PDF, images, Word) from the customer detail page.
- **Navigation Structure**: Bottom navigation tabs: Termine, Kunden, Aufgaben, Nachweise, Zeiten. User dropdown for "Mein Profil".
- **Invoicing Module**: Full billing system with audit-safe data flow requiring signed Leistungsnachweis. Snapshot approach, three invoice formats per billing type, GoBD-compliant Stornorechnung, sequential numbering, Nachberechnung.
- **Company Settings**: `company_settings` table for master data, editable via Admin Settings, including a two-logo system (`logoUrl`, `pdfLogoUrl`).
- **Document Delivery Preference**: `documentDeliveryMethod` field on customers for email or post.
- **Hours Overview (Stundenübersicht)**: Admin page for monthly employee summaries (hours by category, kilometers, vacation, sick days), including holiday hours calculation for Minijobbers and Minijob-Stundenübertrag (carryover for Minijobbers).
- **Public Holidays**: Shared utility for German public holidays.
- **Employee Clustering**: Dimensions for `isEuRentner`, `employmentType`, `weeklyWorkDays`, `monthlyWorkHours` for vacation entitlement and warnings for EU-Rentner hour limits.
- **Employee Availability (Verfügbarkeit)**: Employees can log availability slots (type `verfuegbar`) in the Zeiten tab — these are organizational only and do NOT count as work hours. No kilometer field for verfuegbar entries. Admins see employee availability in the Erstberatung form via `GET /api/admin/employees/availability?date=YYYY-MM-DD`. CalendarGrid shows green dots for availability days. DayDetailPanel separates availability from work entries.
- **Admin Time Tracking with Appointments**: Admin Zeiterfassung (`/admin/time-entries`) shows both manual time entries AND employee appointments in a unified chronological timeline per employee card. Appointments fetched via `GET /api/admin/employee-appointments?year=Y&month=M&userId=ID`. Uses single DB query (`getAllAppointmentsInRange`) for all employees, or per-employee query when filtered. Grouped by employeeId (not displayName) to avoid name collisions. Shows appointment status badges (Geplant, Abgeschlossen, Dokumentiert, etc.), customer name, service type, and travel km.
- **Prospect/Lead Management (Interessenten)**: Pre-customer pipeline with statuses (neu, kontaktiert, wiedervorlage, nicht_interessiert, absage, erstberatung, gewonnen), email webhook ingestion, activity timeline, and conversion to Erstberatung.
- **Erstberatung Merge**: Erstberatungskunden can be merged with existing active customers via `POST /api/admin/customers/:id/merge-erstberatung`. Sets source to inaktiv with reason `zusammengefuehrt`, stores `mergedIntoCustomerId` reference, updates linked prospect to `gewonnen`. Green banner with link to target customer shown on merged customer detail page. Audit-logged.
- **Planning Overview (Planungsübersicht)**: "Planung" tab in Statistics page (`/admin/statistics`). Forward-looking view of all non-cancelled appointments (scheduled + completed + documented) per employee with expected revenue, costs, and Deckungsbeitrag. Also shows active customers without any appointments in the selected period. Endpoint: `GET /api/statistics/planning?year=YYYY&month=M`. Uses `appointment_services` JOIN `services` for revenue/cost calculation (same as profitability). Uses `assignedEmployeeId` instead of `performedByEmployeeId` for unfinished appointments.
- **Statistics Revenue Calculation**: Both profitability (`GET /api/statistics/profitability`) and planning endpoints use `appointment_services` JOIN `services` (with `unit_type='hours'`) for service revenue/cost calculation. Per-service-line: `COALESCE(actual_duration_minutes, planned_duration_minutes)` × hourly price/cost. Customer-specific pricing via `customer_service_prices`, fallback to `services.default_price_cents`. KM revenue/cost calculated at appointment level using `travel_km`/`customer_km` fields. Legacy `service_type` field is no longer used for revenue calculation.

### Build & Deployment
- **Build Script**: `script/build.ts` — esbuild for server (CJS bundle), Vite for client. Uses an allowlist to bundle specific packages (express, zod, etc.) for faster cold starts; unlisted dependencies are external. IMPORTANT: `drizzle-orm`, `drizzle-zod`, `@neondatabase/serverless`, and `ws` must NOT be bundled — bundling drizzle-orm breaks SQL template fragment composition with nested parameters.
- **Build Verification**: `script/check-build.mjs` — validates that `dist/` matches source code using **content-based hashing** (NOT file modification times). Both build.ts and check-build.mjs must use identical hashing logic. Critical: mtime-based hashing breaks in deployment environments where file timestamps differ.
- **Deployment Config**: `.replit` `[deployment]` section — `build` runs `npm run build`, `run` executes check-build then starts `dist/index.cjs`.

### Audit Status
- **Last Full Audit**: 8-agent team audit completed with 0 FAIL, all WARN items resolved
- **TypeScript**: 0 errors (fixed: audit action types, DayTimeEntry.kilometers, AppointmentWithCustomerName fields, isLocked type, documentDate mutation type, Set iteration, asyncHandler signature)
- **Build**: Clean (535.8 KB gzipped, 105 chunks, code-split)
- **npm audit**: 0 critical/high/moderate vulns (4 moderate esbuild in dev-only drizzle-kit — not fixable without breaking change)
- **Responsive grids**: All grid-cols-3/4 have sm: responsive fallbacks
- **Error handling**: All useMutation hooks have onError with German toast
- **N+1 fixed**: upsertBudgetTypeSettings uses batch insert in transaction
- **Dead code removed**: Duplicate BillingType/BILLING_TYPES from shared/schema/billing.ts

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js/min`, Puppeteer (for PDF generation).
- **Monitoring**: `GET /api/health` endpoint (unauthenticated) for load balancer health checks, returns DB connectivity status.