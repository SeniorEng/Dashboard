# Phase 1 – Strukturelle Fakten

**Datum:** 24.04.2026
**Skills:** code-quality-supervisor, database-audit
**Diff-Basis:** `9930d33~10..9930d33` (Tasks #170, #171, #173–#177)

## Code Quality Supervisor

### Konventions-Compliance
- ✅ `csrfProtection` ist global ab `server/routes/index.ts:94` aktiv (alle Mutations-Routes nach `/auth` und `/webhook` werden abgedeckt). Die einzelnen `csrfProtection`-Decorations in `server/routes/auth.ts` sind Zusatz-Schutz für die wenigen Mutations-Endpoints, die VOR der globalen Middleware gemountet sind. **Kein Routes-Bypass entdeckt.**
- ✅ Alle Auth-relevanten Routes nutzen `requireAuth` / `requireAdmin` / `requireSuperAdmin` Middleware.
- ✅ Test-Cleanup-Endpoint (`server/routes/admin/test-cleanup.ts`) ist konsequent durch `if (process.env.NODE_ENV === "production") return 403;` gesichert (Zeilen 81 und 121).
- ✅ Geocoding-Helfer `ensureEmployeeGeocoded` ist sauber dokumentiert (JSDoc), idempotent (`inFlightEmployeeGeocodes`-Set), und fire-and-forget mit Error-Logging.

### Dead Code / Unused Exports (knip 6.6.3)
56 unused exports gefunden. **Auffällig (mehr als kosmetisch):**
| Datei | Symbol | Bewertung |
|---|---|---|
| `server/routes/appointments.ts:83` | `checkCustomerAccess` | Exportiert, im Modul aber nicht mehr referenziert → entweder Dead Code oder Helper für künftige Refactors |
| `client/src/lib/api/client.ts:140` | `apiRequest` | Doppelt exportiert (auch in `client/src/lib/api/index.ts:9`) — vermutlich Migrations-Rest |
| `server/services/appointments.ts:83` | `class AppointmentService` | Komplette Klasse ungenutzt → Hinweis auf abgeschlossene Migration zur Storage-Schicht |
| `server/services/auth.ts:76` | `class AuthService` | Komplette Klasse ungenutzt — aber **gleichzeitig in `server/index.ts:249` benutzt** (`authService.cleanupExpiredSessions`) — knip-False-Positive durch dynamisches `await import()` |
| `server/services/whatsapp-service.ts:37` | `class WhatsAppService` | Klasse ungenutzt (Service ist deaktiviert?) |
| `server/storage.ts:200` | `class DatabaseStorage` | Komplette Klasse ungenutzt — Hinweis auf Migration zur modularen Storage-Schicht |
| `server/storage/budget/cap-calculator.ts` | `getMonthRange`, `getYearRange`, `netConsumedInRange` | drei Helper exportiert, intern genutzt → **bewusst exportiert für Tests, OK** |

**Beobachtung:** Mehrere große Klassen (`AppointmentService`, `DatabaseStorage`) deuten auf eine erfolgreiche, aber unaufgeräumte Migration zu modularen Storage-Files hin. Reines Aufräumen, keine funktionale Wirkung. → MITTEL/NIEDRIG.

### Dateigrößen-Hotspots
- `server/routes/appointments.ts`: 1168 Zeilen — sehr groß, aber funktional segmentiert.
- `client/src/pages/dashboard.tsx`: 879 Zeilen — Wochenleiste/Picker/MonthYearPicker inline → könnte in Sub-Komponenten ausgelagert werden.
- Kein Hotspot >2000 Zeilen.

### Konventions-Verstöße
- Keine. `data-testid` ist überall konsistent verwendet, deutsche Fehlertexte überall.

## Database Audit

### Schema-Konsistenz
- ✅ Alle Tabellen nutzen `serial`/`varchar`-Primary-Keys konsistent (kein ID-Typ-Wechsel im Diff).
- ✅ 20 `createInsertSchema`-Definitionen in `shared/schema/` decken die wichtigsten Tabellen ab.
- ✅ Indexe für die im Diff angefassten Felder sind vorhanden (`users.is_admin`, `appointments.assigned_employee_id`, `appointments.date`).

### Storage-Layer
- ✅ Neuer Endpoint `/admin/test-cleanup/purge-admin-calendar-range` benutzt `db.transaction(...)` und löscht in der korrekten FK-Reihenfolge (siehe `purgeCustomerCascade`).
- ✅ `budgetTransactions.appointmentId` wird vor dem Termin-Delete via `update().set({ appointmentId: null })` entkoppelt → keine FK-Verletzung, keine ungewollte Budget-Buchungs-Löschung.
- ⚠️ `addressSearchCache` (in `server/routes/index.ts`) ist eine modul-lokale `Map<string, …>` mit hartem Limit (200 Einträge, 50er-Batch-Eviction, 60s TTL). Sauber implementiert, aber Eviction ist FIFO-artig, nicht echt LRU. Bei sehr vielen unique queries könnte ein häufig genutzter Eintrag verdrängt werden. → NIEDRIG.

### N+1-Risiken im Diff
- Kein N+1 im Diff entdeckt. `getCachedCompanySettings()` und `req.user.latitude/longitude` werden je Request einmal genutzt.

### Migration-Status
- 16 bekannte tsc-Errors aus dem Server-Layer (siehe bereits offener Task). **Nicht im Audit-Scope, aber erwähnenswert** — kann statische Konsistenz-Checks sabotieren.

## Cross-Cutting Beobachtungen für Phase 2/3

1. **Wochenend-Sperre ist inkonsistent**: 
   - `POST /kundentermin` (Zeile 439): `if (!user.isAdmin && isWeekend(...))` ✅
   - `POST /prospect-erstberatung` (Zeile 578): `if (isWeekend(...))` ❌ — kein Admin-Bypass
   - `PATCH /:id` (Zeile 712): `if (validatedData.date && isWeekend(...))` ❌ — kein Admin-Bypass
   - Frontend (`dashboard.tsx:570`) erlaubt korrekt `isAdmin || !isSelectedWeekend`. → Bei einem Admin-Workflow, der die UI umgeht (oder bei Erstberatung am Wochenende), schlägt das Backend fehl. **HOCH** — Folge-Task.

2. **Address-Search Filter zu strikt**: `r.address.road || pedestrian || footway || path` filtert Nominatim-Treffer ohne Straßenname raus. `"Berlin Alexanderplatz"` liefert nur 1 Treffer (statt 5–8). → **HOCH** — UX-Regression seit #174.

3. **Listen-Endpoints ohne Pagination liefern Riesen-Payloads**:
   - `GET /api/customers` → 1,9 MB
   - `GET /api/admin/users` → 1,8 MB  
   - `GET /api/appointments?startDate=…&endDate=…` (1 Woche!) → 1,4 MB
   - Performance-Audit (Phase 2) muss das vertiefen. **HOCH**.

4. **Geocoding-Background-Job hat keinen Backoff**: `ensureEmployeeGeocoded` deduplicated zwar pro Prozess, aber wenn die Geocodierung scheitert (z. B. Nominatim 503), wird beim nächsten Login/Address-Search erneut versucht — ohne Cooldown. → MITTEL.

5. **Drizzle-ORM 0.39.3 mit HIGH-CVE** (GHSA-gpj5-g38j-94v9, SQL-Injection via Identifier): grep zeigt **keinen** Codepfad, der `sql.identifier()` mit User-Input nutzt → praktisch nicht ausnutzbar in diesem Codebase. Trotzdem: **HOCH** als Defense-in-Depth.
