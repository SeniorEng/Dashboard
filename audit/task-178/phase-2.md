# Phase 2 – Tiefe Domänenanalyse

**Datum:** 24.04.2026
**Skills:** business-logic-audit, error-handling-audit, security-audit, performance-audit
**Eingangskontext:** Phase 1 (siehe `phase-1.md`), insb. die fünf Cross-Cutting-Punkte am Ende.

## Business Logic Audit

### Wochenend-Sperre (Task #175)
- **Backend-Inkonsistenz** (siehe Phase 1, Punkt 1):
  - `POST /kundentermin` lässt Admins durch, `POST /prospect-erstberatung` nicht, `PATCH /:id` nicht.
  - Konkretes Szenario: Ein Admin will einen am Donnerstag angelegten Termin auf Samstag verschieben → Backend wirft "Termine können nicht an Samstagen oder Sonntagen erstellt werden", obwohl die Wochenend-Sperre Mitarbeiter-only ist.
  - **HOCH** → Folge-Task: Admin-Bypass auf alle drei Stellen vereinheitlichen, Helper extrahieren (`assertWeekendAllowed(user, date)`).

### Geocoding-Pipeline (Task #173)
- ✅ `geocodeEmployee` hat Early-Return wenn `latitude/longitude` schon gesetzt → keine Doppel-Geocodierung.
- ✅ `sessionCache.invalidateByUserId(userId)` wird nach erfolgreicher Geocodierung aufgerufen → Session-User wird beim nächsten `/me` mit Koordinaten geliefert.
- ⚠️ `ensureEmployeeGeocoded` wird in `/login` UND in `/address-search` aufgerufen. Bei einem schnellen Login-Address-Search-Login-Workflow könnte derselbe Background-Job zweimal angestoßen werden, wird aber durch `inFlightEmployeeGeocodes` deduplicated. **OK**.
- ⚠️ Kein Retry-Backoff bei wiederholten Fehlern — sollte ein Fehler mehrfach auftreten (z. B. unauffindbare Adresse), bleibt der User dauerhaft ohne Koordinaten und triggert bei jedem Login einen erfolglosen Versuch. → NIEDRIG.

### Adresssuche-Bias (Task #171/#174)
- Bias kommt aus `req.user.latitude/longitude` (Mitarbeiter-Standort) oder Fallback auf `companySettings.latitude/longitude`. Wenn keiner gesetzt: keine Bias-Box.
- ⚠️ Cache-Key `${q}|${biasLat:0.01}|${biasLon:0.01}` rundet auf 2 Nachkommastellen (~1,1 km) → Mitarbeiter im selben Wohnort teilen sich den Cache → **gewünschte Effekt-Vergrößerung**, aber bei sehr unterschiedlichen Mitarbeitern in der gleichen Großstadt-Bias-Box gibt's identische Trefferlisten. → NIEDRIG.

### Budget / Abrechnung (Always-On HOCH)
- Stichprobe `GET /api/budget/9650/overview`: liefert `availableAfterPlannedCents: -578200` (negativ) — bedeutet, dass geplante Termine das Budget überschreiten. Das ist **fachlich korrekt**, der Wert dient der Vorausplanung und soll im Frontend als Warnung angezeigt werden.
- Bekannte offene Tasks: "Budget-Startwert Redesign" (Konzept), "Budget-Warnung False-Positive Fix" — werden NICHT dupliziert.

### Service-Records / Signaturen (Always-On HOCH)
- `POST /service-records/:id/sign` benutzt `signatureData, signerType, req.user!.id, signingIp, signingLocation`. Stichprobe Code: Speichert IP via `req.ip`, hash-basierte Integrität in `signature-integrity.ts`.
- ✅ Keine offenen, sicherheitskritischen Befunde im Diff dieser Session.

## Error Handling Audit

- ✅ Alle Routes nutzen `asyncHandler("Deutsche Fehlermeldung", async (req, res) => …)` als Wrapper. → Keine unhandled promise rejections in den Routes.
- ✅ Globale `errorMiddleware` (`server/lib/errors.ts`) wird in `server/index.ts:129` registriert.
- ✅ `process.on("unhandledRejection")` und `process.on("uncaughtException")` in `server/index.ts:96-114` mit Neon-Driver-Bug-Filter (`isNeonDriverBug`) → Server crasht nicht bei DB-Timeouts.
- ✅ Geocoding-Background-Job fängt Errors ab und loggt sie ohne den Request-Flow zu killen.
- ⚠️ `runStartupTasks` schluckt manche Fehler in `catch`-Blöcken nur mit Log (z. B. `migrateBudgetSources`, `migrateErstberatungCustomers`). Server startet trotzdem — **gewünscht** (Robustheit), aber Fehler könnten in Produktion unbemerkt bleiben, falls keine zentrale Log-Aggregation. → MITTEL.
- ⚠️ Frontend `address-autocomplete.tsx`: bei API-Fehler wird `setSuggestions([])` und `setIsOpen(false)` gesetzt, aber **kein** Toast → User sieht stillen Fail. Das ist hier akzeptabel (Nominatim-Outage soll nicht stören), aber im Fehlerfall könnte ein dezenter Hinweis "Adressdienst gerade nicht erreichbar" hilfreich sein. → NIEDRIG.

## Security Audit

| Kategorie | Status | Details |
|---|---|---|
| 1. Auth & Sessions | PASS | bcrypt-Hashing, httpOnly+secure+sameSite-strict Cookies, Session-Cleanup-Job alle 60min, login-Limit 10/15min in Prod, password-reset 3/h. |
| 2. CSRF | PASS | Globale Middleware ab `routes/index.ts:94`, Webhooks explizit ausgenommen, double-submit-Cookie-Pattern. |
| 3. Input Validation | PASS | Zod überall, keine `req.body`-Spread-Patterns, keine raw SQL mit Template-Literals (`grep`). |
| 4. Secret Safety | PASS | Alle Secrets via `process.env`, keine hardcoded Keys, `sanitizeUser()` entfernt `passwordHash` aus Responses. |
| 5. Access Control | PASS | `requireAdmin`/`requireSuperAdmin` an allen Admin-Routes, `checkCustomerAccess` für Customer-scoped Resources. |
| 6. **Dependencies** | **FAIL** | Siehe Tabelle unten. |
| 7. DSGVO | PASS | Soft-Delete bei Mitarbeitern (`anonymized_…@deleted.local`), Audit-Trail über `audit.ts`. |
| 8. API-OWASP-Top-10 | WARN | API4 (Resource Consumption) verletzt: Listen-Endpoints ohne Pagination, siehe Performance-Audit. |

### npm audit Findings
| Paket | Sev | CVE / Hinweis | Auswirkung Prod | Empfehlung |
|---|---|---|---|---|
| **drizzle-orm 0.39.3** | **HIGH** | GHSA-gpj5-g38j-94v9 (SQL-Injection via `sql.identifier`) | Kein Codepfad nutzt `sql.identifier`/`sql.raw` mit User-Input → **nicht ausnutzbar**, aber Defense-in-Depth | Upgrade auf 0.45.2 (breaking) als HOCH-Task |
| @google-cloud/storage | moderate | Transitive `@tootallnate/once`/`http-proxy-agent` | Nur bei GCS-Zugriff (Logo-Upload) → kleine Angriffsfläche | Mitnehmen mit drizzle-Upgrade |
| @tootallnate/once | low | Incorrect Control Flow Scoping | Indirekt via GCS | s.o. |
| fast-xml-parser | moderate | XMLBuilder Injection (via node-zugferd) | Nur bei ZUGFeRD-XML-Generierung in Rechnungs-PDFs → kontrollierte Eingaben | Workaround: input-sanitisierung in `lib/zugferd.ts` prüfen — **nice-to-fix**, no upstream fix yet |
| @esbuild-kit/* | moderate | dev only (drizzle-kit) | keine Prod-Auswirkung | optional |

### Offene Auth/Session-Beobachtungen
- `/api/auth/me`, `/api/auth/session-info`, `/api/auth/keepalive` sind durch `apiLimiter` nicht abgedeckt (Skip via `req.path.startsWith("/api/auth/")`). Sie sind aber `requireAuth`-geschützt → DoS-Risiko gering. → NIEDRIG.

## Performance Audit

| Kategorie | Status | Details |
|---|---|---|
| 1. Query Performance | PASS | Diff zeigt keine N+1, alle Joins indexiert. |
| 2. Frontend Rendering | WARN | `dashboard.tsx` (879 Z.) und `appointments.ts` (1168 Z.) sind Hotspots, aber funktionsfähig. `MonthYearPicker` ist eingebaute Sub-Komponente — OK. |
| 3. Bundle Size | (nicht vermessen) | npm run build nicht im Audit-Lauf — separater Task. |
| 4. **Network/API** | **FAIL** | **Listen-Endpoints liefern 1,4–1,9 MB ohne Pagination.** |
| 5. Mobile / CWV | WARN | Skeleton vorhanden, viewport meta gesetzt, aber große Initial-Payloads würden auf 3G stark spürbar sein. |
| 6. Memory Leaks | PASS | `intervals[]`/`timeouts[]` werden in `gracefulShutdown` cleared. `addressSearchCache` hat Limit. `inFlightEmployeeGeocodes` wird im `finally` cleared. |

### Detail Network/API
| Endpoint | Größe | Beobachtung |
|---|---|---|
| `GET /api/appointments?startDate=2026-04-20&endDate=2026-04-26` | **1,4 MB** | Eine Woche → liefert vermutlich auch verknüpfte Customer/Service-Daten |
| `GET /api/customers` | **1,9 MB** | Komplette Kundenliste mit allen Feldern |
| `GET /api/admin/users` | **1,8 MB** | Komplette User-Liste (auch anonymisierte deleted-Users) |
| `GET /api/budget/9650/overview` | 690 B | OK |
| `GET /api/address-search?q=Berlin+Alexanderplatz` | 233 B | OK (1 Treffer, siehe Phase 1 Punkt 2) |

→ **HOCH** — Pagination/Server-side-Filterung ist hier wichtigster Performance-Hebel für Mobile-Pflegekräfte.

### Adresssuche
- 1.95 s uncached (Nominatim ~1,5 s + Rate-Limit-Wait) → mit Cache <10 ms.
- `rateLimitChain` (Promise-Chain-Lock) verhindert Burst-Überschreitung des 1-req/s-Limits korrekt.
- ⚠️ Bei Cache-Miss-Sturm (z. B. 5 verschiedene Queries gleichzeitig) blockieren die Requests sequenziell auf der Promise-Chain. Worst-Case 5 Requests = 5,5 s — akzeptabel (Nominatim-Compliance).

## Cross-Cutting Beobachtungen für Phase 3

1. **HOCH-Findings konsolidiert:**
   - Wochenend-Sperre Backend-Inkonsistenz (Business + UX-Risiko)
   - Listen-Endpoints ohne Pagination (Performance + Mobile UX)
   - drizzle-orm 0.39.3 SQL-Injection-CVE (Defense-in-Depth)
   - Address-Search-Filter zu strikt (UX-Regression seit #174)

2. **MITTEL-Findings (nur dokumentieren):**
   - Geocoding ohne Backoff
   - Startup-Task-Errors werden nur geloggt
   - knip: 56 unused exports (Aufräum-Aufgabe)
   - fast-xml-parser CVE in node-zugferd (kein Fix verfügbar)

3. **NIEDRIG-Findings:**
   - addressSearchCache nicht echt LRU
   - /api/auth/me etc. ohne Rate-Limit (requireAuth genügt)
   - address-autocomplete schluckt API-Fehler stumm
