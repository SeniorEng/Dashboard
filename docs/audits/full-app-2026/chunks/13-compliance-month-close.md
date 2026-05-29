# Chunk 13 — Compliance / Month-Close (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep
**Skills:** Security · Business-Logic · Database

## Befunde

### HOCH-1 — GoBD-Audit-Log ohne technische Immutability
- **Fundstelle:** `server/services/audit.ts` (Insert-Pfad), `audit_log`-Tabelle
- **Problem:** Immutability nur konventionell (App bietet keine Delete-Route), aber der
  DB-App-User behält `UPDATE/DELETE`-Rechte auf `audit_log`. GoBD verlangt technische
  Unveränderbarkeit.
- **Fix-Richtung:** Migration `REVOKE UPDATE, DELETE ON TABLE audit_log FROM <app_user>`
  bzw. BEFORE-UPDATE/DELETE-Trigger, der wirft.
- **Effort:** M · **Folge-Task:** T-822-COMPLIANCE-01 · *(Vorgänger-Finding, STILL OPEN)*

### NIEDRIG — toISOString-Business-Date-Drift
- Mehrere Stellen nutzen `toISOString()` für Geschäftsdaten (siehe refactor-masterplan §4a).

## Positive Confirmations
- `reopenMonthSchema` erzwingt `reason .min(10)` serverseitig (`shared/schema/system.ts:66`) — **behoben**.
- Reopen nur für Superadmins (`month-closing.ts:217` `requireSuperAdmin`).
- `expired_unsigned` korrekt aus Lexware-Export + Statistiken ausgeschlossen
  (`status IN ('completed')`, `lexware-export.ts:156`).
- Auto-Close-Cutoff-Verschiebung (Wochenende/Feiertag) korrekt (`shared/utils/month-close-cutoff.ts`).
- Audit-Attribution (`req.user.id` + Ziel) bei Reopen/Close vorhanden.
