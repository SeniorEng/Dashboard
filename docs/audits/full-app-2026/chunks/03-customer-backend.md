# Chunk 3 — Customer-Domain Backend

**Tiefenstufe:** Deep (Refresh #822 gap-fill)
**Commit:** `178b2574`
**Risiko:** HOCH
**Scope:** `server/routes/customers.ts`, `server/routes/customers/{contacts,service-prices}.ts`,
`server/routes/admin/customers.ts` + `server/routes/admin/customers/{duplicates,workflows,contracts,assignments,details,budgets}.ts`,
`server/routes/admin/contact-migration.ts`, `server/lib/params.ts`,
`server/services/customer-deletion-service.ts`,
`server/storage/customer-mgmt/{contacts,care-level,insurance,contracts}.ts`.

> **Vorgängernotiz:** Dieser Chunk war bis #481/#822 nur ein **Pattern-Scan**
> (Stub) mit zwei offenen „bitte verifizieren"-Ankern (Contact-IDOR,
> Pflegegrad-Audit). Beide wurden jetzt per Code-Walk aufgelöst — siehe unten.
> Verifiziert = im Quelltext mit Zeilennummer belegt; Hypothese = explizit so
> markiert.

---

## Mounting & AuthZ-Modell (verifiziert)

- Admin-Router wird in `server/routes/index.ts:108` unter `/admin` gemountet.
  `import adminRouter from "./admin"` löst auf die **Datei** `server/routes/admin.ts`
  auf (nicht das gleichnamige Verzeichnis).
- `server/routes/admin.ts:30` setzt global `router.use(requireAdmin)`; die
  Permission-Middleware (`admin.ts:96-134`) prüft anhand des ersten Pfadsegments
  den Key `"customers"` für alle `/customers`- und `/budget`-Routen
  (`ROUTE_PERMISSION_MAP`, `admin.ts:69,87`). Damit sind **alle** admin/customers-
  Routen admin- + customers-permission-gated. ✅
- Mitarbeiter-Router `customersRouter` (`server/routes/index.ts:118`) nutzt
  pro Route `requireCustomerAccess` / `requireCustomerReadAccess`
  (`server/lib/params.ts`) als Ownership-Gate. ✅

---

## Befunde nach Severity

### KRITISCH
Keine.

### HOCH

**H1 — Admin-Pfad mutiert Kunden-Stammdaten ohne Audit-Log (GoBD/Forensik-Lücke, asymmetrisch).**
Verifiziert. Die admin-seitigen Detail-Mutationen schreiben **keinen** Audit-Eintrag,
während die funktional identischen Mitarbeiter-Routen jede Änderung loggen:

| Operation | Admin-Route (KEIN Audit) | Mitarbeiter-Route (Audit vorhanden) |
|---|---|---|
| Kontakt anlegen/ändern/löschen | `admin/customers/details.ts:53,66,89` | `customers/contacts.ts:32,62,86` (`customerUpdated`) |
| Pflegegrad-Historie | `admin/customers/details.ts:110` | `customers.ts:168` (`customerCareLevelChanged`) |
| Vertrag anlegen/ändern | `admin/customers/contracts.ts:54,92` | `customers.ts:201` (`customerContractUpdated`) |
| Versicherung hinzufügen | `admin/customers/details.ts:23` | — |
| Bedarfserhebung (needs-assessment) | `admin/customers/contracts.ts:144` | — |

Die Storage-Layer-Funktionen loggen **ebenfalls nicht** intern
(`storage/customer-mgmt/contacts.ts:27,40,59`, `care-level.ts:34`,
`insurance.ts:115`, `contracts.ts:51,81`). Da das Admin-Kundendetail die
*primäre* Pflegemaske für diese Felder ist, bleiben Pflegegrad- (→ §45b-
Preisrelevanz), Vertrags- (→ Deaktivierung/Abrechnung) und Versicherungs-
wechsel (→ Rechnungsempfänger) ohne Wer/Wann-Spur. `replit.md` fordert
explizit „audit logging for all critical operations … customer changes".
**Empfehlung:** Audit-Log in den Admin-Mutationsrouten (oder zentral im
Storage-Layer) ergänzen, analog zu den Mitarbeiter-Pfaden.

**H2 — Kundenpreis-Mutationen nur bei Rechnungs-Impact auditiert.**
Verifiziert in `server/routes/customers/service-prices.ts`:
- **POST** (`:159`): Audit nur, wenn ein gleich-datierter Preis ersetzt wird
  (`replacedRow && req.user`, `:326`) **oder** Rechnungen betroffen sind (`:347`).
  Ein **neu angelegter** Preis ohne Datums-Konflikt und ohne betroffene
  Rechnung erzeugt **keinen** Audit-Eintrag.
- **PATCH** (`:372`): Audit nur bei `affectedInvoices.length > 0` (`:451`).
- **DELETE** (`:482`): Audit nur bei `affectedInvoices.length > 0` (`:565`).

D.h. Preis-Stammdaten (Basis künftiger Rechnungen) werden nur im Rechnungs-
Impact-Fall protokolliert; reguläre Preisanlage/-korrektur/-löschung für
zukünftige Zeiträume bleibt unprotokolliert. Mitigation: Der finanziell
kritischste Fall (bereits fakturierte Monate) **ist** abgedeckt, und Rechnungs-
positionen sind ohnehin immutable Snapshots — daher HOCH (nicht KRITISCH),
aber GoBD-Forensik-Lücke bei Preis-Stammdaten. **Empfehlung:** Audit-Log für
jede Preis-Mutation unbedingt (nicht nur bei Invoice-Impact) schreiben.

### MITTEL

**M1 — Admin-Kontakt PATCH/DELETE ohne `contactId → customerId`-Bindung.**
`admin/customers/details.ts:66,89` laden/mutieren `contactId` **ohne** zu
prüfen, dass der Kontakt zum `:customerId` der URL gehört
(`updateCustomerContact(contactId, …)` / `deleteCustomerContact(contactId)`).
Der Mitarbeiter-Pfad macht das korrekt (`customers/contacts.ts:51,81`:
`existingContact.customerId !== customerId → 403`). Da admin-gated, **keine**
Privilege-Escalation/IDOR — aber Cross-Customer-Edits über vertauschte Pfade
sind möglich und die UI-Invariante (Kontakt gehört zum gezeigten Kunden) ist
nicht serverseitig erzwungen. Data-Integrity-Inkonsistenz.

**M2 — Irreversible Anonymisierung nur admin-, nicht superadmin-gated.**
`admin/customers/workflows.ts:32` (`POST /customers/:id/anonymize`,
`customer_anonymized`, `:114`) überschreibt PII **irreversibel**, erfordert aber
nur `requireAdmin` + customers-Permission. Der Hard-Delete-Pfad
(`workflows.ts:481`, `DELETE …`) sowie die Readiness-Prüfung (`:447`) erfordern
dagegen `requireSuperAdmin`. Inkonsistente Privilegierung für vergleichbar
irreversible PII-Operationen. **Empfehlung:** Anonymisierung ebenfalls
`requireSuperAdmin` (oder einheitliche Begründung dokumentieren).

**M3 — Kunden-Merge kann überlappende Preis-Gültigkeitsfenster erzeugen.**
`admin/customers/duplicates.ts:251-266`: Beim Merge werden
`customer_service_prices` per Dedup nur auf das **UNIQUE (customer_id,
service_id, valid_to)** entschärft — d.h. nur Zeilen mit **identischem**
`valid_to` werden gelöscht (`:254`), der Rest auf den Zielkunden umgehängt
(`:264`). Überlappende Gültigkeits**bereiche** (gleicher Service, unterschiedliche
`valid_to`) bleiben beide bestehen → mehrere „offene" Preise pro Service möglich.
Der reguläre Preis-Anlagepfad (`service-prices.ts`) schließt dagegen das
Vorgänger-Intervall sauber. Folge: Preisauflösung bei Abrechnung des
Zielkunden potenziell mehrdeutig. **Hypothese zum Impact** (nicht durch Test
belegt): erfordert Re-Historisierung statt reinem `UPDATE customer_id`.

**M4 — Merge-Audit läuft Best-Effort nach Commit.**
`admin/customers/duplicates.ts:313-329`: Der `customer_merged`-Audit-Eintrag
wird **außerhalb** der Merge-Transaktion geschrieben und Fehler nur via
`console.error` verschluckt (`:329`). Ein erfolgreicher (irreversibler) Merge
kann damit **ohne** Audit-Spur enden. Für eine GoBD-kritische Operation
schwach.

**M5 — Logger-Pattern-Verstoß (`console.error`).**
`server/routes/customers.ts:341`, `admin/customers/duplicates.ts:329` nutzen
`console.error` statt des zentralen Loggers. (Bereits global als **M7** in
`../REPORT.md` erfasst — hier nur Domänen-Beleg, kein neuer Befund.)

### NIEDRIG

**N1 — Fehlende Existenzprüfung vor Insert (Admin-Detail).**
`admin/customers/details.ts:23,53,110` fügen Insurance/Contact/Care-Level
direkt mit `customerId` aus dem Pfad ein, ohne vorab `getCustomer`. Bei
nicht existentem Kunden schlägt der FK fehl → 500 statt 404. Der Vertrags-
pfad (`contracts.ts:58,96`) macht die Prüfung korrekt. Kosmetisch/Konsistenz.

**N2 — `sql.raw` im Merge (defense-in-depth, aktuell sicher).**
`admin/customers/duplicates.ts:191-192` baut `UPDATE`-Statements per
`sql.raw` mit interpolierten IDs. Die IDs stammen aus
`mergeSchema` (`:132`, `z.number().int().positive()`), daher **keine** Injection.
Hinweis zur Defense-in-Depth: auf parametrisierte `sql`-Templates umstellen.

---

## Positiv-Belege (verifiziert)

- ✅ `customers/contacts.ts:51,81` — saubere Ownership-Bindung (404 vs. 403)
  auf `contactId` **plus** Audit-Log auf allen Mutationen. (Löst den offenen
  IDOR-Anker des #481-Stubs auf: Mitarbeiter-Pfad ist korrekt.)
- ✅ `service-prices.ts` — robuster Invoice-Impact-Guard mit
  `confirmInvoiceOverride` (`:183,434,513`), Row-Locking (`:244`) und
  `customer_price_replaced`-Audit für den fakturierten Fall (`:326`).
- ✅ `workflows.ts` — Hard-Delete mit `requireSuperAdmin` (`:481`),
  Compliance-Officer-Signoff (`hardDeleteSchema`, `:472`) und Audit (`:112,392`).
- ✅ `admin/customers/contracts.ts:64-76` — verhindert doppelten aktiven
  Vertrag (409 CONFLICT).
- ✅ `contact-migration.ts:21,45` — beide Routen `requireSuperAdmin`, Zieltyp
  gegen Whitelist validiert (`:13,16`).

---

## Test-Coverage-Notizen

- `tests/customers.test.ts` (CRUD/Validierung/Pflegegrad/Deaktivierung),
  `customer-hard-delete.test.ts`, `customer-idempotency.test.ts`,
  `customer-duplicate-warning.test.ts`,
  `customer-erstberatung-{orphan-prevention,prospect-link}.test.ts`,
  `team-lead-customer-assignment.test.ts` vorhanden.
- `tests/customer-service-prices-invoiced.test.ts` deckt **nur** den
  Invoice-Impact-Guard (Task #191) ab und assertet die Audit-Emission **nicht**
  — die in H2 beschriebene Lücke (Anlage/Änderung ohne Rechnungsbezug) ist
  **untested**.
- **Lücke:** Kein Test prüft Audit-Log-Emission auf den **Admin-Mutations-
  pfaden** (Contacts/Care-Level/Contract/Insurance) → H1 ist regressionsseitig
  ungeschützt.
- Bekannt flaky, **nicht** als Domänen-Befund zu werten:
  `tests/document-pdf-sanitization.test.ts`, `tests/test-data-cleanup.test.ts`.

---

## Empfohlene Folge-Tasks

1. `[HOCH]` Audit-Log auf allen Admin-Customer-Mutationsrouten ergänzen
   (Contacts/Care-Level/Contract/Insurance/Needs-Assessment) — siehe H1.
2. `[HOCH]` Preis-Mutationen unbedingt auditieren (nicht nur Invoice-Impact) —
   siehe H2.
3. `[MITTEL]` Anonymisierung auf `requireSuperAdmin` heben — siehe M2.
4. `[MITTEL]` Merge: Preis-Re-Historisierung statt reinem `UPDATE customer_id`
   + Audit in die Transaktion ziehen — siehe M3/M4.
5. `[MITTEL]` `contactId → customerId`-Bindung im Admin-Pfad — siehe M1.
