# CareConnect - Elderly Care Service Management System

## Overview

CareConnect is a full-stack web application designed to help caregivers manage appointments and client information for elderly care services. The application provides a mobile-first interface for viewing daily schedules, tracking appointments, documenting services, and collecting digital signatures. Built with a modern tech stack, it offers real-time data management and a smooth user experience for care professionals on the go.

## User Preferences

- Preferred communication style: Simple, everyday language
- No profile pictures for customers (use icons instead)

## Recent Changes (December 2025)

### Comprehensive Customer Management System (Latest)
- **New Database Tables**: insurance_providers, customer_insurance_history, customer_contacts, care_level_history, customer_budgets, customer_contracts, customer_contract_rates, service_rates
- **Historization Pattern**: All changing data (insurance, Pflegegrad, budgets, contracts, rates) uses valid_from/valid_to timestamps for complete audit trail
- **Admin Customer Management UI**: New pages at `/admin/customers` with:
  - Paginated customer list with search and filters (pflegegrad, assigned employee)
  - Multi-step customer creation wizard (Personal Data → Insurance → Contacts → Budgets → Contract)
  - Customer detail view with tabbed layout (Overview, Contacts, Insurance, Budgets, History)
- **Storage Layer**: `server/storage/customer-management.ts` with full CRUD operations and transactional customer creation
- **German Validation**: IK numbers (9 digits), Versichertennummer (letter + 9 digits), phone formatting

### Budget Types (stored in cents)
- **§45b Entlastungsbetrag**: 125€/month (default)
- **§39 Verhinderungspflege**: 1,612€/year (default)
- **§36 Pflegesachleistungen**: Varies by Pflegegrad (PG2: 761€, PG3: 1,432€, PG4: 1,778€, PG5: 2,200€)

### Service Pricing
- Default hourly rates: Hauswirtschaft 38€, Alltagsbegleitung 42€
- Customer-specific rate overrides via contract rates table

### Unified Service Model
- **Erstberatung as Service Type**: Erstberatung is now a service type like Hauswirtschaft/Alltagsbegleitung
- **Unified Documentation Flow**: Both appointment types (Erstberatung and Kundentermin) now use the same 2-step documentation wizard (Step 1: Services, Step 2: Travel)
- **New Schema Columns**: Added `erstberatung_dauer`, `erstberatung_actual_dauer`, `erstberatung_details` to appointments table
- **Creation Flow**: Erstberatung appointments now pick a duration like other services (no more separate end time picker)
- **Service Colors**: Erstberatung uses purple theme (bg-purple-500) to match appointment type color

### Major Refactoring
- **Shared Domain Module**: Consolidated all business logic into `shared/domain/` eliminating duplication across frontend/backend
- **Service Layer**: Extracted scheduling validation, overlap checking, and status transition enforcement into `server/services/appointments.ts`
- **Centralized Error Handling**: Created `server/lib/errors.ts` with standardized error codes and German messages
- **Database Optimizations**: Added composite indexes on frequently-queried columns (date, customer_id, status)
- **Pagination Support**: Added `getAppointmentsWithCustomersPaginated()` for future list performance
- **Application-Level Rollback**: Implemented atomic Erstberatung creation with rollback (Neon HTTP driver doesn't support transactions)
- **Frontend Domain Layer**: Components now use shared domain helpers for status/service colors, labels, and calculations

### Typed API Client Layer (Latest)
- **Centralized API Client**: `client/src/lib/api/client.ts` with:
  - Type-safe HTTP methods (`api.get`, `api.post`, `api.patch`, `api.delete`)
  - Structured error handling with `ApiResult<T>` union type
  - Automatic retry logic for network failures (3 retries)
  - Consistent credential handling and abort signal support
- **API Types**: `client/src/lib/api/types.ts` with TypeScript interfaces for all API entities
- **Feature Hooks Module**: `client/src/features/customers/hooks/` containing:
  - `useCustomers()` - Paginated customer list with search/filter
  - `useCustomer(id)` - Single customer detail
  - `useCreateCustomer()` - Customer creation mutation
  - `useUpdateCustomer()` - Customer update mutation  
  - `useDeleteCustomer()` - Customer deletion mutation
  - `useEmployees()` - Employee list for dropdowns
  - `useInsuranceProviders()` - Insurance provider list
- **Query Key Management**: Centralized query keys for cache invalidation

## Project Structure

```
├── client/
│   └── src/
│       ├── components/          # Shared UI components
│       │   ├── ui/              # shadcn/ui primitives
│       │   ├── patterns/        # Layout pattern components
│       │   │   ├── page-shell.tsx      # Page wrapper with bg
│       │   │   ├── page-header.tsx     # Consistent page headers
│       │   │   ├── section-card.tsx    # Card with header/actions
│       │   │   ├── data-list.tsx       # List styling primitives
│       │   │   ├── empty-state.tsx     # Empty state display
│       │   │   └── status-badge.tsx    # Semantic status badges
│       │   ├── layout.tsx       # App layout wrapper
│       │   └── error-boundary.tsx
│       ├── design-system/       # Centralized design tokens
│       │   ├── tokens.ts        # Colors, typography, spacing
│       │   └── index.ts         # Public exports
│       ├── features/            # Feature-based modules
│       │   ├── appointments/
│       │   │   ├── components/  # Feature-specific components
│       │   │   ├── hooks/       # Feature-specific hooks
│       │   │   ├── domain.ts    # Frontend domain (uses shared)
│       │   │   └── index.ts     # Public exports
│       │   └── customers/
│       │       ├── hooks/       # Customer/employee/insurance hooks
│       │       │   ├── use-customers.ts
│       │       │   ├── use-employees.ts
│       │       │   └── use-insurance-providers.ts
│       │       └── index.ts     # Public exports
│       ├── lib/
│       │   └── api/             # Typed API client
│       │       ├── client.ts    # HTTP client with retry logic
│       │       ├── types.ts     # API response types
│       │       └── index.ts     # Public exports
│       ├── pages/               # Route pages
│       └── hooks/               # Shared hooks
├── server/
│   ├── routes/                  # Modular API routes
│   │   ├── appointments.ts
│   │   ├── customers.ts
│   │   └── index.ts
│   ├── services/
│   │   └── appointments.ts      # Business logic & validation
│   ├── lib/
│   │   └── errors.ts            # Centralized error handling
│   ├── storage.ts               # Database layer
│   └── routes.ts                # Route registration
└── shared/
    ├── domain/
    │   ├── index.ts             # Public exports
    │   └── appointments.ts      # Canonical business logic
    ├── schema.ts                # Drizzle schema + Zod
    └── types.ts                 # Shared TypeScript types
```

## System Architecture

### Frontend Architecture

**Framework & Build Tool**
- React 18 with TypeScript
- Vite for fast HMR and optimized builds
- Wouter for lightweight client-side routing

**UI Component System**
- shadcn/ui components on Radix UI primitives
- Tailwind CSS v4 with "Care & Clarity" theme (teal + warm beige)
- Mobile-first responsive design

**State Management**
- TanStack Query with optimistic updates and staleTime caching
- React memoization (memo, useMemo, useCallback) for performance
- ErrorBoundary for graceful error handling

**Feature-Based Architecture**
- Each feature exports hooks, components, and utilities
- Shared domain logic imported from `@shared/domain`
- Clear separation of concerns

### Backend Architecture

**Server Framework**
- Express.js with TypeScript
- Modular route organization (`server/routes/`)
- Service layer for business logic (`server/services/`)

**API Design**
- RESTful endpoints under `/api` prefix
- Routes: `/api/customers`, `/api/appointments`
- Zod validation with structured error responses
- Optimized SQL joins for data fetching

**Error Handling**
- Centralized error codes: VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, CONFLICT, SERVER_ERROR
- All error messages in German for end users
- `handleRouteError()` helper for consistent error formatting

### Data Storage

**Database**
- PostgreSQL via Neon serverless
- Drizzle ORM for type-safe queries

**Schema**
- `customers`: id, name, vorname, nachname, telefon, address (legacy + structured fields), pflegegrad, needs[]
- `appointments`: id, customerId, appointmentType, date, scheduledStart, scheduledEnd, status, actualStart, actualEnd, kilometers, notes, servicesDone[], signatureData, hauswirtschaftDauer, hauswirtschaftActualDauer, hauswirtschaftDetails, alltagsbegleitungDauer, alltagsbegleitungActualDauer, alltagsbegleitungDetails, erstberatungDauer, erstberatungActualDauer, erstberatungDetails

**Indexes**
- `idx_appointments_date` on date column
- `idx_appointments_customer_id` on customerId column  
- `idx_appointments_status` on status column
- `idx_appointments_date_customer` composite index

**Data Layer**
- IStorage interface for abstraction
- DatabaseStorage with optimized join queries
- Pagination support with total counts
- Application-level rollback for atomic operations

### Business Rules (shared/domain/appointments.ts)

**Status Transitions**
- Sequential only: scheduled → in-progress → documenting → completed
- Completed appointments are immutable

**Field Editing Rules**
- Scheduling fields (date, times, durations): Only in "scheduled" status
- Notes: Editable in "scheduled" or "documenting" status
- Documentation fields (kilometers, servicesDone, signature): Only in "documenting" or "completed" status

**Overlap Checking**
- Completed appointments: Check against actualEnd timestamp
- Scheduled appointments: Check against scheduledEnd or calculate from duration
- Unreliable data detection: Flag appointments without proper end times

### Key Patterns

1. **Shared Domain Logic**: Single source of truth for business rules
2. **Service Layer**: Thin routes, business logic in services
3. **Optimistic Updates**: UI updates immediately, rolls back on error
4. **Memoization**: Expensive sorts/calculations cached
5. **Error Boundaries**: Graceful error recovery
6. **Centralized Errors**: Consistent error codes and German messages

## Design System

### Overview

The design system provides centralized tokens and reusable patterns for consistent UI across the application. All styling decisions should use tokens from `@/design-system` rather than hardcoded values.

### Design Tokens (`client/src/design-system/tokens.ts`)

**Icon Sizes**: Use `iconSize` for consistent icon sizing
```typescript
import { iconSize } from "@/design-system";

<Search className={iconSize.sm} />  // h-4 w-4
<User2 className={iconSize.md} />   // h-5 w-5
<Heart className={iconSize.lg} />   // h-6 w-6
```

**Component Styles**: Pre-defined class combinations
```typescript
import { componentStyles } from "@/design-system";

<Button className={componentStyles.btnPrimary}>Save</Button>
<div className={componentStyles.avatarContainer}>...</div>
```

**Color Utilities**: Semantic color functions
```typescript
import { getStatusColors, getServiceColors, getPflegegradColors } from "@/design-system";

const colors = getStatusColors("scheduled");
// { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", icon: "text-blue-500" }
```

### Layout Patterns (`client/src/components/patterns/`)

**PageHeader**: Consistent page headers with back button and actions
```tsx
<PageHeader
  title="Kundenverwaltung"
  subtitle="15 Kunden gefunden"
  backHref="/admin"
  actions={<Button>Neu</Button>}
/>
```

**SectionCard**: Cards with optional header, icon, and actions
```tsx
<SectionCard
  title="Kontaktdaten"
  icon={<User2 className={iconSize.sm} />}
  actions={<Button size="sm">Bearbeiten</Button>}
>
  {/* Content */}
</SectionCard>
```

**DataList & DataListItem**: Consistent list styling
```tsx
<DataList>
  <DataListItem onClick={() => navigate(url)}>
    {/* Item content */}
  </DataListItem>
</DataList>
```

**EmptyState**: Consistent empty state display
```tsx
<EmptyState
  icon={<Users className={iconSize.xl} />}
  title="Keine Kontakte"
  description="Noch keine Kontakte hinterlegt"
  action={<Button>Hinzufügen</Button>}
/>
```

**StatusBadge**: Semantic badges for status, service type, and Pflegegrad
```tsx
<StatusBadge type="status" value="scheduled" />
<StatusBadge type="service" value="hauswirtschaft" />
<StatusBadge type="pflegegrad" value={3} />
```

### Color Palette

| Category | Colors |
|----------|--------|
| **Primary** | Teal (bg-teal-600, hover:bg-teal-700) |
| **Status: Scheduled** | Blue (bg-blue-50, text-blue-700) |
| **Status: In Progress** | Amber (bg-amber-50, text-amber-700) |
| **Status: Documenting** | Orange (bg-orange-50, text-orange-700) |
| **Status: Completed** | Green (bg-green-50, text-green-700) |
| **Service: Hauswirtschaft** | Emerald (bg-emerald-500) |
| **Service: Alltagsbegleitung** | Sky (bg-sky-500) |
| **Service: Erstberatung** | Purple (bg-purple-500) |
| **Page Background** | Warm beige gradient (from-[#f5e6d3] to-[#e8d4c4]) |

### Usage Guidelines

1. **Always import from design system** - Use `@/design-system` for colors, spacing, and icon sizes
2. **Use pattern components** - PageHeader, SectionCard, DataList for consistent layouts
3. **Semantic color functions** - Use getStatusColors(), getServiceColors() instead of hardcoded classes
4. **Icon sizes from tokens** - Use iconSize.sm/.md/.lg instead of h-4 w-4 directly

## Key Learnings & Rules

### Database Schema Design

**ALWAYS use proper SQL types - never use text for structured data:**

| Data Type | WRONG | CORRECT |
|-----------|-------|---------|
| Time slots (09:00) | `text("time")` | `time("time")` |
| Dates | `text("date")` | `date("date")` |
| Timestamps | `text("created_at")` | `timestamp("created_at")` |
| Boolean | `text("active")` | `boolean("active")` |
| Numbers | `text("amount")` | `integer("amount")` or `numeric("amount")` |

**Why this matters:**
- Text columns provide no validation (you can store "banana" in a time field)
- No native sorting or comparison
- No database-level arithmetic or calculations
- Causes runtime errors when the application expects proper types
- Makes migrations painful when you need to fix it later

**Current schema uses:**
```typescript
date: date("date").notNull(),              // Appointment date (proper SQL date)
scheduledStart: time("scheduled_start").notNull(),  // Planned start time (e.g., "09:00")
scheduledEnd: time("scheduled_end"),       // Planned end time (e.g., "12:00")
actualStart: timestamp("actual_start"),    // When visit actually started
actualEnd: timestamp("actual_end"),        // When visit actually ended
```

### Overlap Checking Logic

**Business rules for appointment scheduling:**
- **Completed appointments**: Check against documented `actualEnd` timestamp. Skip if no actual end time recorded (visit is done).
- **Scheduled appointments**: Check against planned `scheduledEnd` or calculate from `durationPromised`.
- Always provide clear German error messages for scheduling conflicts.

### Neon Database Limitations

- Neon HTTP driver doesn't support transactions
- Use application-level rollback for atomic operations (create customer, if appointment fails, delete customer)
- Always clean up on failure to maintain data consistency
