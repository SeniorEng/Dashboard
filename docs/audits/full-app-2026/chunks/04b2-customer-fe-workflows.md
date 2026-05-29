# Chunk 4b2 — Customer FE Detail-Workflows (Pricing/Docs/Kontakte)

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**LOC / Files:** 7 543 / 30
**Kerndateien:** `.../components/admin/customer-pricing-section.tsx` (**871 LOC**),
`.../components/admin/customer-documents-section-admin.tsx` (**702 LOC**),
`.../components/customer-documents-section.tsx` (**633 LOC**),
`.../components/admin/digital-document-flow-admin.tsx` (**562 LOC**),
`.../components/admin/customer-contacts-tab.tsx` (**527 LOC**),
`.../components/admin/customer-detail-sections.tsx`, `admin-overview/*`,
`hooks/use-customer-detail-form.ts`, `hooks/use-customers.ts`,
`hooks/use-insurance-providers.ts`

> Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Echter Deep-Dive der
> Detail-Workflow-Komponenten (Pricing, Dokumente/Signing-Flow, Kontakte,
> Backfill/Nachbuchung). Maßgeblich für aggregierte Counts bleibt `../REPORT.md`.

## Zusammenfassung

Die Workflows folgen durchgängig der Query-Invalidierungs- und SSoT-Disziplin
(siehe unten). Befunde sind überwiegend **Page-Size/Code-Qualität**, keine neuen
KRITISCH/HOCH-Findings. Der größte strukturelle Druckpunkt ist die Datei-Größe
mehrerer Komponenten in diesem Chunk.

## Befunde nach Severity

### KRITISCH / HOCH
- _Keine neuen KRITISCH/HOCH-Findings in 4b2._

### MITTEL
- **Hard-Limit-Verstoß `customer-pricing-section.tsx` (871 LOC > 800):**
  Bündelt Service-Preis-Liste, Inline-Edit, Audit-Anzeige und mehrere Mutations.
  Aufteilung erforderlich (`docs/page-size-guideline.md`).
- **Soft-Limit-Annäherungen (>500 LOC):**
  `customer-documents-section-admin.tsx` (702),
  `customer-documents-section.tsx` (633), `digital-document-flow-admin.tsx`
  (562), `customer-contacts-tab.tsx` (527). Doppelung der Dokument-Sektion
  zwischen Admin- und Employee-Variante erhöht den Wartungsaufwand; ein
  gemeinsamer Kern wäre sinnvoll.
- **Chunk-Gesamtgröße (30 Files / 7 543 LOC):** Konsolidierung der
  `BudgetOverviewView`/Detail-Sektionen gemäß Plan §1.2 Phase 1.2 weiterhin
  empfohlen (Follow-up-Refs #726/#727 bereits offen).

### NIEDRIG
- **Lokaler Datums-Helper statt shared SSoT:** `customer-pricing-section.tsx:79`
  definiert `getTodayISO()` lokal, obwohl `@shared/utils/datetime` bereits
  `todayISO()` exportiert (die Datei importiert `parseLocalDate` aus demselben
  Modul). Auf shared `todayISO()` umstellen.
- **`dangerouslySetInnerHTML` im Template-Preview-Pfad:** in
  `document-preview.tsx` (Chunk 9b verortet), wird aber im Customer-Workflow
  (Signing-Flow/Vorschau) konsumiert — Sanitisierung dort prüfen.

## SSoT / Disziplin-Checks (alle bestanden)
- ✅ **Invalidierungs-Disziplin:** Sämtliche direkten `invalidateQueries`-Aufrufe
  sind korrekt mit `invalidate-direct-allowed` + eslint-disable markiert und auf
  kunden-/record-skopierte Keys begrenzt:
  `customer-contacts-tab.tsx:134,164,183` (contacts-Key),
  `customer-detail-sections.tsx:239` (`backfill-preview`-Key). Domain-
  Invalidierung läuft über `invalidateRelated(queryClient, "budget", { customerId })`
  (`customer-detail-sections.tsx:236`) inkl. gezieltem `refetchQueries` für die
  aktive `budget-overview`.
- ✅ **SignaturePad-SSoT:** `<canvas` über das Customer-Feature → **0 Treffer**.
- ✅ **Overlay-/Animations-Regeln:** Grep auf
  `backdrop-blur|bg-black/[678]|translate-|scale-|zoom-|slide-in` über das
  Customer-Feature → **0 Treffer**.
- ✅ **Telefon-Normalisierung:** `customer-contacts-tab.tsx:116-117,147-148`
  nutzt `normalizePhone` aus `@shared/utils/phone` vor dem POST/PATCH.
- ✅ **Custom-Pricing-Audit:** Audit-Aufrufe pattern-sichtbar im Backend
  (`server/routes/admin/customers/`), FE konsumiert die Audit-Daten read-only.

## Test-Coverage
- ✅ Diverse `tests/customer-*.test.ts` decken Workflow-Endpunkte;
  `tests/customers/budget-setup-required-banner.test.tsx` deckt das Banner.
- ⚠️ Keine dedizierten Component-Tests für die Inline-Edit-Logik in
  `customer-pricing-section.tsx` und für den Backfill-/Nachbuchungs-Flow
  (`customer-detail-sections.tsx` `handleBackfill`).

## Empfohlene Folge-Tasks
- `[MITTEL] Customer-FE-Workflows: Page-Split customer-pricing-section.tsx +
  gemeinsamer Kern für Admin-/Employee-Dokument-Sektion`.
- `[NIEDRIG] pricing-section: getTodayISO() → shared todayISO()`.
- BudgetOverviewView-Konsolidierung Phase 1.2 (Refs #726/#727) — bereits offen.
