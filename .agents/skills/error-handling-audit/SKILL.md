---
name: error-handling-audit
description: Automated error handling audit that validates every mutation, API route, and error flow follows the project's error handling conventions. Use after adding new API routes, mutations, or modifying error handling. Ensures users always see specific, actionable German error messages instead of generic failures.
---

# Error Handling Audit Agent

## Purpose
Validates that every error path in the application provides specific, actionable feedback to the user — in German. Generic "Fehler" messages without context are unacceptable. Every error the user sees must help them understand WHAT went wrong and ideally HOW to fix it.

## Architecture Overview

The error handling system has 4 layers:

### Layer 1: Backend — `asyncHandler` + `AppError` (`server/lib/errors.ts`)
- **`asyncHandler(defaultMessage, handler)`** wraps every Express route
- Catches `AppError` (business logic) → forwards with specific message
- Catches `ZodError` (validation) → converts to readable German validation error
- Catches known DB errors via `extractUserFriendlyDbError()` → translates PostgreSQL error codes to German messages
- Unknown errors → logs full error server-side, returns `defaultMessage` to client (security: no internal details leaked)
- **DB Error Code Mapping** (PostgreSQL codes):
  - `22P02` (invalid_text_representation) → "Ungültiger Wert — bitte prüfen Sie Ihre Eingaben"
  - `23505` (unique_violation) → "Ein Eintrag mit diesen Daten existiert bereits"
  - `23503` (foreign_key_violation) → "Ein referenzierter Datensatz wurde nicht gefunden"
  - `23502` (not_null_violation) → "Ein Pflichtfeld wurde nicht ausgefüllt"
  - `22003` (numeric_value_out_of_range) → "Ein eingegebener Wert ist zu groß oder zu klein"

### Layer 2: API Client (`client/src/lib/api/client.ts`)
- `parseErrorResponse()` extracts message from backend JSON (`data.message` → `data.error` → `data.error.message`)
- Falls back to `"Ein unbekannter Fehler ist aufgetreten"`
- `ApiError` class carries the message to `react-query` `onError` callbacks
- Retry logic for transient errors (408, 429, 500, 502, 503, 504)

### Layer 3: Frontend Mutations — `useMutation` + `onError` + `toast`
- **Every `useMutation` MUST have an `onError` handler**
- **Every `onError` MUST show a toast with `error.message`** (which comes from the backend)
- Pattern:
  ```typescript
  onError: (error: Error) => {
    toast({
      title: "Fehler",
      description: error.message,
      variant: "destructive",
    });
  },
  ```
- **NEVER use hardcoded generic messages** like `"Fehler beim Speichern"` in `onError` — always use `error.message` from the API response
- **Title "Fehler"** is acceptable as a category, but `description` MUST always be `error.message`

### Layer 4: Global Safety Nets
- `ErrorBoundary` (`client/src/components/error-boundary.tsx`) — catches React render crashes
- `ErrorState` (`client/src/components/patterns/error-state.tsx`) — reusable error display for query failures
- These are last-resort fallbacks, NOT a substitute for proper error handling

---

## Audit Checklist

### Category 1: Backend Routes (CRITICAL)
For every route in `server/routes/`:
- [ ] Route is wrapped in `asyncHandler(defaultMessage, handler)`
- [ ] `defaultMessage` is specific and in German (e.g., "Termin konnte nicht erstellt werden", NOT "Server error")
- [ ] Business logic errors throw `AppError` with specific German messages via `badRequest()`, `notFound()`, `forbidden()`, or `conflict()`
- [ ] Zod validation uses schemas with German `.message()` strings
- [ ] No raw `res.status(500).json({...})` — all errors flow through `asyncHandler`

### Category 2: Frontend Mutations (CRITICAL)
For every `useMutation` in `client/src/`:
- [ ] Has an `onError` handler — mutations without `onError` fail SILENTLY
- [ ] `onError` shows a toast with `description: error.message`
- [ ] Does NOT use hardcoded error messages that override the API response
- [ ] `onSuccess` shows a specific success toast in German

### Category 3: Zod Schemas (HIGH)
For every Zod schema in `shared/schema/`:
- [ ] Validation messages are in German
- [ ] Min/max constraints have descriptive messages (e.g., `.min(1, "Mindestens ein Service muss dokumentiert werden")`)
- [ ] Custom refinements have German `message` strings

### Category 4: DB Error Coverage (MEDIUM)
- [ ] `extractUserFriendlyDbError()` in `server/lib/errors.ts` covers all PostgreSQL error codes that can realistically occur
- [ ] New DB constraints (unique indexes, foreign keys, check constraints) have corresponding user-friendly messages

### Category 5: Silent Error Patterns (HIGH)
- [ ] No empty `catch {}` blocks that swallow errors (except intentional background tasks like session keep-alive)
- [ ] No `console.error()` without user notification
- [ ] No `.catch(() => {})` on promises that should notify the user

### Category 6: Error Message Quality (MEDIUM)
- [ ] All user-facing error messages are in German
- [ ] Messages describe WHAT went wrong, not internal technical details
- [ ] Messages suggest a resolution where possible (e.g., "Bitte laden Sie die Seite neu")
- [ ] No English error messages leak to the UI

### Category 7: Graceful Degradation (MEDIUM)
**Goal**: When external services fail, the app degrades gracefully instead of crashing.

For each external dependency, verify fallback behavior:

1. **Database connection failure (Neon driver crash pattern)**:
   ```bash
   # Check for connection error handling
   grep -rn "connect\|pool\|neon\|DATABASE_URL" server/ --include="*.ts" | grep -i "error\|catch\|retry\|fail"
   
   # CRITICAL: Check Neon driver crash suppression is still in place
   grep -rn "isNeonDriverBug\|uncaughtException\|unhandledRejection" server/index.ts
   ```
   - Verify: DB connection failures show "Datenbankverbindung fehlgeschlagen. Bitte versuchen Sie es in wenigen Minuten erneut."
   - Verify: App doesn't crash on DB timeout — returns 503 with retry-after header
   - **Known pattern**: Neon WebSocket driver throws `TypeError: Cannot set property message of #<ErrorEvent>` on connection timeout — this MUST be caught by `isNeonDriverBug()` in `server/index.ts` uncaughtException/unhandledRejection handlers. If this suppression is removed, DB timeouts will crash the entire server.

2. **Background task resilience (withTimeout pattern)**:
   ```bash
   # Check that fire-and-forget DB calls in webhook handlers use withTimeout
   grep -rn "withTimeout\|safeAddNote" server/services/twilio-call-bridge.ts server/services/lead-auto-reply.ts
   
   # Check the utility exists
   grep -rn "withTimeout" server/lib/with-timeout.ts
   ```
   - Verify: All fire-and-forget DB calls in webhook background tasks are wrapped with `withTimeout()` (10s recommended)
   - Verify: `safeAddNote()` helper is used for non-critical note additions that should never crash the request
   - Verify: Background tasks (Twilio calls, lead auto-replies) cannot hang or crash due to DB hiccups
   - **Known pattern**: Webhook handlers (e.g., new lead from email) trigger background DB operations. Without `withTimeout`, a DB timeout can hang the webhook response indefinitely or crash via unhandled rejection.

3. **Geocoding service failure**:
   ```bash
   grep -rn "geocod\|nominatim\|coordinates\|latitude\|longitude" server/ --include="*.ts" | grep -i "error\|catch\|fail"
   ```
   - Verify: Geocoding failure doesn't block appointment creation
   - Verify: Missing coordinates show "Adresse konnte nicht geocodiert werden" (non-blocking warning)

4. **External API failures** (Twilio, email, etc.):
   ```bash
   grep -rn "fetch\|axios\|https\.\|http\.\|twilio\|Twilio" server/ --include="*.ts" | grep -v "node_modules"
   ```
   - Verify: Each external call has a timeout
   - Verify: Failures are caught and produce user-friendly messages
   - Verify: Critical operations don't depend on non-critical external services
   - Verify: Twilio call failures don't block lead processing

5. **Error recovery UX**:
   ```bash
   # Check if forms preserve user input on error
   grep -rn "reset()\|resetForm\|form\.reset" client/src/ --include="*.tsx" --include="*.ts"
   ```
   - Verify: After a submission error, the form retains the user's input (not cleared)
   - Verify: User can retry without re-entering data
   - Verify: Error toasts have a "Erneut versuchen" action where applicable

5. **Structured error logging**:
   ```bash
   # Check server-side error logging includes context
   grep -rn "console\.error\|console\.warn" server/ --include="*.ts" -A1 | head -30
   ```
   - Verify: Server errors are logged with sufficient context for debugging:
     - Request endpoint and method
     - User ID (if authenticated)
     - Relevant entity IDs (appointmentId, customerId)
     - Error message and stack trace
   - Verify: No personally identifiable information (PII) in error logs (names, addresses — IDs are OK)

### Red Flags (Graceful Degradation):
- External service failure crashes the app → FAIL
- `isNeonDriverBug()` suppression removed from `server/index.ts` → FAIL (will crash on DB timeout)
- Fire-and-forget DB call in webhook handler without `withTimeout()` → FAIL (can hang or crash)
- Form data lost after submission error → FAIL
- No timeout on external API calls → WARN
- Error logged without request context → WARN
- PII in error logs → FAIL

---

## How to Run This Audit

When triggered (after adding routes, mutations, or modifying error handling):

1. **Scan backend routes**: `grep -rn "asyncHandler\|router\.\(get\|post\|put\|patch\|delete\)" server/routes/`
2. **Scan frontend mutations**: `grep -rn "useMutation" client/src/`
3. **Find missing onError**: For each `useMutation`, check if `onError` exists within the same hook
4. **Find generic messages**: `grep -rn "title: \"Fehler\"" client/src/` — verify each has a `description: error.message`
5. **Find silent catches**: `grep -rn "catch\s*{}" client/src/ server/` — verify each is intentional
6. **Find hardcoded error strings**: Look for `description: "Fehler beim..."` patterns that ignore `error.message`
7. **Check form recovery**: Verify forms don't reset on error

## Severity Levels

| Severity | Pattern | Example |
|----------|---------|---------|
| **CRITICAL** | Missing `onError` on mutation | User clicks "Speichern", nothing happens, no feedback |
| **CRITICAL** | Empty `catch {}` on user action | Error swallowed, user confused |
| **CRITICAL** | External failure crashes app | Geocoding down → all appointments fail |
| **HIGH** | Hardcoded generic message instead of `error.message` | "Fehler beim Speichern" when API says "Budget reicht nicht aus" |
| **HIGH** | English error message shown to user | "Server error" instead of German |
| **HIGH** | Form data lost on error | User types 5 minutes of notes, error, notes gone |
| **MEDIUM** | Missing Zod German message | Technical Zod output like "Expected number, received string" |
| **MEDIUM** | Error logged without context | `console.error(err)` without endpoint/user info |
| **LOW** | Success toast missing | Action succeeds but no confirmation |

## Key Files
- `server/lib/errors.ts` — Central error handling, `asyncHandler`, DB error mapping
- `client/src/lib/api/client.ts` — API client, error parsing
- `client/src/hooks/use-toast.ts` — Toast notification system
- `shared/schema/*.ts` — Zod validation schemas
