# Chunk 13 — Compliance: Month-Close & Audit-Trail

**Tiefenstufe:** Deep-Audit (Subagent-Lauf, alle 3 Phasen)
**Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Risiko:** HOCH
**LOC / Files:** 2 765 / 8

## Geprüfte Dateien

`server/services/month-close-scheduler.ts`, `server/services/audit.ts`,
`server/storage/time-tracking/month-closing.ts`, `server/routes/month-closing.ts`,
`server/routes/admin/audit.ts`, `server/startup/migrate-erstberatung-customers.ts`,
`client/src/pages/admin/month-closing.tsx`, `client/src/pages/admin/audit-log.tsx`.

## Findings

### HOCH

1. **GoBD-Immutability nur auf Anwendungs-Ebene erzwungen** — `audit_log` hat
   keinen DB-Trigger, der UPDATE/DELETE verbietet. Ein zukünftiger Storage-Fix
   oder ein Sql-Console-Eingriff durch SuperAdmin kann Audit-Einträge
   ändern. **Fix:** PostgreSQL-Trigger `audit_log_immutable` mit
   `RAISE EXCEPTION` auf UPDATE/DELETE.

2. **Reopen-Reason-Validierung asymmetrisch** — Frontend prüft `length ≥ 10`
   (`month-closing.tsx:266`), Backend (`server/routes/month-closing.ts:217`)
   nicht in `reopenMonthSchema`. Direkter API-Call umgeht die Pflicht-
   Begründung. **Fix:** `reopenMonthSchema.reason: z.string().min(10)` in
   `shared/schema`.

### MITTEL

3. **`expired_unsigned`-Status nicht durchgängig in Statistik-/Export-Pfaden
   ausgeschlossen** — `server/services/month-close-scheduler.ts:204` setzt den
   Status korrekt, aber wir verlassen uns darauf, dass jeder Read-Pfad explizit
   `status = 'completed'` filtert. Manche Queries filtern nur `deletedAt IS NULL`.
   **Fix:** Snapshot-Test, der einen `expired_unsigned`-Termin anlegt und
   sicherstellt, dass er in Lexware-Export, Cockpit-Stunden und Statistiken
   fehlt.

4. **`migrate-erstberatung-customers.ts:121` — Idempotenz-Risiko.**
   Halb-erfolgte Migration: setzt `customer_id = NULL` auf Appointments und
   `deleted_at = NOW()` auf Customers. Beim Neustart findet die Selektion die
   Kunden nicht mehr (`deleted_at IS NULL`), aber zurückgebliebene
   Appointments bleiben verwaist. **Fix:** Gesamter Loop in eine Transaktion,
   oder am Anfang ein `SELECT` mit Idempotenz-Marker.

### NIEDRIG

5. **Timezone-Drift im Scheduler** — `month-close-scheduler.ts:51` verlässt
   sich auf NTP. Kein Code-Fix nötig, aber Runbook: NTP-Health-Check
   ergänzen.

6. **`server/services/audit.ts:345` — Audit-Log-Pagination via OFFSET.**
   Bei wachsendem Log (GoBD: 10 Jahre Aufbewahrung) wird das langsam.
   **Fix:** Keyset-Pagination (`WHERE id < cursor ORDER BY id DESC LIMIT n`).

7. **System-Aktor-Fallback** — `findSystemActorId` greift zur „ersten aktiven
   User-Row", wenn kein Admin existiert. System-Aktionen werden so einem
   echten Mitarbeiter zugeordnet. **Fix:** Dedizierten System-User (z. B.
   `email='system@careconnect.internal'`) anlegen und in `audit.actorId`
   verwenden.

## Architect-Bewertung

Die GoBD-Implementierung ist konzeptionell sauber (Append-Only, Cutoff,
Historisierung). Die zwei HOCH-Findings adressieren echte Compliance-Lücken
(technische Immutability + Reason-Schwelle). Drei MITTEL-Findings sollten
in einem gemeinsamen Folge-Task gebündelt werden.

**Empfohlene Folge-Tasks:** 2.
