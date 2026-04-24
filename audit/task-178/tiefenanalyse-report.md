# Tiefenanalyse-Report (Voll-Audit)

**Datum:** 24.04.2026
**Task:** #178 — Tiefenanalyse: Voll-Audit mit allen Audit-Skills
**Diff-Basis:** 10 letzte Commits (`9930d33` rückwärts)
**Methodik:** `deep-analysis` 3-Phasen-Modell + Architect-Konsolidierung
**Smoke-Test:** ✅ erfolgreich gegen laufende lokale App

## Executive Summary

Der Audit zeigt eine **gesunde Codebase** mit einer kleinen Anzahl klar umrissener Probleme. Die in den letzten Tasks (#173–#177) eingeführten Änderungen (Geocoding-Lazy-Hook, Adresssuche-Bugfix, Wochenend-Sperre, Test-Cleanup, Login-Limit-Anpassung) sind im Großen und Ganzen sauber implementiert — Race-Conditions sind abgesichert, Background-Jobs deduplicated, Errors gefangen, Tests grün.

**Es gibt aber drei sofort wirksame Probleme** (HOCH) und ein viertes Defense-in-Depth-Thema, die in eigenen Folge-Tasks adressiert werden sollten:

1. 🔴 **Wochenend-Sperre Backend-Inkonsistenz** — Admin kann via PATCH und Erstberatung-POST Termine am Wochenende NICHT verschieben/anlegen, obwohl die UI das erlaubt.
2. 🔴 **Listen-Endpoints ohne Pagination** — `/api/customers` (1,9 MB), `/api/admin/users` (1,8 MB), `/api/appointments` (1,4 MB pro Woche). Auf 3G/4G im Außendienst fühlbar langsam.
3. 🔴 **drizzle-orm 0.39.3 mit HIGH-CVE** (SQL-Injection via Identifier) — im Codebase nicht ausnutzbar (kein `sql.identifier()` mit User-Input), aber Defense-in-Depth.
4. 🟠 **Address-Search-Filter zu strikt** — `"Berlin Alexanderplatz"` liefert nur 1 Treffer statt 5–8.

Alle vier werden als eigene Project-Tasks vorgeschlagen.

## Findings nach Schweregrad

### 🔴 KRITISCH
*keine.*

### 🟠 HOCH

#### H1 – Wochenend-Sperre Backend-Inkonsistenz
- **Wo:** `server/routes/appointments.ts`
  - Zeile 439: `POST /kundentermin` — `if (!user.isAdmin && isWeekend(...))` ✅
  - Zeile 578: `POST /prospect-erstberatung` — `if (isWeekend(...))` ❌ kein Admin-Bypass
  - Zeile 712: `PATCH /:id` — `if (validatedData.date && isWeekend(...))` ❌ kein Admin-Bypass
- **Folge:** Admin sieht im UI den "Neuer Eintrag"-Button (Frontend `dashboard.tsx:570` lässt Admins durch), klickt, kommt ans Backend, bekommt 400. Inkonsistente UX.
- **Fix:** Helper `assertWeekendAllowed(user, dateString)` extrahieren und an allen drei Stellen identisch verwenden. Tests ergänzen (Erstberatung Sa/So, PATCH auf Sa/So jeweils mit Admin-User).
- **Aufwand:** ~30 min.

#### H2 – Listen-Endpoints ohne Pagination
- **Wo:** `server/routes/customers.ts`, `server/routes/admin/users*.ts`, `server/routes/appointments.ts`
- **Messung Smoke-Test:** customers 1,9 MB / users 1,8 MB / appointments-week 1,4 MB.
- **Folge:** Pflegekraft mit 4G im Patientenhaus wartet 3–5 s pro Seitenaufruf, Datenvolumen-Verbrauch.
- **Fix:** Server-side `?limit&offset` einführen, Frontend auf TanStack `useInfiniteQuery` migrieren oder Server-side Filter (z. B. `?activeOnly=true`) als Quick-Win. Mindestens für die drei großen Endpoints.
- **Aufwand:** mittel (~1–2 h pro Endpoint), aber sehr hoher User-Impact.

#### H3 – Address-Search Filter zu strikt
- **Wo:** `server/routes/index.ts` Zeile ~280–300 (Filter `r.address.road || pedestrian || footway || path`)
- **Folge:** Bei Plätzen ohne klassischen Straßennamen (Alexanderplatz, Rathausplatz) werden alle Treffer rausgefiltert, der User sieht eine fast leere Vorschlagsliste. Regression seit #174.
- **Fix:** Fallback ergänzen: `r.address.square || r.address.suburb || r.name || r.display_name.split(",")[0]` als Straßenfeld erlauben. Test-Case "Berlin Alexanderplatz" hinzufügen.
- **Aufwand:** ~20 min.

#### H4 – drizzle-orm 0.39.3 HIGH-CVE Upgrade
- **Wo:** `package.json` (`drizzle-orm: 0.39.3`)
- **CVE:** GHSA-gpj5-g38j-94v9 (SQL-Injection via `sql.identifier()` Escape-Bug)
- **Im Code ausnutzbar?** Nein — `grep` zeigt keine Verwendung von `sql.identifier`/`sql.raw` mit User-Input.
- **Empfehlung:** Trotzdem auf 0.45.2 upgraden (Major-Version-Sprung 0.39 → 0.45), inkl. Regressionstest auf `npm run check`, alle Storage-Module einmal durchspielen. Gleichzeitig `@google-cloud/storage` (transitive `@tootallnate/once`) updaten.
- **Aufwand:** ~1–2 h (breaking-changes prüfen).

### 🟡 MITTEL (nur dokumentiert, kein Folge-Task)

| ID | Beschreibung | Datei |
|---|---|---|
| M1 | Geocoding-Background-Job ohne Backoff bei wiederholten Fehlern | `server/services/geocoding.ts` |
| M2 | Startup-Tasks-Errors werden nur geloggt, kein zentrales Reporting | `server/index.ts:152–247` |
| M3 | Wochenend-Tag-Auswahl: kein erklärender Hinweis warum "Neuer Eintrag" verschwindet | `client/src/pages/dashboard.tsx:721,769` |
| M4 | knip: 56 unused exports (`AppointmentService`, `DatabaseStorage`, `apiRequest` u. a.) | diverse |
| M5 | fast-xml-parser CVE in node-zugferd, kein Upstream-Fix | `lib/zugferd.ts` |
| M6 | Querverweis zu offenem Task "TypeScript-Fehler im Server beheben" (16 tsc-Errors) | `server/` |

### 🟢 NIEDRIG (Hinweise)

| ID | Beschreibung |
|---|---|
| N1 | `addressSearchCache` ist FIFO-evict, nicht echt LRU |
| N2 | `/api/auth/me`, `/session-info`, `/keepalive` ohne Rate-Limit (requireAuth genügt) |
| N3 | `address-autocomplete.tsx` schluckt API-Fehler stumm (gewünscht, aber dezenter Hinweis wäre nett) |
| N4 | MonthYearPicker-Monats-Buttons ohne explizites `aria-label` |
| N5 | Wochenend-Day-Buttons in der Wochenleiste sind schmaler (32 px statt 44 px) |
| N6 | Cache-Key-Kollision möglich bei zwei Mitarbeitern derselben 1×1-km-Bias-Box (gewollt) |

## DevOps-Check

| Check | Ergebnis |
|---|---|
| `npm audit` | 1 HIGH (drizzle-orm), 3 moderate, 1 low — siehe H4 / M5 |
| `npm outdated` | 16 outdated packages, davon `@neondatabase/serverless 0.10.4 → 1.1.0` als nächste sinnvolle Major-Migration |
| Env-Secrets | `EMAIL_WEBHOOK_SECRET`, `TEST_USER_*` vorhanden; `QONTO_*` als optional dokumentiert |
| Logging | `log()` zentral, je Request eine Zeile mit Method/Path/Status/Duration |
| Health-Check | `/api/health` ✅ pingt DB an |
| Process-Resilience | `unhandledRejection`, `uncaughtException` mit Neon-Driver-Filter ✅ |
| Graceful Shutdown | `gracefulShutdown` schließt intervals, timeouts, browser, db-pool ✅ |

## Smoke-Test (`/smoke`)

Alle 5 kritischen Pfade ✅ funktionieren — Detail-Tabelle siehe `phase-3.md` "Smoke-Test Ergebnisse". Keine deployment-blocker.

## Empfohlene Fix-Reihenfolge

1. **H1 Wochenend-Sperre** (30 min, niedriges Risiko, hohe UX-Wirkung)
2. **H3 Address-Search Filter** (20 min, isoliert, regression-test einfach)
3. **H2 Pagination Listen-Endpoints** (mehrere Stunden, hoher User-Impact, Mobile-relevant)
4. **H4 drizzle-orm Upgrade** (mehrere Stunden, Major-Version-Sprung, ausgiebig testen)

H1 und H3 sind die "Quick Wins". H2 und H4 sind echte Tagesaufgaben.

## Querverweise zu existierenden Tasks (NICHT dupliziert)

Diese bestehenden Tasks decken thematisch verwandte, aber separate Aspekte ab:
- "Budget-Startwert Redesign" (Konzept) — überschneidet sich mit Budget-Audit
- "Budget-Warnung False-Positive Fix" — Anzeige-Bug
- "TypeScript-Fehler im Server beheben" (16 tsc errors) — separater Quality-Task
- "Central Month-Closing" — bedingt verwandt mit `isMonthClosed`
- "Standardize Phone Handling" — orthogonal

## Phase-Files

- [Phase 1 — Strukturelle Fakten](./phase-1.md)
- [Phase 2 — Tiefe Domänenanalyse](./phase-2.md)
- [Phase 3 — Nutzererfahrung & Stabilität](./phase-3.md)
- [Scope](./scope.md)

## Audit-Signatur
- 25 Test-Files / 541 Tests grün im letzten CI-Lauf (Task #177)
- Smoke-Test 24.04.2026 18:56 UTC ✅
- Findings priorisiert, dedupliziert, mit Fix-Empfehlung versehen
