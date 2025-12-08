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
- **Date/Time Handling (KRITISCH - Harmonisiertes System)**:
  Das System verwendet **Variante C: Lokale Zeiten ohne Zeitzone** für alle Termin- und Zeitdaten. Alle Zeiten werden als "deutsche Ortszeit" behandelt - keine UTC-Konvertierung nötig.
  
  **Datenbankformate:**
  - `date` Spalten: String "YYYY-MM-DD" (z.B. "2025-12-04")
  - `time` Spalten: String "HH:MM:SS" (z.B. "16:30:00")
  - Keine `timestamptz` für Terminzeiten! (Nur für Audit-Felder wie `createdAt`)
  
  **Zentrale Utilities** (`shared/utils/datetime.ts`):
  ```typescript
  import { 
    parseLocalDate,      // "2025-12-04" → Date (lokale Mitternacht)
    parseLocalTime,      // "16:30:00" → { hours: 16, minutes: 30, seconds: 0 }
    formatDateISO,       // Date → "2025-12-04"
    formatTimeHHMM,      // "16:30:00" → "16:30"
    formatTimeHHMMSS,    // Date/time → "16:30:00"
    combineDateAndTime,  // ("2025-12-04", "16:30:00") → Date
    timeToMinutes,       // "16:30:00" | Date → 990
    minutesToTime,       // 990 → "16:30:00"
  } from "@shared/utils/datetime";
  ```
  
  **Lerneffekte & Regeln:**
  1. **NIEMALS** `new Date("2025-12-04")` verwenden! JavaScript interpretiert das als UTC-Mitternacht → Verschiebung um einen Tag möglich
  2. **IMMER** die zentralen Utilities verwenden für konsistentes Parsing
  3. Drizzle gibt `date`/`time` als Strings zurück, `timestamp` als Date-Objekte → daher alle Terminzeiten als `time` speichern
  4. Das System ist nur für Deutschland ausgelegt - 16:00 Uhr ist immer 16:00 Uhr deutscher Zeit
  
  **Beispiel korrektes Parsen:**
  ```typescript
  // FALSCH - führt zu Zeitzonenproblemen:
  const date = new Date("2025-12-04");
  
  // RICHTIG - zeitzonen-sicher mit Utility:
  import { parseLocalDate } from "@shared/utils/datetime";
  const date = parseLocalDate("2025-12-04");
  ```
- **Phone Number Handling**: Telefonnummern werden über `shared/utils/phone.ts` mit der Bibliothek `libphonenumber-js` verarbeitet. Nur deutsche Nummern (+49) sind erlaubt.
  - **Speicherung**: Immer im E.164-Format (`+491701234567`) in der Datenbank speichern
  - **Anzeige**: `formatPhoneForDisplay()` für nationale Darstellung (`0170 1234567`)
  - **Validierung**: `validateGermanPhone()` prüft Gültigkeit und gibt Typ zurück (mobile/landline)
  - **Live-Formatierung**: `formatPhoneAsYouType()` für Eingabefelder
  ```javascript
  import { validateGermanPhone, formatPhoneForDisplay, normalizePhone } from "@shared/utils/phone";
  
  // Validieren & Normalisieren vor dem Speichern:
  const result = validateGermanPhone(userInput);
  if (result.valid) {
    await saveToDb(result.normalized); // "+491701234567"
  }
  
  // Anzeige für Benutzer:
  const display = formatPhoneForDisplay("+491701234567"); // "0170 1234567"
  ```

### Backend Architecture
- **Framework**: Express.js with TypeScript.
- **API Design**: RESTful endpoints (`/api/customers`, `/api/appointments`), Zod validation, structured error responses.
- **Structure**: Modular routes (`server/routes/`), business logic in a dedicated service layer (`server/services/`).
- **Error Handling**: Centralized error codes (VALIDATION_ERROR, NOT_FOUND, etc.) with German messages, consistent error formatting via `handleRouteError()`.
- **Security**: Role-based access control with SQL-level data filtering. CSRF protection via Double-Submit Cookie pattern with `X-CSRF-Token` header validation for all state-changing requests. Database indexes on frequently queried columns (`customerId`, `date`, `assignedEmployeeId`) for performance optimization.

### Data Storage
- **Database**: PostgreSQL via Neon serverless, Drizzle ORM for type-safe queries.
- **Schema**: Key tables include `customers`, `appointments`, `insurance_providers`, `customer_insurance_history`, `customer_contacts`, `care_level_history`, `customer_budgets`, `customer_contracts`, `customer_contract_rates`, `service_rates`, `employee_time_entries`. Historization pattern uses `valid_from`/`valid_to` timestamps for changing data.
- **Data Types**: Strict SQL types are enforced for dates, times, timestamps, booleans, and numbers to ensure data integrity and enable native database operations.
- **Indexes**: Composite indexes on frequently queried columns (`date`, `customer_id`, `status`, `assigned_employee_id`, `user_id`, `entry_date`) for performance.
- **Data Layer**: `IStorage` interface abstraction, `DatabaseStorage` with optimized join queries, pagination support, and application-level rollback for atomicity due to Neon HTTP driver limitations.
- **Caching**: In-memory cache for assigned customer IDs per employee with 10-minute TTL. Cache invalidation on customer creation, deletion, and employee assignment changes.

### Business Rules & Patterns
- **Shared Domain Logic**: A single source of truth (`shared/domain/`) for business rules, including appointment status transitions (scheduled → in-progress → documenting → completed, with completed being immutable).
- **Field Editing Rules**: Specific fields editable only in certain appointment statuses.
- **Overlap Checking**: Logic for checking appointment overlaps based on `actualEnd` for completed appointments and `scheduledEnd` or calculated duration for scheduled appointments.
- **Service Model**: "Erstberatung" is integrated as a service type with a unified 2-step documentation flow.
- **Customer Management**: Multi-step customer creation wizard, detailed customer views, and German-specific validation (IK numbers, Versichertennummer). Inline insurance provider creation during customer wizard.
- **Budgeting & Pricing**: Supports various budget types (e.g., §45b, §39, §36) and customer-specific service rates.
- **Employee Time Tracking**: Employees can track non-client work including vacation (Urlaub), sick leave (Krankheit), breaks (Pause), office work (Büroarbeit), sales (Vertrieb), training (Schulung), meetings (Besprechung), and other activities. Yearly vacation allowance tracking with used/planned/remaining days summary. Admin view for all employee time entries with vacation allowance management. Multi-day date range support for Urlaub and Krankheit. Past vacation/sick leave entries are locked for non-admin users to prevent manipulation.
- **German Labor Law Compliance (§4 ArbZG)**: Automatic detection of missing break documentation based on work hours. When an employee works more than 6 hours, they must document at least 30 minutes of break. When working more than 9 hours, they must document at least 45 minutes. The calculation only counts actual service time (Hauswirtschaft, Alltagsbegleitung, Erstberatung) plus administrative entries - travel time (Anfahrt) is excluded as it's not continuous work.
- **Open Tasks System**: Dashboard displays banners for pending tasks including undocumented appointments (amber) and missing break documentation (blue). This helps employees stay compliant with documentation requirements.
- **Customer Kilometers**: During Alltagsbegleitung documentation, employees can record additional "Km für/mit Kunde" (kilometers driven with/for the customer) separate from travel kilometers (Anfahrt). This captures trips like doctor visits, shopping, or errands done with the customer. These are displayed separately in the time overview.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, shadcn/ui, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.