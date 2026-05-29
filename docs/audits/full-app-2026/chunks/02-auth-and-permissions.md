# Chunk 2 — Auth & Permissions (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep
**Skills:** Security · Regression-Guard

## Befunde
Keine offenen KRITISCH/HOCH-Findings. Alle Vorgänger-KRITISCH dieser Domäne behoben.

### NIEDRIG-1 — IDOR-Pfade (verifiziert OK, Beobachtung)
- `server/lib/params.ts` — `requireCustomerAccess`/`requireCustomerReadAccess` prüfen
  Zuweisungen für Nicht-Admins serverseitig. Empfehlung: Beibehaltung als Pflicht-Pattern
  bei jedem neuen ID-Parameter-Endpunkt.

## Status Vorgänger-KRITISCH/HOCH (alle verifiziert FIXED)
- **setUserRoles-Hierarchie (K1):** FIXED — `employee-users.ts:342` `denyIfPrivilegedTarget`.
- **CSRF-Token-Fixation (K2):** FIXED — `csrf.ts:48` kein Cookie-Set bei 403.
- **Login CSRF-Rotation/Session-Fixation (K7):** FIXED — `auth.ts:64-68` Logout-Vorsession + `setCsrfCookie(generateCsrfToken())`.
- **Letzter-Admin-Schutz:** FIXED — `employee-users.ts:281` Self-Demote-Block.
- **Password-Reset-Token:** FIXED — `randomBytes(32)`, gehasht in DB, `usedAt`-Check (one-time + expiry).
- **Session-Timeout:** FIXED — Idle 30 min / Absolut 12 h (`auth.ts:21`).
