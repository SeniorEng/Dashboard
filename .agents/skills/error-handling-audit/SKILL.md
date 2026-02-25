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

---

## How to Run This Audit

When triggered (after adding routes, mutations, or modifying error handling):

1. **Scan backend routes**: `grep -rn "asyncHandler\|router\.\(get\|post\|put\|patch\|delete\)" server/routes/`
2. **Scan frontend mutations**: `grep -rn "useMutation" client/src/`
3. **Find missing onError**: For each `useMutation`, check if `onError` exists within the same hook
4. **Find generic messages**: `grep -rn "title: \"Fehler\"" client/src/` — verify each has a `description: error.message`
5. **Find silent catches**: `grep -rn "catch\s*{}" client/src/ server/` — verify each is intentional
6. **Find hardcoded error strings**: Look for `description: "Fehler beim..."` patterns that ignore `error.message`

## Severity Levels

| Severity | Pattern | Example |
|----------|---------|---------|
| **CRITICAL** | Missing `onError` on mutation | User clicks "Speichern", nothing happens, no feedback |
| **CRITICAL** | Empty `catch {}` on user action | Error swallowed, user confused |
| **HIGH** | Hardcoded generic message instead of `error.message` | "Fehler beim Speichern" when API says "Budget reicht nicht aus" |
| **HIGH** | English error message shown to user | "Server error" instead of German |
| **MEDIUM** | Missing Zod German message | Technical Zod output like "Expected number, received string" |
| **LOW** | Success toast missing | Action succeeds but no confirmation |

## Key Files
- `server/lib/errors.ts` — Central error handling, `asyncHandler`, DB error mapping
- `client/src/lib/api/client.ts` — API client, error parsing
- `client/src/hooks/use-toast.ts` — Toast notification system
- `shared/schema/*.ts` — Zod validation schemas
