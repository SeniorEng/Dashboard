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
- **Error Handling**: Centralized `asyncHandler` and `AppError` for consistent JSON error responses.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection (including auth routes), session management, rate limiting (global API + login + password-reset), helmet security headers. Object Storage downloads authorized per-user via DB lookup (`server/middleware/object-storage-auth.ts`): admins unrestricted, employees only own docs + assigned customer docs.
- **Access Model**: Two-tiered access for employees.

### Data Storage
- **Database**: PostgreSQL via Neon serverless with Drizzle ORM.
- **Schema**: Tables include `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, with historization (`valid_from`/`valid_to`) and `withTimezone: true` for all timestamps.
- **Soft-Delete**: `deletedAt` for GoBD compliance. Partial indexes on appointments for `deleted_at IS NULL` queries.
- **Data Layer**: `IStorage` interface abstraction.
- **Caching**: In-memory cache for assigned customer IDs, sessions, and birthdays.
- **Performance**: Combined API endpoints, scoped auth middleware, single JOIN for session validation, batch cleanup. Configurable `staleTime` for frontend data stability.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth.
- **Appointment Workflow**: Status-driven field editing, overlap checking.
- **Customer Management**: Multi-step creation, detailed views with 6 tabs (Übersicht, Vertrag, Dokumente, Kontakte, Budgets, Versicherung). German-specific validation (`Pflegegrad`) with historization. Deactivation tracking with predefined reasons. Inline editing of customer fields (address, phone, email, Pflegegrad, pet info, medical history, agreed services) directly within tabs, with all changes logged via `auditService`. DSGVO Art. 17 customer anonymization (`POST /admin/customers/:id/anonymize`). Erstberatungs-Kunden: Decision flow after appointment completion (convert to active customer or decline with "Kein Interesse"), decline endpoint (`POST /admin/customers/:id/decline-erstberatung`) atomically deactivates customer and updates linked prospect.
- **Document Templates**: HTML-based templates with placeholders (`{{input:Feldname}}`, company placeholders) supporting fragments or full HTML documents, billing-type associations, and versioning. Supports `documentTypeId`, `context`, `targetType`, and dual signatures. Digital document flow: select template → fill inputs → preview → sign → generate PDF.
- **PDF Generation**: Server-side HTML→PDF using Puppeteer/Chromium for GoBD-compliant documents. Digital signature capture, integrity hashing, and visible audit stamps including IP, location, and hash.
- **Insurance Providers**: Admin management, historized assignment, IK-Nummer validation.
- **Budgeting & Pricing**: Three-pot budget ledger system based on German care law, cascading allocation, FIFO for §45b, carryover budgets. Budget mutations (manual adjustments, reversals, type settings, preferences, initial setup) are fully audit-logged for GoBD compliance. Concurrent budget consumption is serialized per customer via `pg_advisory_xact_lock` to prevent race conditions.
- **Service Catalog**: Central management of services with code, name, unit type, price, VAT, `isBillable` flag, `employeeRateCents`.
- **Employee Time Tracking**: Comprehensive tracking for client/non-client work, vacation. Past entries locked for non-admins. German labor law compliance (e.g., missing break documentation).
- **Month-Closing Workflow**: Employee-initiated month closing locks CRUD operations.
- **Task System**: Centralized page for system notices and personal tasks.
- **Customer Kilometers**: Separate tracking for travel with/for the customer.
- **Birthdays**: Integrated tab showing upcoming birthdays.
- **Employee Self-Service Profile**: Employees manage contact data, emergency contact, pet acceptance, password, and document uploads.
- **Document Type System**: `document_types` table defines document types with `context`, `targetType`, `reviewIntervalMonths`, and optional linkage to `document_template`.
- **Customer Documents**: Document-type-centric UI for existing documents. "Hinzufügen" allows digital creation via template or upload. Customer creation wizard (`signatures-step.tsx`) handles template-based and upload-only documents.
- **Employee Document Upload**: Employees can upload and view customer documents (PDF, images, Word) from the customer detail page.
- **Navigation Structure**: Bottom navigation tabs: Termine, Kunden, Aufgaben, Nachweise, Zeiten. User dropdown for "Mein Profil".
- **Invoicing Module**: Full billing system with audit-safe data flow requiring signed Leistungsnachweis. Snapshot approach, three invoice formats per billing type, GoBD-compliant Stornorechnung, sequential numbering, Nachberechnung.
- **Company Settings**: `company_settings` table for master data, editable via Admin Settings, including a two-logo system (`logoUrl`, `pdfLogoUrl`).
- **Document Delivery Preference**: `documentDeliveryMethod` field on customers for email or post.
- **Hours Overview (Stundenübersicht)**: Admin page for monthly employee summaries (hours by category, kilometers, vacation, sick days), including holiday hours calculation for Minijobbers and Minijob-Stundenübertrag (carryover for Minijobbers).
- **Public Holidays**: Shared utility for German public holidays.
- **Employee Clustering**: Dimensions for `isEuRentner`, `employmentType`, `weeklyWorkDays`, `monthlyWorkHours` for vacation entitlement and warnings for EU-Rentner hour limits.
- **Prospect/Lead Management (Interessenten)**: Pre-customer pipeline with statuses, email webhook ingestion, activity timeline, and conversion to Erstberatung.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js/min`, Puppeteer (for PDF generation).
- **Monitoring**: `GET /api/health` endpoint (unauthenticated) for load balancer health checks, returns DB connectivity status.