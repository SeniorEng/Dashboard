# CareConnect - Elderly Care Service Management System

## Overview

CareConnect is a full-stack web application designed to help caregivers manage appointments and client information for elderly care services. The application provides a mobile-first interface for viewing daily schedules, tracking appointments, documenting services, and collecting digital signatures. Built with a modern tech stack, it offers real-time data management and a smooth user experience for care professionals on the go.

## User Preferences

- Preferred communication style: Simple, everyday language
- No profile pictures for customers (use icons instead)

## Recent Changes (December 2025)

- Refactored for speed, modularization, and maintainability
- Implemented optimized SQL joins instead of in-memory joins
- Created feature-based frontend architecture
- Added optimistic updates for better UX
- Implemented centralized error boundary
- Memoized expensive computations

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
│       │       ├── utils.ts     # Feature utilities
│       │       └── index.ts     # Public exports
│       ├── pages/               # Route pages
│       ├── hooks/               # Shared hooks
│       └── lib/                 # Utilities
├── server/
│   ├── routes/                  # Modular API routes
│   │   ├── appointments.ts
│   │   ├── customers.ts
│   │   └── index.ts
│   ├── storage.ts               # Database layer
│   └── routes.ts                # Route registration
└── shared/
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
- Shared types imported from `@shared/types`
- Clear separation of concerns

### Backend Architecture

**Server Framework**
- Express.js with TypeScript
- Modular route organization (`server/routes/`)

**API Design**
- RESTful endpoints under `/api` prefix
- Routes: `/api/customers`, `/api/appointments`
- Zod validation with error handling
- Optimized SQL joins for data fetching

**Performance Optimizations**
- Single-query data fetching with LEFT JOIN
- Structured error responses
- Request validation middleware

### Data Storage

**Database**
- PostgreSQL via Neon serverless
- Drizzle ORM for type-safe queries

**Schema**
- `customers`: id, name, address, avatar, needs[]
- `appointments`: id, customerId, type, date, time, status, startTime, endTime, kilometers, notes, servicesDone[], signatureData

**Data Layer**
- IStorage interface for abstraction
- DatabaseStorage with optimized join queries
- AppointmentWithCustomer type for hydrated data

### Key Patterns

1. **Optimistic Updates**: UI updates immediately, rolls back on error
2. **Memoization**: Expensive sorts/calculations cached
3. **Error Boundaries**: Graceful error recovery
4. **Feature Modules**: Self-contained feature code
5. **Shared Types**: Single source of truth for TypeScript types

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
