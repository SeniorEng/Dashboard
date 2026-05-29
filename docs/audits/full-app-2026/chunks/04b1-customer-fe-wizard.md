# Chunk 4b1 — Customer FE Wizard + Verträge/Versicherung

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**LOC / Files:** 4 835 / 15
**Kerndateien:** `client/src/features/customers/hooks/use-customer-wizard.ts`
(**908 LOC**), `.../components/admin/customer-contract-tab.tsx` (**818 LOC**),
`.../components/admin/customer-insurance-tab.tsx`,
`.../components/wizard/{signatures-step,insurance-step,budgets-contract-step,
personal-data-step,contacts-step,delivery-step,matching-step,customer-type-step,
address-fields,wizard-step-renderer,wizard-dialogs}.tsx`,
`.../components/wizard/customer-types.ts`

> Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Echter Deep-Dive des
> Anlage-Wizards inkl. Post-Create-Orchestrierung, Vertrags- und
> Versicherungs-Tab. Maßgeblich für aggregierte Counts bleibt `../REPORT.md`.

## Zusammenfassung

Der Wizard ist robust gegen Doppelanlage (Idempotency-Key + Server-Duplicate-
Check + Recent-Duplicate-Ack). Die Post-Create-Folgeschritte sind bewusst
„best-effort" mit Pending-Banner-Fallback. Das gewichtigste Finding ist die
**unverschlüsselte localStorage-Persistenz besonderer Kategorien
personenbezogener Daten (Art. 9 DSGVO)** im Draft-Mechanismus.

## Befunde nach Severity

### KRITISCH
- _Keine._

### HOCH
- **DSGVO Art. 9 — Gesundheits-/Sozialdaten unverschlüsselt in localStorage
  (verifiziert):** `use-customer-wizard.ts:16-17, 164-185`. Der Auto-Save-Effekt
  schreibt das **komplette `formData`-Objekt** als Klartext-JSON unter
  `careconnect_customer_draft` in `localStorage` und hält es bis zu **24 h**
  (`DRAFT_MAX_AGE_MS`). `formData` enthält besondere Kategorien personenbezogener
  Daten: `vorerkrankungen` (Gesundheitsdaten), `versichertennummer`,
  `geburtsdatum`, vollständige Adresse, `pflegegrad` sowie Kontaktpersonen
  (`payload`-Felder bestätigt in `use-customer-wizard.ts:399, 393-398, 409`).
  Auf geteilten Admin-/Pflege-Workstations verbleiben diese Daten nach einem
  abgebrochenen Anlagevorgang im Browserprofil. **Positiv:** Unterschriften
  werden **nicht** persistiert (liegen in `customerSignaturesRef`, nicht in
  `formData` — siehe `:200-209`), `loadDraft()` verfällt nach 24 h und
  `clearDraft()` läuft bei Erfolg (`:423`). Empfehlung: keine
  Gesundheits-/VNR-Felder im Draft persistieren (Whitelist nicht-sensibler
  Felder) oder Draft serverseitig/verschlüsselt halten.

### MITTEL
- **Möglicher Doppel-Write der Startbudgets (Hypothese — Backend-Verifikation in
  Chunk 3/TA nötig):** Der Create-Payload sendet `budgets` an
  `POST /admin/customers` (`use-customer-wizard.ts:410`) **und** der
  `onSuccess`-Handler postet danach pro Budgettyp erneut an
  `POST /budget/:id/initial-budget` (`:497-535`). Falls der Create-Endpoint die
  übergebenen `budgets` ebenfalls als Ledger-Einträge materialisiert, entstünde
  eine Doppelbuchung. Muss gegen `server/routes/admin/customers/budgets.ts` /
  `customer-creation-helpers.ts` geprüft werden (TA-Cross-Check).
- **Nicht-atomare Post-Create-Orchestrierung:** `use-customer-wizard.ts:420-545`
  führt Mitarbeiter-Zuordnung, Unterschriften, Dokumente, Dokumentenversand und
  Startbudgets sequenziell als Best-Effort aus; Teil-Fehlschläge landen im
  `pendingPayload` + „Setup-Pending"-Banner. Der Idempotency-Key schützt **nur**
  den `createCustomer`-Call (`:414`), nicht die Folgeschritte. Akzeptiertes
  Design, aber Teil-Inkonsistenzen (z. B. Kunde ohne gespeicherte Unterschrift)
  sind möglich und nur über das Banner sichtbar.
- **Handgeschriebene pro-Step-Validierung statt Zod (Drift-Risiko):**
  `getStepErrors()` (`use-customer-wizard.ts:673-719`) prüft Pflichtfelder per
  String-/Regex-Logik, nicht via `shared`-Zod-Schema. Drift gegenüber Server-
  `createCustomerSchema` möglich (z. B. Budget-/Stunden-Beträge werden FE-seitig
  nicht validiert). **Positiv:** Die Versichertennummer nutzt die geteilte
  `validateVersichertennummerFor` (`:12`) und der VNR-Duplikat-Check ist
  debounced umgesetzt (`insurance-step.tsx:79-102`).

### NIEDRIG
- **Client-`console.error`/`console.warn` durchgängig:**
  `use-customer-wizard.ts:435, 452, 475, 491, 524, 528, 543, 573, 773` — fachlich
  unkritisch, aber gegen die No-Console-Linie; ggf. auf zentralen Logger
  umstellen.
- **`customer-contract-tab.tsx` (818 LOC) > 800-LOC-Hard-Limit:** Bündelt
  Vertragsdaten-, Leistungs-, Abrechnungs- und Deaktivierungs-Sektionen +
  eingebettete `PricingSection`. Aufteilung empfohlen.

## SSoT / Disziplin-Checks (alle bestanden)
- ✅ **SignaturePad-SSoT:** Grep `<canvas` über `client/src/features/customers`
  → **0 Treffer**; `signatures-step.tsx:6,388` nutzt die zentrale
  `SignaturePad`-Komponente.
- ✅ **Invalidierungs-Disziplin:** Alle direkten `invalidateQueries`-Aufrufe in
  `customer-contract-tab.tsx:176` sind korrekt mit
  `invalidate-direct-allowed` + eslint-disable markiert (kunden-skopierter Key);
  Domain-Invalidierung läuft über `invalidateRelated(queryClient, "customers")`
  (`:172-177`).
- ✅ **Datums-SSoT:** `customer-contract-tab.tsx:3,106` nutzt `todayISO()` aus
  `@shared/utils/datetime`.
- ✅ **Overlay-/Animations-Regeln:** Grep auf
  `backdrop-blur|bg-black/[678]|translate-|scale-|zoom-|slide-in|dangerouslySetInnerHTML`
  über das Customer-Feature → **0 Treffer**.

## Test-Coverage
- ✅ E2E-Smoke Test 3 (Notfallkontakt) + Test 4b (Wizard-Round-Trip).
- ✅ `tests/customers/budget-setup-required-banner.test.tsx` +
  `tests/e2e/budget-setup-required-banner.spec.ts` decken den Pending-Banner-Pfad.
- ⚠️ Keine dedizierten Tests für die localStorage-Draft-Persistenz (Restore/
  Discard/24h-Verfall) und keine Negativ-Tests für Teil-Fehlschläge der
  Post-Create-Orchestrierung.

## Empfohlene Folge-Tasks
- `[HOCH] Wizard-Draft: keine Art.-9-Daten (Gesundheit/VNR/Geburtsdatum) im
  localStorage — Feld-Whitelist oder verschlüsselter/serverseitiger Draft`.
- `[MITTEL] FE↔BE-Cross-Check Startbudget-Doppel-Write (create-Payload vs.
  initial-budget)` — gemeinsam mit Chunk 3/TA.
- `[MITTEL] FE-Customer-Workflows-Validation-Sweep: pro-Step-Validation gegen
  shared Zod-Schema angleichen`.
