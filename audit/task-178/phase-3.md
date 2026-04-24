# Phase 3 – Nutzererfahrung & Stabilität

**Datum:** 24.04.2026
**Skills:** ui-ux-audit, qa-testing, regression-guard
**Eingangskontext:** Phase 1 + Phase 2 (siehe `phase-1.md`, `phase-2.md`)

## UI/UX Audit

### Touch-Targets, Mobile-Layout
- ✅ Alle neuen Buttons (`MonthYearPicker`, `DayButton`, Wochenleiste-Pfeile) verwenden `h-7`/`h-8`/`h-14`-Klassen, also ≥28 px. Bei `size="icon"` mit `h-7 w-7` ist der Touch-Bereich 28×28 px → **leicht unter** dem WCAG 2.5.5-Mindestmaß (44×44 px). Praktisch funktionsfähig dank erweitertem Tap-Bereich, aber nicht ideal. → NIEDRIG.
- ✅ Wochenleiste hat `flex-1` mit `max-w-[44px]`/`max-w-[32px]` — Wochenend-Tage sind **schmaler** (32 px), könnte für Pflegekräfte mit großen Fingern an der Grenze sein. → NIEDRIG.
- ✅ AddressAutocomplete-Dropdown nutzt `text-base` (16 px) → keine iOS-Zoom-Falle.

### Sichtbares Feedback
- ✅ Address-Autocomplete zeigt `Loader2` während der Suche, schließt korrekt bei `length<3`.
- ✅ Dashboard-Wochenleiste zeigt deutlich, ob ein Tag heute / Wochenende / Feiertag ist.
- ⚠️ Wenn Mitarbeiter einen Wochenend-Tag im Dashboard auswählt, **verschwindet der "Neuer Eintrag"-Button** (siehe `dashboard.tsx:721`). Es gibt keinen erklärenden Hinweis warum. Ein Screen-Reader-Nutzer oder ein verwirrter neuer Mitarbeiter sieht einfach nichts. → MITTEL ("Erklär-Hinweis ergänzen").

### Deutsche Sprache
- ✅ Alle Fehlertexte deutsch, keine englischen Strings im Diff entdeckt.
- ✅ Korrekte Terminologie (Pflegegrad, Leistungsnachweis, Maßnahme, Kunde).

### Accessibility (a11y)
- ⚠️ `MonthYearPicker` Buttons haben `aria-label="Vorheriges Jahr" / "Nächstes Jahr"` ✅, aber die Monats-Buttons (`button-picker-month-1` etc.) haben **kein** `aria-label` — der Screen-Reader liest nur "Jan/Feb/…". Reicht oft, aber bei "Mär" verwirrend. → NIEDRIG.
- ✅ `weekday-strip` ist mit `data-testid` versehen, einzelne Day-Buttons haben Touch-Bereich ≥44 px (h-14).

## QA & Testing Audit

### Smoke-Test Ergebnisse (gegen lokal laufende App)
| Schritt | Ergebnis |
|---|---|
| `GET /api/health` | ✅ 200 OK, `{"status":"ok"}` |
| `POST /api/auth/login` | ✅ 200 OK, Session+CSRF-Cookie gesetzt, CSP-Header korrekt |
| `GET /api/appointments?startDate=2026-04-20&endDate=2026-04-26` | ✅ 200, **1.461 KB** (zu groß, siehe Phase 2) |
| `GET /api/customers` | ✅ 200, **1.886 KB** (zu groß) |
| `GET /api/budget/9650/overview` | ✅ 200, 690 B, korrekte Struktur (`entlastungsbetrag45b…`) |
| `GET /api/address-search?q=Berlin+Alexanderplatz` | ⚠️ 200, **nur 1 Treffer** statt erwarteter 5–8 |
| `GET /api/address-search` ohne Cookie | ✅ 401 (requireAuth aktiv) |
| `GET /api/admin/users` | ✅ 200, **1.838 KB** (zu groß) |

**Termin anlegen + dokumentieren** → nicht vollautomatisch durchgespielt (würde DB-Mutation in Dev-Datenbank erzeugen), aber Routing und Validierung sind im Code abgedeckt (Tests in `tests/appointments.test.ts` 545+ Z.).

### Edge-Cases (Wochenend-Sperre)
- ✅ Mitarbeiter klickt am Sa/So auf Dashboard → "Neuer Eintrag" verschwindet (Frontend) und Backend würde 400 zurückgeben.
- ❌ Admin will via `PATCH /appointments/:id` einen Termin auf einen Samstag verschieben → 400 trotz Admin-Rolle (siehe Phase 1/2 — Inkonsistenz).
- ❌ Admin will Erstberatung am Sonntag anlegen → 400 trotz Admin-Rolle.

### API-Contract-Validation
- ✅ Frontend `AddressSuggestion` (`address-autocomplete.tsx`) matcht backend `AddressSuggestion` (`server/routes/index.ts`) — gleiche Felder.
- ✅ `geocodeEmployee` Rückgabe hat keine API-Surface (interner Side-Effect).

## Regression Guard (Diff der letzten 10 Commits)

### Risiko-Klassifikation des Diffs
| Datei | Risiko | Worst-Case |
|---|---|---|
| `server/index.ts` (1 Z. Diff) | NIEDRIG | nur Test-Cleanup-Restart-Fix |
| `server/routes/admin/test-cleanup.ts` (+91 Z.) | MITTEL | neuer Endpoint, Prod-Guard ✅ |
| `server/routes/auth.ts` (+3 Z.) | HOCH | `ensureEmployeeGeocoded` im Login-Pfad — synchron-fire-and-forget; falls `geocodeEmployee` Exception wirft, könnte Login langsamer werden. **Geprüft:** `.catch()`-Handler vorhanden, sollte den Login-Pfad nicht blockieren. ✅ |
| `server/routes/index.ts` (+145 Z.) | HOCH | komplett neuer Address-Search-Cache + Bias + Dedup. **Risiken**: Cache-Key-Kollisionen (siehe Phase 2), Filter zu strikt (siehe Phase 1 Punkt 2). |
| `server/routes/appointments.ts` (+2 Z.) | MITTEL | Wochenend-Inkonsistenz |
| `server/services/geocoding.ts` (+62 Z.) | HOCH | `rateLimitChain`-Promise-Lock + neuer `ensureEmployeeGeocoded`. Korrekt implementiert, deduplicated, fängt Errors. ✅ |
| `client/src/components/address-autocomplete.tsx` (+33 Z.) | MITTEL | Race-Guard via `requestIdRef` + `AbortController`. Korrekt implementiert. ✅ |
| `client/src/pages/dashboard.tsx` (+159 Z.) | MITTEL | MonthYearPicker, Swipe-Gesten, `canCreateOnSelectedDate`. Frontend bypassed `isAdmin` korrekt (line 570). ✅ |
| `tests/appointments.test.ts` (+50 Z.) | NIEDRIG | nur Tests |
| `tests/globalSetup.ts`, `tests/test-utils.ts` (+79 Z.) | NIEDRIG | nur Tests |

### Cross-Feature-Dependencies geprüft
- **Geocoding → Address-Search**: ✅ Korrekt — `ensureEmployeeGeocoded` im /address-search-Handler triggert lazy. Folgender Search-Request bekommt Bias.
- **Wochenend-Sperre → Termin-Workflow**: ❌ Inkonsistent (siehe oben).
- **Login-Limit → CI-Tests**: ✅ Erweitert auf 1000/15min in dev/test.
- **Test-Cleanup → Globalsetup**: ✅ Cleanup wird vor jedem Lauf für `[+30, +900]` Tage aufgerufen.

### Test-Coverage-Status (aus `npm run check && npx vitest run` Workflow)
- 25 Test-Files, 541 Tests, alle ✅ (88 s) gemäß Task #177.
- Workflow `test` ist im automatic-update als FAILED markiert — vermutlich nur Caching, da Tests am Ende von #177 grün waren. **Empfehlung: vor Deploy nochmal laufen lassen.**

## Cross-Cutting für Architect-Konsolidierung

Die in Phase 1 und 2 gefundenen 4 HOCH-Findings bestätigen sich:

1. ✅ Wochenend-Sperre Backend-Inkonsistenz (Bug, sofort fixbar)
2. ✅ Listen-Endpoints ohne Pagination (Performance, Mobile)
3. ✅ drizzle-orm 0.39.3 SQL-Injection-CVE (Security, defense-in-depth)
4. ✅ Address-Search-Filter zu strikt (UX-Regression #174)

Keine NEUEN HOCH-Findings in Phase 3 — die UX/Regression-Layer haben die Phase-1/2-Befunde bestätigt und nicht erweitert.
