# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack, mobile-first web application designed to streamline operations for caregivers managing elderly care services. It provides functionalities for scheduling, tracking, and documenting appointments, including digital signatures and real-time data management. The system aims to enhance efficiency for care professionals, offer comprehensive customer management, unify service models, ensure robust data historization for compliance, and adhere to German labor laws. The business vision includes expanding customer management capabilities, unifying service models, and ensuring data integrity for auditing.

## User Preferences
- Preferred communication style: Simple, everyday language
- **Keine Avatare/Profilbilder**: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.
- **Keine Blur-Effekte**: Kein `backdrop-blur`, kein `bg-black/80` oder ähnlich starke Overlay-Verdunkelung. Dialog-/Sheet-/Drawer-Overlays verwenden maximal `bg-black/50` ohne Blur-Filter. Die UI soll klar und technisch scharf bleiben.
- **Keine CSS-Transforms in Overlay-Komponenten**: Dialog, AlertDialog, Sheet und Drawer dürfen KEINE `translate`, `scale`, `zoom` oder `slide` CSS-Transforms verwenden. Diese verursachen Sub-Pixel-Rendering und unscharfen Text. Stattdessen: Flexbox-Zentrierung (`fixed inset-0 flex items-center justify-center`) und reine Fade-Animationen (`fade-in-0`/`fade-out-0`, nur opacity). Drawer: `shouldScaleBackground = false`. Ausnahme: Sheet-Slide-Animationen (`slide-in-from-*`/`slide-out-to-*`) sind erlaubt, da Sheets am Bildschirmrand positioniert sind und keine Sub-Pixel-Probleme verursachen.

## System Architecture

### Frontend
- **Frameworks**: React 19 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme. Centralized `@/design-system` for consistent styling. Touch-optimized UI components.
- **State Management**: TanStack Query for data fetching, React memoization, ErrorBoundary.
- **Date/Time Handling**: All times are implicitly "German local time" with no UTC conversion or timezone logic, using central utilities (`@shared/utils/datetime`).
- **Components**: `DatePicker`, `SearchableSelect`, `StatusBadge` (with 13+ types).
- **API Calls**: Central API client for CSRF protection on state-changing requests.
- **Phone Number Handling**: Uses `libphonenumber-js/min` for validating, formatting, and storing German phone numbers in E.164 format.
- **Type Organization**: Hierarchical type structure (`@shared/schema.ts`, `@shared/domain/*`, `@shared/utils/*`, `@shared/types.ts`).

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, modular routing.
- **Business Logic**: Separated into a dedicated service layer with dependency injection; no direct DB access from route handlers.
- **Error Handling**: Centralized `asyncHandler` wrapper and `AppError` class hierarchy for consistent JSON error responses.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection.
- **Access Model**: Two-tiered access for employees (full vs. legacy based on customer assignment).

### Data Storage
- **Database**: PostgreSQL via Neon serverless with Drizzle ORM.
- **Schema**: Tables for `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, using historization (`valid_from`/`valid_to`). Database indexes defined. All timestamps use `withTimezone: true`.
- **Soft-Delete (GoBD)**: Appointments use `deletedAt` for GoBD compliance.
- **Data Layer**: `IStorage` interface abstraction with `DatabaseStorage` for optimized queries and application-level rollback.
- **Caching**: In-memory cache for assigned customer IDs, sessions, and birthdays with TTL and invalidation logic.
- **Performance**: Combined API endpoints for multi-data pages, scoped auth middleware, single JOIN query for session validation, batch cleanup for expired sessions/tokens.
- **Frontend staleTime-Strategie**: Configurable `staleTime` for data stability (60s for stable, shorter for volatile, `Infinity` for session).

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth in `@shared/domain/*`.
- **Appointment Workflow**: Status-driven field editing rules, overlap checking.
- **Customer Management**: Multi-step creation, detailed views with 5-tab structure (Übersicht, Dokumente, Kontakte, Budgets, Versicherung), German-specific validation (`Pflegegrad`). Customer `status` (`erstberatung`, `aktiv`, `inaktiv`). Customer `billingType` (`pflegekasse_gesetzlich`, `pflegekasse_privat`, `selbstzahler`) drives dynamic step flows, conditional fields, and document requirements.
- **Document Templates**: HTML-based document templates with placeholder system (`{{customer_name}}`, `{{pflegegrad}}`, etc.), billing-type associations (pflicht/optional), and versioning. Templates seeded in DB: Betreuungsvertrag, Dienstleistungsvertrag, Datenschutzvereinbarung, Forderungsabtretung, SEPA-Lastschriftmandat. Template engine renders HTML with customer data. Digital signature capture via canvas in customer creation flow. Templates now support `documentTypeId` linking (to Dokumentenkategorien), `context` (vertragsabschluss/bestandskunde/beide), `targetType` (customer/employee/beide), and dual-signature requirements (`requiresCustomerSignature`, `requiresEmployeeSignature`).
- **PDF Generation**: Server-side HTML→PDF conversion using Puppeteer/Chromium for GoBD-compliant immutable documents. Generated PDFs stored in Object Storage with SHA-256 integrity hashing. Digital document flow: template selection → preview with customer/employee data → dual-signature collection → PDF generation. Available for both customer and employee documents via `DigitalDocumentFlow` component.
- **Insurance Providers**: Admin management, historized assignment, IK-Nummer and Versichertennummer validation.
- **Budgeting & Pricing**: Three-pot budget ledger system based on German care law (§45b, §45a, §39/§42a). Kaskaden-Buchung (cascading allocation), FIFO for §45b, carryover budgets with write-off. Cost estimation with VAT.
- **Dienstleistungskatalog (Service Catalog)**: Central management of services with code, name, unit type, standard price, VAT rate, `isBillable` flag, and `employeeRateCents`. No customer-specific price overrides. `isBillable` controls cost generation. Budget pot assignment via `service_budget_pots`. Customer-specific budget cascade priority in `customer_budget_type_settings`. Dynamic service selection for appointments. System-Services (e.g., `travel_km`, `customer_km`) are non-deletable/editable and seeded on startup.
- **Employee Time Tracking**: Comprehensive tracking for client and non-client work, vacation allowance, multi-day entries. Past entries locked for non-admins.
- **German Labor Law Compliance**: Automatic detection and generation of missing break documentation (`§4 ArbZG`).
- **Month-Closing Workflow**: Employee-initiated month closing locks CRUD operations for non-admins; admins can reopen.
- **Aufgaben-System (Task System)**: Centralized page for system notices and personal tasks.
- **Customer Kilometers**: Separate tracking for kilometers driven with/for the customer.
- **Birthdays**: Integrated tab in Customers page, showing upcoming birthdays for employees and assigned customers, utilizing server-side cache.
- **Employee Self-Service Profile**: Employees can manage contact data, emergency contact, pet acceptance, password, and predefined document uploads.
- **Navigation Structure**: Bottom navigation tabs: Termine, Kunden (with Birthdays tab), Aufgaben, Nachweise, Zeiten. User dropdown includes "Mein Profil" link.
- **Signature Security (3-Tier)**: Immutable `audit_log` table, SHA-256 integrity hashing for appointment and service record signatures with verification endpoint, signature locking with admin-only revoke workflow.
- **Invoicing Module**: Full billing system with `invoices` and `invoice_line_items` tables. Invoice generation from completed appointments with snapshot approach (recipient/insurance data frozen at creation). Three invoice formats per billing type: gesetzlich (to Pflegekasse with IK-Nr.), privat (to customer with insurance reference), selbstzahler (standard invoice). GoBD-compliant Stornorechnung workflow (negative amounts, references original invoice). LBNR (Beschäftigtennummer) on invoices since Oct 2025. PDF generation via Puppeteer/Chromium with HTML templates for Rechnung and Leistungsnachweis. Invoice statuses: Entwurf → Versendet → Bezahlt (with Storniert branch). Sequential invoice numbering per year (RE-YYYY-NNNN).
- **Company Settings**: `company_settings` table for firm master data (name, address, tax, bank, IK-Nummer, §45a Anerkennung). Used on invoice PDFs and Leistungsnachweise. Admin-editable via Settings page.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js/min`.