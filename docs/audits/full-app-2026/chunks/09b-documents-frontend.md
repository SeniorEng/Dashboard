# Chunk 9b — Documents Frontend

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**LOC / Files:** 3 327 / 8

> Dieser Chunk wurde in der Refresh-Welle #822 ursprünglich nur als
> Pattern-Scan abgehakt. Dieser Eintrag ersetzt den Pattern-Scan durch einen
> Deep-Dive über alle 8 Dateien (`signature-pad.tsx`, `document-preview.tsx`,
> `document-templates.tsx`, `document-types.tsx`, `proof-review.tsx`,
> `service-record-detail.tsx`, `service-records.tsx`, `types.ts`). Severity-
> Aggregation bleibt in `../REPORT.md` maßgeblich.

## Befunde

### KRITISCH
- Keine.

### HOCH
- Keine **offenen** HOCH-Findings. Das frühere HOCH (#481 Pattern-Scan,
  „Stored-XSS via `dangerouslySetInnerHTML`") ist **behoben (verifiziert)**:
  Alle drei Render-Pfade leiten den HTML-Body durch `DOMPurify.sanitize`,
  bevor er in `dangerouslySetInnerHTML` landet:
  - `document-templates.tsx:694` (Live-Preview-Pane)
  - `document-preview.tsx:35` (eingebettete Vorschau)
  - `public-signing.tsx:163` (öffentlicher Signatur-Kontext, kein Login)
  → Der vormals als HOCH gemeldete Vektor ist damit auf NIEDRIG reduziert
  (siehe N1). Kein Folge-Task mehr nötig.

### MITTEL
- **N+1-Query gegen das Customer-API in der Service-Records-Liste**
  (`service-records.tsx`): `PendingBannerLabel` (`:324`), `PendingListItem`
  (`:340`) und `ServiceRecordCard` (`:558`) feuern jeweils ein **eigenes**
  `useQuery` für `record.customerId`. Bei einer Liste von N Datensätzen
  entstehen N parallele Kunden-Requests statt eines Batch-/Join-Reads. Grund:
  Performance + unnötige Backend-Last auf der meistgenutzten Übersicht;
  skaliert schlecht mit wachsendem Pending-Bucket. Empfehlung: Kundennamen
  serverseitig in die Listen-Response joinen oder Batch-Endpoint nutzen
  (`service-record-detail.tsx` macht das für Mitarbeiter/Services bereits über
  Maps richtig).

### NIEDRIG
- **N1 — `srcDoc`-Vollvorschau ohne DOMPurify, aber Script-gesperrt:**
  `document-preview.tsx:20-26` und `document-templates.tsx:682-688` rendern den
  Voll-Dokument-Pfad über `<iframe srcDoc=…>` **ohne** vorherige
  `DOMPurify.sanitize`. Das iframe trägt `sandbox="allow-same-origin"`
  **ohne** `allow-scripts`, d.h. JavaScript im injizierten Markup wird vom
  Browser nicht ausgeführt → kein aktiver XSS-Vektor. Grund/Restrisiko:
  Verstoß gegen Defense-in-Depth (sanitize alle HTML-Pfade); falls künftig
  `allow-scripts` ergänzt wird, kippt das sofort zu HOCH. = REPORT N3.
- **N2 — Datetime-Konventionsverstoß (`new Date(string)` statt
  `@shared/utils/datetime`):** `signature-pad.tsx:354` (`SignatureDisplay`,
  `new Date(signedAt).toLocaleString`), `proof-review.tsx:131` und
  `document-templates.tsx:666`. Alle nur Anzeige-Formatierung, aber replit.md
  verbietet `new Date(string)` und schreibt die zentralen Datetime-Helfer vor.
  Grund: TZ-Drift-Risiko + Konventionsbruch (konsistente DE/Berlin-Anzeige).
- **N3 — Browser-lokale „aktueller Monat"-Defaults:** `service-records.tsx:55-60`
  und `:152` bilden den Default-Filter über `new Date()` + `getFullYear()` /
  `getMonth()` (lokale Browser-Zeit) statt über Berlin-normierte Helfer. Grund:
  An Monatsgrenzen kann ein Nutzer außerhalb der Berlin-TZ den falschen Monat
  vorausgewählt bekommen (Off-by-one).

## Positiv-Befunde (verifiziert)
- ✅ **SignaturePad-SSoT eingehalten:** Grep nach `<canvas` / `SignatureCanvas`
  außerhalb `signature-pad.tsx` = 0 Treffer. Keine Schatten-Implementierung.
- ✅ **Query-Invalidation-Disziplin:** `proof-review.tsx`,
  `document-templates.tsx`, `service-records.tsx`, `service-record-detail.tsx`
  nutzen durchgängig `invalidateRelated` (kein direkter `invalidateQueries`-
  Wildwuchs) — überdurchschnittlich gegenüber dem globalen Schnitt (REPORT M10).
- ✅ **Batch-Reads in der Detail-Ansicht:** `service-record-detail.tsx` lädt
  Mitarbeiter-Namen und Services über Maps/Batch statt N+1.

## Test-Coverage
- ✅ `tests/signature-pad-empty-canvas.test.tsx` — leere Canvas-Submit-Guard.
- ✅ `tests/service-records/pending-banner-page.test.tsx`,
  `pending-banner-section.test.tsx`, `pending-banner-customer-scope.test.ts`,
  `overview-bucketize.test.ts`, `sign-empty-signature-and-cache.test.ts`,
  `sign-transactional.test.ts` — solide Abdeckung der Pending/Sign-Pfade.
- ✅ E2E `e2e/smoke/service-record-drilldown.spec.ts` — Drilldown-Pfad.
- ⚠️ **Lücke:** Kein Test deckt die `DOMPurify`-Sanitization der drei
  `dangerouslySetInnerHTML`-Render-Pfade ab (Regressions-Schutz fehlt; ein
  künftiges Refactoring könnte die Sanitize-Schicht unbemerkt entfernen).
  Hinweis: `tests/document-pdf-sanitization.test.ts` ist ein **bekannter
  Pre-Existing-Flake** (siehe flaky-tests.md) und KEIN neues Finding.
- ⚠️ Keine Coverage für den N+1-Pfad / kein Render-Test der `srcDoc`-Vorschau.
