# Chunk 2 — Auth & Permissions

**Tiefenstufe:** Deep-Audit (Subagent-Lauf, alle 3 Phasen)
**Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Risiko:** HOCH
**LOC / Files:** 3 548 / 13

## Geprüfte Dateien

`server/routes/auth.ts`, `server/services/auth.ts`, `server/middleware/auth.ts`,
`server/middleware/csrf.ts`, `server/middleware/object-storage-auth.ts`,
`server/lib/params.ts`, `server/routes/admin/employee-users.ts`,
`client/src/hooks/use-auth.tsx`, `client/src/pages/{login,forgot-password,reset-password,setup}.tsx`,
`client/src/components/session-timeout-warning.tsx`.

## Findings

### KRITISCH

1. **`server/routes/admin/employee-users.ts:398` — Bypass der Rollen-Mutation-Restriction.**
   Ein normaler Admin kann via `setUserRoles` eigene Rollen oder die anderer
   Admins/Superadmins ändern; der `updateUser`-Pfad schützt nur `isAdmin`/`isTeamLead`,
   nicht `isSuperAdmin`. **Fix:** Vor `setUserRoles` prüfen
   `!req.user.isSuperAdmin && isPrivilegedTarget(targetUser)` → 403.

2. **`server/middleware/csrf.ts:48` — CSRF-Token-Fixation.**
   Bei einem POST ohne Cookie wird ein neuer Cookie gesetzt UND 403
   zurückgegeben. Ein Angreifer kann so einem Opfer einen bekannten CSRF-Cookie
   unterschieben. **Fix:** Cookies nur auf safe-method (GET) oder beim Login/
   Session-Refresh ausstellen.

3. **`server/routes/auth.ts:34` — Login ohne CSRF-Schutz und ohne klare
   Cookie-Regeneration.**
   Ggf. uncritical, weil Login per se Credential-Check macht, aber subsequente
   State-Changes verlassen sich auf Login-gesetzten CSRF-Cookie.
   **Fix:** Beim erfolgreichen Login Session + CSRF-Cookie regenerieren
   (Session-Fixation-Defense).

### HOCH

4. **Letzter-Admin-Schutz fehlt** (`employee-users.ts:281`). Ein einzelner
   SuperAdmin kann sich selbst die SuperAdmin-Rolle entziehen → System
   gesperrt. **Fix:** Vor jedem Demote/Deaktiv prüfen, ob das System danach
   noch ≥1 SuperAdmin und ≥1 Admin hat.

5. **`server/services/auth.ts:623` — Reset-Token-Race ohne Atomic-Check-and-Set.**
   `resetPassword` prüft `usedAt`, setzt es danach, aber nicht in derselben
   Transaktion. Parallele Doppel-Requests können beide passieren. **Fix:**
   Ganze `resetPassword` in `db.transaction` + `UPDATE … WHERE used_at IS NULL`.

6. **`server/middleware/object-storage-auth.ts:112` — Object-Storage-Privilege.**
   Mitarbeiter dürfen jedes `generated_documents` mit `customerId = NULL` und
   passender `employeeId` lesen — auch potenziell sensitive interne Reports.
   **Fix:** `checkEmployeeAccess` auf spezifische Document-Types einschränken.

### MITTEL

7. **`server/lib/params.ts:7` — `requireIntParam` akzeptiert negative IDs.**
   `parseInt("-1") = -1` passt Type-Check. Bei Serial-IDs unkritisch, aber
   defensiv zu fixen. **Fix:** `if (parsed <= 0) return null;`.

8. **Client/Server-Drift bei Passwort-Validierung** (`reset-password.tsx:47` vs
   `shared/schema/users.ts:219`). Frontend prüft nur Länge, Backend Regex →
   schlechte UX. **Fix:** Client-Validation an `passwordResetSchema` ausrichten.

9. **`server/services/auth.ts:237` — Absolute-Timeout vs `touchSession`.**
   `touchSession` (Keepalive) updated nur `lastActivityAt`, ignoriert
   `absoluteExpiresAt`. Sessions können theoretisch ewig leben.
   **Fix:** In `touchSession` zusätzlich `absoluteExpiresAt` prüfen.

### NIEDRIG

10. **`server/index.ts:55` — Rate-Limit-Skip für `/api/auth/*`** öffnet
    `/auth/me`, `/auth/session-info` für Spam. **Fix:** Baseline-`apiLimiter`
    auch dort wirken lassen, spezifische Login-Limiter dann oben drauf.

11. **`server/routes/auth.ts:40` — Zod-Fehler-Detail-Leak** beim Login.
    **Fix:** Bei Auth-Routes nur generische Fehler nach außen.

12. **Reset-Token im URL-Query** (`reset-password?token=…`). Bei externen
    Links Referer-Leak möglich. **Fix:** Meta-Tag `Referrer-Policy: no-referrer`
    auf Reset-Seite, oder Token nur im POST-Body finalisieren.

## Architect-Bewertung

Findings sind konsistent mit OWASP ASVS 5.0 (Auth/Session-Sektionen 2.1–2.10)
und Threat-Model-Boundary „Spoofing"/„Elevation of Privilege".
**Empfohlene Folge-Tasks:** 4 (siehe `REPORT.md` Tabelle).
