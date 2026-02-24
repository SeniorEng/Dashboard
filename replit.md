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
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme. Centralized `@/design-system` for consistent styling. Touch-optimized UI components.
- **Layout Conventions**: Unified page background using a warm beige gradient. Layout component offers variants (`default`, `admin`, `wide`, `narrow`, `full`). Consistent page titles and card styles. Login/public pages use custom gradients.
- **State Management**: TanStack Query for data fetching, React memoization, ErrorBoundary.
- **Date/Time Handling**: German local time, no UTC conversion.
- **API Calls**: Central API client (`@/lib/api/client.ts`) for ALL HTTP requests, including CSRF protection. Every frontend file uses `api.get/post/put/patch/delete` with `unwrapResult()` for data extraction. Direct `fetch()` calls are forbidden.
- **Toast Feedback**: All `useMutation` hooks provide German toast notifications on success and error via `useToast()`.
- **Phone Number Handling**: `libphonenumber-js/min` for German numbers in E.164 format.
- **Type Organization**: Hierarchical type structure.

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, modular routing.
- **Business Logic**: Separated service layer with dependency injection.
- **Error Handling**: Centralized `asyncHandler` and `AppError` for consistent JSON error responses.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection. Session management with idle/absolute timeouts and keepalive.
- **Access Model**: Two-tiered access for employees.

### Data Storage
- **Database**: PostgreSQL via Neon serverless with Drizzle ORM.
- **Schema**: Tables for `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, with historization (`valid_from`/`valid_to`). All timestamps use `withTimezone: true`.
- **Soft-Delete**: `deletedAt` for GoBD compliance.
- **Data Layer**: `IStorage` interface abstraction.
- **Caching**: In-memory cache for assigned customer IDs, sessions, and birthdays.
- **Performance**: Combined API endpoints, scoped auth middleware, single JOIN for session validation, batch cleanup.
- **StaleTime Strategy**: Configurable `staleTime` for frontend data stability.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth.
- **Appointment Workflow**: Status-driven field editing, overlap checking.
- **Customer Management**: Multi-step creation, detailed views with 6 tabs (Übersicht, Vertrag, Dokumente, Kontakte, Budgets, Versicherung), German-specific validation (`Pflegegrad`). `status` and `billingType` drive dynamic flows. Deactivation tracking with predefined reasons. Inline editing directly in tabs (no separate edit page). All DB fields always displayed with fallbacks ("Nicht angegeben", "Kein Festnetz", etc.).
- **Document Templates**: HTML-based templates with placeholders, billing-type associations, and versioning. Supports `documentTypeId`, `context`, `targetType`, and dual signatures. `{{input:Feldname}}` syntax for interactive form fields filled by employees on-site. `extractInputPlaceholders()` in template engine. Employee digital document flow: select template → fill inputs → preview → sign → generate PDF. Component: `client/src/features/customers/components/digital-document-flow.tsx`. Employee endpoints: `GET /api/customers/:id/document-templates`, `POST .../render`, `POST .../generate-pdf`, `GET /api/customers/generated-documents/:docId/download`. **Full HTML Documents**: Templates can be either HTML fragments (wrapped in default print styles) or complete HTML documents (`<!DOCTYPE html>...`). Full docs are detected automatically and rendered without re-wrapping, with zero PDF margins so the template controls its own layout. DOMPurify allows `<style>` tags for styled previews. **Company Placeholders**: `{{company_name}}`, `{{company_logo}}` (img tag), `{{company_logo_url}}` (URL only), `{{company_address}}`, `{{company_telefon}}`, `{{company_email}}`, `{{company_ik_nummer}}`, `{{company_steuernummer}}`, etc. — all populated from `company_settings`. Logo uploaded in Admin Settings.
- **PDF Generation**: Server-side HTML→PDF using Puppeteer/Chromium for GoBD-compliant documents. Digital signature capture and integrity hashing.
- **Insurance Providers**: Admin management, historized assignment, IK-Nummer validation.
- **Budgeting & Pricing**: Three-pot budget ledger system based on German care law, cascading allocation, FIFO for §45b, carryover budgets.
- **Service Catalog**: Central management of services with code, name, unit type, price, VAT, `isBillable` flag, `employeeRateCents`. System services are non-editable.
- **Employee Time Tracking**: Comprehensive tracking for client/non-client work, vacation. Past entries locked for non-admins.
- **German Labor Law Compliance**: Automatic detection of missing break documentation (`§4 ArbZG`).
- **Month-Closing Workflow**: Employee-initiated month closing locks CRUD operations.
- **Task System**: Centralized page for system notices and personal tasks.
- **Customer Kilometers**: Separate tracking for travel with/for the customer.
- **Birthdays**: Integrated tab showing upcoming birthdays.
- **Employee Self-Service Profile**: Employees manage contact data, emergency contact, pet acceptance, password, and document uploads.
- **Document Type System**: Document types (`document_types` table) are the central unit for all customer/employee documents. Each type has `context` (`vertragsabschluss`/`bestandskunde`/`beide`), `targetType` (`customer`/`employee`), `reviewIntervalMonths`, and optional linkage to a `document_template` (via `documentTypeId` FK on templates). `getDocumentTypesWithTemplateInfo()` enriches types with `hasTemplate`, `templateName`, `templateSlug`. If a template is linked → "Digital erstellen" is the primary action; upload is always available as fallback. Admin UI (`/admin/document-types`) shows template linkage badges.
- **Customer Documents (Bestandskunde)**: Document-type-centric UI in `customer-documents-section.tsx`. Shows only **existing** documents grouped by type. "Hinzufügen" button opens bottom Sheet for type selection → then "Digital erstellen" (if template linked) or "Hochladen". Empty state with prompt. Orphaned generated docs shown separately.
- **Customer Creation Wizard — Documents**: `signatures-step.tsx` shows both template-based documents (from billing-type association) and upload-only document types (from `vertragsabschluss`/`beide` context). For template docs: digital signature is primary, upload is fallback ("Stattdessen hochladen"). For upload-only doc types: file upload with camera support. `WizardUploadedDoc` type tracks uploads (`documentTypeId`, `fileName`, `objectPath`). On customer creation, uploaded docs are saved via `POST /customers/:id/documents`. Signing a document clears any upload for the same type and vice versa.
- **Employee Document Upload**: Employees can upload and view customer documents (PDF, images, Word) directly from the customer detail page. Auto-seeded document types: Schlüsselübergabeprotokoll, Vollmacht, Einwilligungserklärung, Sonstiges Dokument, Ärztliche Verordnung, Pflegegradbescheid. Employee API endpoints at `/api/customers/:id/documents` with access-scoped to assigned customers.
- **Navigation Structure**: Bottom navigation tabs: Termine, Kunden, Aufgaben, Nachweise, Zeiten. User dropdown for "Mein Profil".
- **Signature Security**: 3-tier system with immutable audit log, SHA-256 integrity hashing, and locking with admin-only revoke.
- **Invoicing Module**: Full billing system with audit-safe data flow requiring signed Leistungsnachweis. Snapshot approach for data. Three invoice formats per billing type. GoBD-compliant Stornorechnung workflow. Sequential numbering, Nachberechnung.
- **Company Settings**: `company_settings` table for master data, editable via Admin Settings. Two-logo system: `logoUrl` (quadratisches App-Logo für Header/Favicon) + `pdfLogoUrl` (Dokumenten-Logo für PDFs, Login-Screen). Public endpoint `GET /api/public/branding` liefert Logos ohne Auth. Template engine nutzt `pdfLogoUrl` mit Fallback auf `logoUrl` für `{{company_logo}}`.
- **Document Delivery Preference**: `documentDeliveryMethod` field on customers for email or post, used in customer creation and editing.
- **Hours Overview**: Admin page for monthly employee summaries: hours by category, kilometers, vacation, sick days.
- **Public Holidays**: Shared utility for German public holidays (bundeseinheitlich + Sachsen).
- **Employee Clustering**: Dimensions for `isEuRentner`, `employmentType`, `weeklyWorkDays`, `monthlyWorkHours`. Vacation entitlement formula. Warnings for EU-Rentner hour limits.
- **Prospect/Lead Management (Interessenten)**: Pre-customer pipeline with statuses: `neu`, `kontaktiert`, `wiedervorlage`, `nicht_interessiert`, `absage`, `erstberatung`. Email webhook ingestion (`POST /api/webhook/email-lead` with `x-webhook-secret` header) auto-parses lead data from partner websites. Activity timeline with notes (Anruf, E-Mail, Notiz, Statuswechsel). Conversion to Erstberatung pre-fills appointment form. Tables: `prospects`, `prospect_notes`. Admin route: `/admin/prospects`.
- **Hours Overview (Stundenübersicht)**: Monthly employee summary with columns: HW, AB, EB (Erstberatung), Sonstiges, Feiertage, KM, Urlaub, Krank. Holiday hours: Minijobber 2,5h nur Mo/Di, SV-pflichtig `monthlyWorkHours / 21,7` pro Werktags-Feiertag. **Minijob-Stundenübertrag**: For Minijobber, additional columns show Brutto(€), Übertrag Vormonat(€), Auszahlbar(€), Übertrag neu(€). Carryover tracked in cents, cumulative from January. Configurable `minijobEarningsLimitCents` in company_settings (default 556€). Uses weighted gross from HW×HW-Satz + AB×AB-Satz + EB×AB-Satz + Sonstiges×HW-Satz + Feiertage×HW-Satz. Batch query for all months in one DB call for performance.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js/min`, Puppeteer (for PDF generation).