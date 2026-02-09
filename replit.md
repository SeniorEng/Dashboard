# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack, mobile-first web application designed to streamline operations for caregivers managing elderly care services. It provides functionalities for scheduling, tracking, and documenting appointments, including digital signatures and real-time data management. The system aims to enhance efficiency for care professionals with features like comprehensive customer management, unified service models, robust data historization for compliance, and adherence to German labor laws. The business vision includes expanding customer management capabilities, unifying service models, and ensuring data integrity for auditing.

## User Preferences
- Preferred communication style: Simple, everyday language
- **Keine Avatare/Profilbilder**: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.

## System Architecture

### Frontend
- **Frameworks**: React 18 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme (teal and warm beige). Centralized `@/design-system` for consistent styling.
- **State Management**: TanStack Query for data fetching (optimistic updates, caching), React memoization, ErrorBoundary for error handling.
- **Date/Time Handling**: All times are implicitly "German local time" with no UTC conversion or timezone logic. Storage formats are `"YYYY-MM-DD"` for dates, `"HH:MM:SS"` for time, `integer` for duration, and `timestamptz` for system timestamps. Display formats are `"HH:MM"` for time and `"DD.MM.YYYY"` or `"YYYY-MM-DD"` for dates. Strict conventions and central utilities (`@shared/utils/datetime`) must be used for all date/time operations.
- **Mobile-Kompatibilität**: Touch-optimized UI components (min 44x44px touch areas), `text-base` for inputs to prevent iOS Safari zoom, dialogs appearing as bottom-sheets on mobile, and `maximum-scale=1` for viewport.
- **Components**: `DatePicker` for all date fields, `SearchableSelect` for long selection lists (e.g., customers), and a unified `flex flex-col gap-3` pattern for card lists.
- **API Calls**: All state-changing API requests must use the central API client (`client/src/lib/api/client.ts`) for CSRF protection.
- **Phone Number Handling**: Uses `libphonenumber-js` for validating, formatting, and storing German phone numbers in E.164 format.
- **Type Organization**: Hierarchical type structure with `@shared/schema.ts`, `@shared/domain/*`, `@shared/utils/*`, and `@shared/types.ts`.
- **Phone Number Validation**: Single source of truth in `@shared/utils/phone.ts` using `libphonenumber-js`. All phone validation/formatting must use this utility — no local reimplementations.
- **Admin Component Structure**: Large admin pages are split into sub-components under `client/src/pages/admin/components/` (e.g., `user-form.tsx`, `personal-data-step.tsx`, `customer-overview-tab.tsx`). Type definitions in `*-types.ts` files.

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, and modular routing.
- **Business Logic**: Separated into a dedicated service layer with dependency injection.
- **Error Handling**: Centralized error codes, German messages, and consistent error formatting.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection (including on `/api/auth/change-password`), and database indexing.
- **Sanfter Entzug (Soft Revocation)**: Two-tiered access model for employees (full vs. legacy access based on customer assignment).

### Data Storage
- **Database**: PostgreSQL via Neon serverless, managed with Drizzle ORM.
- **Schema**: Includes tables for `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, utilizing a historization pattern (`valid_from`/`valid_to`).
- **Data Types**: Strict SQL types for data integrity.
- **Indexes**: Composite indexes on frequently queried columns.
- **Data Layer**: `IStorage` interface abstraction with `DatabaseStorage` providing optimized queries, pagination, and application-level rollback.
- **Caching**: In-memory cache for assigned customer IDs with TTL and invalidation.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth for business rules in `@shared/domain/*`.
- **Appointment Statuses**: `scheduled`, `in-progress`, `documenting`, `completed`. Only `completed` appointments are considered documented for performance records.
- **Performance Record Workflow**: Appointments must be `completed` before a performance record can be created. Includes employee and customer signature steps.
- **Field Editing**: Rules based on appointment status.
- **Overlap Checking**: Prevents appointment overlaps.
- **Service Model**: "Erstberatung" (initial consultation) as a core service type.
- **Customer Management**: Multi-step customer creation, detailed views, German-specific validation. Pflegegrad ist immer 1–5 (kein "0" oder "Ohne Pflegegrad") — wird in UI und Backend (Zod) einheitlich erzwungen.
- **Budgeting & Pricing**: Three-pot budget ledger system per German care law (PUEG 2025):
  - **§45b Entlastungsbetrag**: 131€/Monat max (admin-setzbar ≤131€), ansparbar mit Übertrag bis 30.06. des Folgejahres. Vollständiges Ledger mit auto-allocation, consumption tracking, initial balance, carryover.
  - **§45a Umwandlungsanspruch**: Monatlich verfügbar, KEIN Anspareffekt (verfällt am Monatsende). Max abhängig vom Pflegegrad (PG2: 318€, PG3: 599€, PG4: 744€, PG5: 920€). PG1 nicht berechtigt. System validiert Obergrenze.
  - **§39/§42a Gemeinsamer Jahresbetrag**: 3.539€/Jahr, sukzessiv verbrauchbar. Jährliche auto-allocation mit Startwert durch Admin.
  - Shared tables `budget_allocations` + `budget_transactions` mit `budgetType` Diskriminator und `allocationId` FK für FIFO-Tracking. Lazy auto-allocation (idempotent via unique index + ON CONFLICT DO NOTHING). Zentrale Validierungskonstanten in `@shared/domain/budgets.ts`.
  - **Kaskaden-Buchung**: Rechnungen werden automatisch auf Töpfe verteilt: Prio 1 = §45a, Prio 2 = §45b. Admin-`monthlyLimitCents` greift als harte Obergrenze pro Monat für §45b. Restbetrag wird als `outstandingCents` ausgewiesen.
  - **FIFO-Verbrauch**: §45b verbraucht älteste Allocations zuerst (sortiert nach `validFrom ASC`). Jede Consumption-Transaktion referenziert die Quell-Allocation via `allocationId`.
  - **Carryover-Verfall**: Abgelaufene Übertrags-Allocations (`source=carryover`, `expiresAt < today`) werden lazy mit `write_off`-Transaktionen abgeschrieben (idempotent via `allocationId`-Check).
  - Cost estimation endpoint provides proactive warnings during appointment creation. Requires valid pricing for appointment completion.
  - Employee-facing customer detail shows all 3 budget pots with progress bars via `/api/budget/:customerId/overview`.
- **Employee Time Tracking**: Comprehensive tracking for client and non-client work, including yearly vacation allowance and multi-day entries. Past entries are locked for non-admin users.
- **German Labor Law Compliance**: Automatic detection of missing break documentation based on work hours (`§4 ArbZG`).
- **Auto-Break System**: Calculates and generates missing breaks according to `§4 ArbZG`, considering actual work time, and is idempotent. Globally activatable via system settings.
- **Month-Closing Workflow**: Employees can close their month, generating auto-breaks. This locks CRUD operations for non-admins. Admins can reopen months.
- **Aufgaben-System**: Zentrale Aufgaben-Seite (`/tasks`) vereint System-Hinweise (offene Dokumentationen, fehlende Pausen, Leistungsnachweise) und eigene Aufgaben. Navigation-Badge zeigt offene Aufgaben-Anzahl via `/api/tasks/badge-count`.
- **Customer Kilometers**: Separate tracking for kilometers driven with/for the customer.
- **Birthdays**: Integrated as tab in the Customers page (`/customers`), showing upcoming birthdays for employees and assigned customers with server-side cache and frontend staleTime.
- **Navigation Structure**: Bottom nav tabs: Termine (`/`), Kunden (`/customers` with Geburtstage tab), Aufgaben (`/tasks` with red badge dot), Nachweise (`/service-records`), Zeiten (`/my-times`).

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.
- **Utilities**: `libphonenumber-js`.