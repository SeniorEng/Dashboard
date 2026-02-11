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
- **Frameworks**: React 18 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme. Centralized `@/design-system` for consistent styling. Touch-optimized UI components and `text-base` for inputs to prevent iOS Safari zoom.
- **State Management**: TanStack Query for data fetching (optimistic updates, caching), React memoization, ErrorBoundary.
- **Date/Time Handling**: All times are implicitly "German local time" with no UTC conversion or timezone logic. Strict conventions and central utilities (`@shared/utils/datetime`) must be used for all date/time operations.
- **Components**: `DatePicker` for all date fields, `SearchableSelect` for long selection lists.
- **API Calls**: All state-changing API requests use a central API client for CSRF protection.
- **Phone Number Handling**: Uses `libphonenumber-js` for validating, formatting, and storing German phone numbers in E.164 format via `@shared/utils/phone.ts`.
- **Type Organization**: Hierarchical type structure with `@shared/schema.ts`, `@shared/domain/*`, `@shared/utils/*`, and `@shared/types.ts`.

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, modular routing. Admin routes are split into sub-modules.
- **Business Logic**: Separated into a dedicated service layer with dependency injection.
- **Error Handling**: Centralized error codes, German messages, and consistent error formatting.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection, and database indexing.
- **Access Model**: Two-tiered access for employees (full vs. legacy based on customer assignment).

### Data Storage
- **Database**: PostgreSQL via Neon serverless with WebSocket connection pooling (max 10 connections, 30s idle timeout), managed with Drizzle ORM.
- **Schema**: Includes tables for `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, utilizing a historization pattern (`valid_from`/`valid_to`). Database indexes defined in schema for `sessions` (user_id, expires_at), `user_roles` (user_id), and `users` (is_active).
- **Data Layer**: `IStorage` interface abstraction with `DatabaseStorage` for optimized queries, pagination, and application-level rollback. Reusable select-field helpers for appointments/customers to reduce code duplication.
- **Caching**: In-memory cache for assigned customer IDs (TTL, invalidation), session cache (2min TTL), and birthday cache (1h TTL). Cache invalidation is defined for each cache type upon relevant CRUD or assignment changes. Periodic garbage collection (60s interval) prevents memory leaks.
- **Performance**: Combined API endpoints for pages needing multiple independent data sources, reducing HTTP round-trips. Auth middleware scoped to /api routes only. Session validation uses single JOIN query. Batch cleanup for expired sessions/tokens.
- **Frontend staleTime-Strategie**: Stable data uses 60s `staleTime`, volatile data uses shorter values, `Infinity` for session data.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth for business rules in `@shared/domain/*`.
- **Appointment Workflow**: Statuses (`scheduled`, `in-progress`, `documenting`, `completed`). `completed` is required for performance records. Field editing rules based on appointment status. Overlap checking.
- **Service Model**: "Erstberatung" as a core service type.
- **Customer Management**: Multi-step customer creation, detailed views, German-specific validation (e.g., `Pflegegrad` 1-5).
- **Insurance Providers**: Admin management, historized assignment to customers, validation of IK-Nummer and Versichertennummer.
- **Budgeting & Pricing**: Three-pot budget ledger system based on German care law (§45b Entlastungsbetrag, §45a Umwandlungsanspruch, §39/§42a Gemeinsamer Jahresbetrag). Budget types can be prioritized and deactivated per customer, with monthly limits. Kaskaden-Buchung (cascading allocation) distributes invoice amounts across pots. FIFO consumption for §45b. Carryover budgets have write-off for expired allocations. Cost estimation endpoint provides proactive warnings and calculates private payment amounts with VAT.
- **Dienstleistungskatalog (Service Catalog)**: Central management of services with code, name, unit type, standard price, VAT rate, **isBillable** flag, and **employeeRateCents** (compensation rate). All pricing comes from the global catalog — no customer-specific price overrides. The `isBillable` flag controls whether a service generates costs for the customer. Budget pot assignment is via junction table `service_budget_pots` (serviceId, budgetType) for flexible multi-pot assignment. Customer-specific budget cascade priority order is stored in `customer_budget_type_settings`. Dynamic service selection for appointments via `appointment_services` junction table. Documentation flow enriches services with `code` from the services table, then `buildDocumentationUpdate` derives hauswirtschaftMinutes/alltagsbegleitungMinutes by summing actualDurationMinutes per service code. Cost estimation uses `isBillable` and `defaultPriceCents` directly from the catalog. Time-conflict and auto-break calculations use `durationPromised`. PATCH and document endpoints use database transactions for atomic junction table updates. Server-side validation ensures serviceIds exist before documentation. Batch endpoint `GET /api/appointments/batch-services?ids=...` reduces N+1 queries.
- **System-Services**: Services marked with `isSystem: true` cannot be deleted, deactivated, or have their name/code/unit type changed. System services are seeded on startup via `ensureSystemServices()`. Current system services: `travel_km` (Anfahrtskilometer), `customer_km` (Kundenkilometer). Kilometer pricing for budget calculations comes from the catalog via these system services. The employee documentation flow captures km in separate fields (travelKilometers, customerKilometers), but pricing is resolved from the catalog at budget booking time.
- **Employee Time Tracking**: Comprehensive tracking for client and non-client work, including yearly vacation allowance and multi-day entries. Past entries are locked for non-admin users.
- **German Labor Law Compliance**: Automatic detection and generation of missing break documentation (`§4 ArbZG`), which can be globally activated.
- **Month-Closing Workflow**: Employees can close their month, triggering auto-breaks and locking CRUD operations for non-admins. Admins can reopen months.
- **Aufgaben-System (Task System)**: Centralized task page for system notices (open documentations, missing breaks) and personal tasks.
- **Customer Kilometers**: Separate tracking for kilometers driven with/for the customer.
- **Birthdays**: Integrated tab in Customers page, showing upcoming birthdays for employees and assigned customers, utilizing server-side cache.
- **Navigation Structure**: Bottom navigation tabs: Termine, Kunden (with Birthdays tab), Aufgaben, Nachweise, Zeiten.

## Performance
- **Performance-Guide:** Detaillierte Analyse und Optimierungsempfehlungen in `PERFORMANCE_GUIDE.md`
- **Offene Haupt-Themen:** Bundle-Splitting (559 kB Haupt-Chunk), ungenutzte UI-Komponenten (recharts etc.), libphonenumber-js Optimierung, HTTP Cache-Headers, Prefetching
- **Bereits optimiert:** DB Connection Pool (WebSocket), Auth-Scope, N+1 Fixes, Session-JOIN, Indexes, Cache-GC, Route-Level Code Splitting, staleTime-Strategie

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js`.