# CareConnect - Elderly Care Service Management System

## Overview
CareConnect is a full-stack, mobile-first web application designed to streamline operations for caregivers managing elderly care services. It provides functionalities for scheduling, tracking, and documenting appointments, including digital signatures and real-time data management. The system aims to enhance efficiency for care professionals with features like comprehensive customer management, unified service models, robust data historization for compliance, and adherence to German labor laws. The business vision includes expanding customer management capabilities, unifying service models, and ensuring data integrity for auditing.

## User Preferences
- Preferred communication style: Simple, everyday language
- **Keine Avatare/Profilbilder**: Für Kunden und Mitarbeiter werden keine Fotos oder Avatar-Platzhalter verwendet. Stattdessen werden Namen direkt mit Badges (z.B. Pflegegrad) dargestellt. Dies spart Platz und hält die Oberfläche aufgeräumt.

## System Architecture

### Frontend
- **Frameworks**: React 18 with TypeScript, Vite, Wouter for routing.
- **UI/UX**: Mobile-first responsive design using `shadcn/ui` components on Radix UI primitives, styled with Tailwind CSS v4 and a "Care & Clarity" theme (teal and warm beige).
- **State Management**: TanStack Query for data fetching (optimistic updates, caching), React memoization, ErrorBoundary for error handling.
- **Design System**: Centralized `@/design-system` for consistent styling, enforcing the use of tokens for icons, component styles, semantic spacing, and semantic colors (status, service, care level).
  - **PageHeader**: Responsive stacked layout - title wraps naturally on mobile, action buttons go full-width below. Uses `componentStyles.pageHeader*` tokens.
  - **ResponsiveTabs**: Priority+ pattern - shows first N tabs inline, rest collapse into "Mehr" dropdown on mobile. Component at `@/components/patterns/responsive-tabs.tsx`.
- **Date/Time Handling** (verbindliche Konventionen für alle Implementierungen):
  - **Grundprinzip**: Alle Zeiten sind implizit "deutsche Ortszeit" — keine UTC-Konvertierung, keine Zeitzone-Logik.
  - **Speicherformate (Datenbank)**:
    - Datum: `date` → String `"YYYY-MM-DD"` (PostgreSQL `date`)
    - Uhrzeit: `time` → String `"HH:MM:SS"` (PostgreSQL `time without time zone`)
    - Dauer: `integer` in Minuten
    - Systemzeitstempel: `timestamp({ withTimezone: true })` → `timestamptz` (created_at, updated_at etc.)
  - **Anzeigeformate (Frontend)**:
    - Uhrzeit: `"HH:MM"` — Sekunden werden NIE angezeigt
    - Datum: `"DD.MM.YYYY"` (deutsch) oder `"YYYY-MM-DD"` (Formulare, API)
  - **Verbotene Patterns** (NIEMALS verwenden!):
    - `new Date()` für Uhrzeiten → Zeitzonen-Probleme! Stattdessen: `currentTimeHHMMSS()` / `currentTimeHHMM()`
    - `Date`-Objekte an Zeit-Utilities übergeben → alle akzeptieren NUR Strings
    - ISO-Timestamps (`"2025-12-02T09:45:00.000Z"`) für lokale Zeiten
    - `date.getHours()` / `date.getMinutes()` für Zeitberechnungen
  - **Erlaubte Patterns**:
    - `parseLocalDate("YYYY-MM-DD")` → `Date`-Objekt NUR für Datumsberechnungen (Wochentag, addDays)
    - `formatDateISO(date)` → zurück zu `"YYYY-MM-DD"` nach Berechnung
    - `todayISO()` → heutiges Datum als String
    - `currentTimeHHMMSS()` / `currentTimeHHMM()` → aktuelle Uhrzeit als String
    - Alle Funktionen in `@shared/utils/datetime` arbeiten mit Strings
  - **Zentrale Utilities** (`@shared/utils/datetime`): Müssen für ALLE Datums-/Zeitoperationen verwendet werden. Keine eigenen Parsing-/Formatierungsfunktionen schreiben.
- **DatePicker-Komponente**: Alle Datumsfelder verwenden die zentrale `DatePicker`-Komponente (`@/components/ui/date-picker.tsx`). Diese bietet:
  - Deutsche Lokalisierung (Montag als Wochenbeginn, deutsche Monatsnamen)
  - Touch-optimierte 44px Mindestgröße für Mobile-Kompatibilität (iOS Safari, Android Chrome)
  - Popover-basiertes Kalender-Widget statt nativem `type="date"` Input
  - ISO-String API (`value: string | null`, `onChange: (date: string | null) => void`)
  - Optional: `clearable`, `minDate`, `maxDate` Props
- **Mobile-Kompatibilität**: Die App verwendet touch-optimierte UI-Komponenten mit mindestens 44x44px Touch-Bereichen gemäß WCAG-Richtlinien. Radix UI Popovers verwenden `modal={true}` für korrektes Scroll-Locking auf Mobile.
  - **Touch-Targets**: Alle interaktiven Elemente (Input, Select, Checkbox, Buttons) haben `min-h-[44px]` für WCAG-konforme Touch-Bereiche.
  - **iOS Safari Zoom-Prävention**: Inputs verwenden `text-base` (16px) auf Mobile, um automatisches Zoomen bei Fokus zu verhindern.
  - **Dialog Mobile-Pattern**: Dialoge auf Mobile erscheinen als Bottom-Sheet (slide-up), auf Desktop als zentriertes Modal. Dies verbessert die Bedienung bei virtueller Tastatur.
  - **Viewport**: `maximum-scale=1` verhindert ungewolltes Pinch-Zooming.
  - **SearchableSelect**: Für lange Auswahllisten (Kunden, Mitarbeiter, Pflegekassen) wird `SearchableSelect` (`@/components/ui/searchable-select.tsx`) statt `Select` verwendet. Diese Komponente bietet:
    - Integrierte Suchfunktion (cmdk-basiert) zum Filtern langer Listen
    - Mobile: Drawer (Bottom-Sheet) mit scrollbarer, durchsuchbarer Liste
    - Desktop: Popover mit scrollbarer, durchsuchbarer Liste
    - Touch-optimierte 44px Mindestgröße, sublabel-Support für Zusatzinfos (z.B. Adresse, IK-Nummer)
    - Kurze/statische Listen (Pflegegrad, Dauer, Status, Monat) verwenden weiterhin die normale `Select`-Komponente
- **Kartenlisten-Pattern**: Für Listen von Karten (Kunden, Geburtstage, Termine, Leistungsnachweise) wird einheitlich `flex flex-col gap-3` statt `space-y-*` verwendet. Grund: `space-y` nutzt `margin-top`, das bei inline-Elementen (z.B. `<a>` von Link-Wrappern) nicht wirkt. `flex gap` funktioniert unabhängig vom Display-Typ der Kinder. Keine Hover-Effekte auf Karten (mobile-first App).
- **API Calls**: All state-changing API requests (POST, PATCH, DELETE) must use the central API client (`client/src/lib/api/client.ts`) for CSRF protection (Double-Submit Cookie Pattern). Direct `fetch()` calls for mutations will result in 403 errors.
- **Phone Number Handling**: Uses `libphonenumber-js` via `@shared/utils/phone.ts` for validating, formatting, and storing German phone numbers in E.164 format (`+49...`).
- **Type Organization**: Hierarchical type structure with `@shared/schema.ts` (Drizzle, Zod), `@shared/domain/*` (business logic, domain types), `@shared/utils/*` (utilities), and `@shared/types.ts` (re-exports for frontend).
- **Date-Validierung**: Zentraler Date-Validator in `@shared/utils/date-validation.ts` bietet:
  - `isValidISODate(dateString)` - Prüft ISO-Format "YYYY-MM-DD"
  - `parseISODate(dateString)` - Parst zu Date-Objekt
  - `formatToISODate(date)` - Formatiert Date zu ISO-String
  - `isoDateSchema` / `isoDateOptionalSchema` - Zod-Schemas für API-Validierung
  - `isDateInPast()`, `isDateToday()`, `isDateInFuture()` - Datum-Vergleiche

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
- **Shared Domain Logic**: Single source of truth for business rules in `@shared/domain/*` (e.g., appointment status transitions).
- **Termin-Status-Definitionen** (zentral in `@shared/domain/appointments.ts`):
  - `scheduled` - Geplant (noch nicht durchgeführt)
  - `in-progress` - Läuft gerade
  - `documenting` - Dokumentation wird ausgefüllt
  - `completed` - Abgeschlossen und dokumentiert
  - **Für Leistungsnachweise gilt**: Nur `completed` Termine gelten als "dokumentiert". Alle anderen Status blockieren die Erstellung eines Leistungsnachweises.
- **Leistungsnachweis-Workflow**:
  1. Termine durchführen und dokumentieren (Status → `completed`)
  2. Leistungsnachweis erstellen (wenn ALLE Termine des Monats `completed` sind)
  3. Mitarbeiter unterschreibt
  4. Kunde unterschreibt
  5. Status wechselt zu `completed`
- **Field Editing**: Rules govern which fields are editable based on appointment status.
- **Overlap Checking**: Logic for preventing appointment overlaps.
- **Service Model**: "Erstberatung" (initial consultation) is a core service type.
- **Customer Management**: Multi-step customer creation, detailed views, and German-specific validation (IK numbers, insurance numbers).
- **Budgeting & Pricing**: Supports various budget types and customer-specific service rates.
  - **§45b Budget Ledger System**: Ledger-based tracking for Entlastungsbetrag with allocations (monthly, carryover, initial, manual) and transactions (consumption at appointment completion, reversals).
  - **Automatic Budget Booking**: At appointment documentation, the system calculates costs based on: (Hauswirtschaft minutes × rate/h) + (Alltagsbegleitung minutes × rate/h) + (travel km × km rate) + (customer km × km rate).
  - **Carryover Rules**: §45b budget from previous year expires on June 30 of the following year. System warns about expiring carryover.
  - **Monthly Limits**: Optional customer preference for monthly usage limits with progress indicators and warnings.
  - **Pricing Requirement**: Appointment documentation requires a valid pricing agreement for the customer. Missing pricing blocks completion with an actionable error message.
- **Employee Time Tracking**: Comprehensive tracking for client and non-client work (vacation, sick leave, breaks, office work, etc.), including yearly vacation allowance and multi-day entries. Past entries are locked for non-admin users.
- **German Labor Law Compliance**: Automatic detection of missing break documentation based on work hours (`§4 ArbZG`).
- **Open Tasks System**: Dashboard banners alert employees to pending tasks like undocumented appointments or missing break documentation.
- **Customer Kilometers**: Tracking of kilometers driven with/for the customer ("Km für/mit Kunde") separate from travel kilometers.

## External Dependencies
- **Database**: PostgreSQL (via Neon serverless)
- **Frontend Libraries**: React, TypeScript, Vite, Wouter, `shadcn/ui`, Radix UI, Tailwind CSS v4, TanStack Query, Zod.
- **Backend Libraries**: Express.js, TypeScript, Zod, Drizzle ORM.