# Chunk 4a — Customer Stammdaten & Listen (FE)

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**LOC / Files:** 2 979 / 5
**Dateien:** `client/src/pages/admin/customer-detail.tsx`,
`client/src/pages/admin/customers.tsx`, `client/src/pages/admin/duplicates.tsx`,
`client/src/pages/customer-detail.tsx` (Employee),
`client/src/pages/customers.tsx` (Employee)

> Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Dieser Lauf ist ein
> echter Deep-Dive der 5 Stammdaten-/Listen-Seiten. Maßgeblich für die
> aggregierten Severity-Counts bleibt `../REPORT.md`.

## Zusammenfassung

Round-Trip- und Invalidierungs-Disziplin sind solide; die Befunde sind
überwiegend Code-Qualität/Konsistenz. **Keine neuen KRITISCH-Findings.** Ein
HOCH-Finding zur DSGVO-Persistenz wird im Wizard-Chunk (4b1) geführt, da der
Auslöser dort liegt.

## Befunde nach Severity

### HOCH
- _Keine eigenständigen HOCH-Findings in 4a._ (Das HOCH zur localStorage-
  Persistenz besonderer Kategorien personenbezogener Daten ist in 4b1 verortet.)

### MITTEL
- **Page-Size-Hard-Limit-Annäherung (`docs/page-size-guideline.md`):**
  `client/src/pages/admin/customers.tsx` (**755 LOC**) und
  `client/src/pages/admin/customer-detail.tsx` (**742 LOC**) liegen knapp unter
  der 800-LOC-Hard-Limit-Grenze. Beide bündeln Liste/Filter bzw. Tab-Routing +
  mehrere Mutations in einer Datei → Aufteilung empfohlen, bevor das Limit
  durch Folge-Features gerissen wird.
- **Bypass des zentralen API-Clients beim Hard-Delete:**
  `client/src/pages/admin/customer-detail.tsx:162-170` verwendet ein rohes
  `fetch()` mit manuellem CSRF-Cookie-Parsing für `handleHardDelete` statt des
  zentralen `api`-Clients (der CSRF/Fehler-Mapping/`ApiError` bereits kapselt).
  Drift-Risiko bei künftigen CSRF-/Header-Änderungen; Fehlerpfad weicht vom
  Rest der Seite ab. Konsistenz-Finding (SSoT API-Client).

### NIEDRIG
- **Inline-QueryKeys statt `customerKeys`-Factory (Employee-Seite):**
  `client/src/pages/customer-detail.tsx:73-126` nutzt handgeschriebene
  Query-Keys statt der `customerKeys`-Factory aus `@/features/customers` und
  dupliziert einen Inline-`budgetOverview`-Typ. Drift-Risiko gegenüber der
  Admin-Variante / zentraler Typdefinition.
- **Duplikat-Such-Performance (Altbefund #481, weiterhin offen):** Das
  Stop-Kriterium „< 500 ms bei 5 000 Kunden" für den Duplikat-Endpoint ist
  nicht automatisiert geprüft (`duplicates.tsx` konsumiert nur). Folge-Smoke
  empfohlen — Backend-seitig in Chunk 3 zu verifizieren.

## Test-Coverage
- ✅ E2E-Smoke `tests/e2e/edit-persistence.spec.ts` Test 1 deckt den Kunden-
  Edit-Round-Trip (Admin-Detail).
- ✅ `tests/customers/budget-setup-required-banner.test.tsx` +
  `tests/e2e/budget-setup-required-banner.spec.ts` decken das Setup-Pending-
  Banner, das auf der Detailseite gerendert wird.
- ⚠️ Keine dedizierten Unit-/Component-Tests für `handleHardDelete`
  (CSRF/Confirm-Flow) und für die Listen-Filter-Kombinationen in
  `admin/customers.tsx`.

## Empfohlener Folge-Task
`[MITTEL] Customer-FE-Stamm: Page-Split (customers.tsx/customer-detail.tsx) +
Hard-Delete über zentralen api-Client + QueryKey-Factory auf Employee-Seite`.
