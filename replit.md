# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack web application for caregivers managing elderly care services. It provides a mobile-first interface for scheduling, tracking, and documenting appointments, including digital signatures. The system aims to streamline operations for care professionals with real-time data management. The project vision includes comprehensive customer management, unified service models, and robust data historization for auditing and compliance.

## User Preferences
- Preferred communication style: Simple, everyday language
- No profile pictures for customers (use icons instead)

## System Architecture

### Frontend Architecture
- **Frameworks**: React 18 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: `shadcn/ui` components on Radix UI primitives, Tailwind CSS v4 with a "Care & Clarity" theme (teal and warm beige), mobile-first responsive design.
- **State Management**: TanStack Query for data fetching with optimistic updates and caching, React memoization for performance, ErrorBoundary for graceful error handling.
- **Structure**: Feature-based architecture with clear separation of concerns, utilizing a shared domain logic (`@shared/domain`).
- **Design System**: Centralized design tokens (`@/design-system`) for colors, typography, spacing, and pre-defined component styles. Semantic color functions for status, service, and Pflegegrad. Layout patterns include `PageHeader`, `SectionCard`, `DataList`, `EmptyState`, and `StatusBadge`.

### Backend Architecture
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints (`/api/customers`, `/api/appointments`), Zod validation, structured error responses.
- **Structure**: Modular routes (`server/routes/`), business logic in a dedicated service layer (`server/services/`).
- **Error Handling**: Centralized error codes (VALIDATION_ERROR, NOT_FOUND, etc.) with German messages, consistent error formatting via `handleRouteError()`.

### Data Storage
- **Database**: PostgreSQL via Neon serverless, Drizzle ORM for type-safe queries.
- **Schema**: Key tables include `customers`, `appointments`, `insurance_providers`, `customer_insurance_history`, `customer_contacts`, `care_level_history`, `customer_budgets`, `customer_contracts`, `customer_contract_rates`, `service_rates`. Historization pattern uses `valid_from`/`valid_to` timestamps for changing data.
- **Data Types**: Strict SQL types are enforced for dates, times, timestamps, booleans, and numbers to ensure data integrity and enable native database operations.
- **Indexes**: Composite indexes on frequently queried columns (`date`, `customer_id`, `status`) for performance.
- **Data Layer**: `IStorage` interface abstraction, `DatabaseStorage` with optimized join queries, pagination support, and application-level rollback for atomicity due to Neon HTTP driver limitations.

### Business Rules & Patterns
- **Shared Domain Logic**: A single source of truth (`shared/domain/`) for business rules, including appointment status transitions (scheduled → in-progress → documenting → completed, with completed being immutable).
- **Field Editing Rules**: Specific fields editable only in certain appointment statuses.
- **Overlap Checking**: Logic for checking appointment overlaps based on `actualEnd` for completed appointments and `scheduledEnd` or calculated duration for scheduled appointments.
- **Service Model**: "Erstberatung" is integrated as a service type with a unified 2-step documentation flow.
- **Customer Management**: Multi-step customer creation wizard, detailed customer views, and German-specific validation (IK numbers, Versichertennummer). Inline insurance provider creation during customer wizard.
- **Budgeting & Pricing**: Supports various budget types (e.g., §45b, §39, §36) and customer-specific service rates.
- **Employee Time Tracking**: Employees can track non-client work including vacation (Urlaub), sick leave (Krankheit), breaks (Pause), office work (Büroarbeit), sales (Vertrieb), training (Schulung), meetings (Besprechung), and other activities. Yearly vacation allowance tracking with used/planned/remaining days summary. Admin view for all employee time entries with vacation allowance management.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, shadcn/ui, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.