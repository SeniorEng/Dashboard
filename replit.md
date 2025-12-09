# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack, mobile-first web application designed to streamline operations for caregivers managing elderly care services. It provides functionalities for scheduling, tracking, and documenting appointments, including digital signatures and real-time data management. The system aims to enhance efficiency for care professionals with features like comprehensive customer management, unified service models, robust data historization for compliance, and adherence to German labor laws. The business vision includes expanding customer management capabilities, unifying service models, and ensuring data integrity for auditing.

## User Preferences
- Preferred communication style: Simple, everyday language
- No profile pictures for customers (use icons instead)

## System Architecture

### Frontend
- **Frameworks**: React 18 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme (teal and warm beige).
- **State Management**: TanStack Query for data fetching (optimistic updates, caching), React memoization, ErrorBoundary for error handling.
- **Design System**: Centralized `@/design-system` for consistent styling, enforcing the use of tokens for icons, component styles, semantic spacing, and semantic colors (status, service, care level).
- **Date/Time Handling**: Uses local times without time zone conversion, treating all date/time data as "German local time". `date` columns are "YYYY-MM-DD" strings, `time` columns are "HH:MM:SS" strings. Centralized utilities (`@shared/utils/datetime`) must be used for parsing and formatting.
- **API Calls**: All state-changing API requests (POST, PATCH, DELETE) must use the central API client (`client/src/lib/api/client.ts`) for CSRF protection (Double-Submit Cookie Pattern). Direct `fetch()` calls for mutations will result in 403 errors.
- **Phone Number Handling**: Uses `libphonenumber-js` via `@shared/utils/phone.ts` for validating, formatting, and storing German phone numbers in E.164 format (`+49...`).
- **Type Organization**: Hierarchical type structure with `@shared/schema.ts` (Drizzle, Zod), `@shared/domain/*` (business logic, domain types), `@shared/utils/*` (utilities), and `@shared/types.ts` (re-exports for frontend).

### Backend
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints, Zod validation, structured error responses, and modular routing.
- **Business Logic**: Separated into a dedicated service layer with dependency injection for testability.
- **Error Handling**: Centralized error codes and German messages, consistent error formatting via `handleRouteError()`.
- **Security**: Role-based access control with SQL-level data filtering, CSRF protection for all state-changing requests, and database indexing for performance.

### Data Storage
- **Database**: PostgreSQL via Neon serverless, managed with Drizzle ORM.
- **Schema**: Includes tables for `customers`, `appointments`, `insurance_providers`, `employee_time_entries`, and others, utilizing a historization pattern (`valid_from`/`valid_to`) for changing data.
- **Data Types**: Strict SQL types for data integrity.
- **Indexes**: Composite indexes on frequently queried columns.
- **Data Layer**: `IStorage` interface abstraction with `DatabaseStorage` providing optimized queries, pagination, and application-level rollback.
- **Caching**: In-memory cache for assigned customer IDs with TTL and invalidation.

### Business Rules & Patterns
- **Shared Domain Logic**: Single source of truth for business rules (e.g., appointment status transitions).
- **Field Editing**: Rules govern which fields are editable based on appointment status.
- **Overlap Checking**: Logic for preventing appointment overlaps.
- **Service Model**: "Erstberatung" (initial consultation) is a core service type.
- **Customer Management**: Multi-step customer creation, detailed views, and German-specific validation (IK numbers, insurance numbers).
- **Budgeting & Pricing**: Supports various budget types and customer-specific service rates.
- **Employee Time Tracking**: Comprehensive tracking for client and non-client work (vacation, sick leave, breaks, office work, etc.), including yearly vacation allowance and multi-day entries. Past entries are locked for non-admin users.
- **German Labor Law Compliance**: Automatic detection of missing break documentation based on work hours (`§4 ArbZG`).
- **Open Tasks System**: Dashboard banners alert employees to pending tasks like undocumented appointments or missing break documentation.
- **Customer Kilometers**: Tracking of kilometers driven with/for the customer ("Km für/mit Kunde") separate from travel kilometers.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.