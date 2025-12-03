# CareConnect - Elderly Care Service Management System

## Overview

CareConnect is a full-stack web application designed to help caregivers manage appointments and client information for elderly care services. The application provides a mobile-first interface for viewing daily schedules, tracking appointments, documenting services, and collecting digital signatures. Built with a modern tech stack, it offers real-time data management and a smooth user experience for care professionals on the go.

## User Preferences

- Preferred communication style: Simple, everyday language
- No profile pictures for customers (use icons instead)

## Recent Changes (December 2025)

### Unified Service Model (Latest)
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

## Project Structure

```
├── client/
│   └── src/
│       ├── components/          # Shared UI components
│       │   ├── ui/              # shadcn/ui primitives
│       │   ├── layout.tsx       # App layout wrapper
│       │   └── error-boundary.tsx
│       ├── features/            # Feature-based modules
│       │   └── appointments/
│       │       ├── components/  # Feature-specific components
│       │       ├── hooks/       # Feature-specific hooks
│       │       ├── domain.ts    # Frontend domain (uses shared)
│       │       └── index.ts     # Public exports
│       ├── pages/               # Route pages
│       ├── hooks/               # Shared hooks
│       └── lib/                 # Utilities
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
