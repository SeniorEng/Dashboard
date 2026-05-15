# Chunk 9a — Documents Backend

**Tiefenstufe:** Deep-Audit (Subagent-Lauf, alle 3 Phasen)
**Commit:** `3e0d3fb7029bd4f62cedd7f055abbd60bdf382e9`
**Risiko:** HOCH
**LOC / Files:** 5 207 / 18

## Geprüfte Dateien

Routes: `public-signing.ts`, `service-records.ts`, `admin/documents.ts`,
`admin/document-delivery.ts`, `customers/documents.ts`.
Services: `document-pdf.ts`, `document-delivery.ts`, `document-trigger-engine.ts`,
`document-review.ts`, `cover-letter.ts`, `template-engine.ts`,
`letterxpress-service.ts`.
Storage: `documents.ts`, `service-records-storage.ts`.
Object-Storage-Integration (4 Files).

## Findings

### KRITISCH

1. **`server/services/template-engine.ts:402` — HTML-Injection in PDF-Render.**
   `customer_signature` und `employee_signature` werden bewusst NICHT
   HTML-escaped, sondern direkt in das von Puppeteer gerenderte HTML
   injiziert. Wenn die Route-Validierung (Regex auf Base64-Data-URL) durch
   eine Encoding-Variante umgangen wird, ergibt das XSS/SSRF im PDF-Kontext.
   **Fix:** Vor Injection prüfen, dass der Wert ausschließlich
   `data:image/(png|jpeg|svg+xml);base64,[A-Za-z0-9+/=]+` matched und
   die Base64-Nutzlast ein gültiges Bild ist (Magic-Bytes), sonst `escapeHtml`.

2. **`server/services/document-pdf.ts:258` — Path-Traversal in
   `getDocumentPdfBuffer`.**
   Prüft Prefix `/objects/`, aber nicht `..`-Sequenzen.
   **Fix:** `path.posix.normalize(objectPath)` + Re-Check des Prefix nach
   Normalisierung.

3. **`server/routes/public-signing.ts:103` — Race zwischen PDF-Generation
   und Token-Claim.**
   `regeneratePdfWithSignature` läuft vor der Transaktion, die `claimed`
   setzt. Zwei parallele Requests können denselben Token zwei PDFs erzeugen.
   **Fix:** `SELECT … FOR UPDATE` auf Token-Row, dann PDF-Erzeugung innerhalb
   der Transaktion ODER erst Token claimen, dann PDF rendern.

### HOCH

4. **`server/replit_integrations/object_storage/objectAcl.ts:101` —
   ACL-Implementierung unvollständig.**
   `createObjectAccessGroup` wirft für alle Typen. Damit fällt `canAccessObject`
   für jeden Nicht-Owner-Pfad auf den Fail-Pfad → entweder werden Zugriffe
   pauschal verweigert (DoS bei legitimer Nutzung) oder pauschal erlaubt
   (je nach Fallback). **Fix:** ACL-Gruppen-Typen implementieren oder Pfad
   bewusst auf „Owner only" reduzieren und Doku angleichen.

5. **`server/routes/admin/documents.ts:426` — Admin-Download ohne expliziten
   `requireAdmin`.**
   Erbt lediglich `requireAuth`. **Fix:** `requireAdmin` auf `/admin/*` per
   Router-Middleware fest verdrahten (nicht pro Handler).

6. **`server/routes/service-records.ts:460` — Doppel-Signatur möglich.**
   Es gibt keinen Check, ob das Leistungsnachweis-Record bereits signiert
   wurde, bevor eine neue Signatur akzeptiert wird. **Fix:** Vor Signatur
   `signedAt IS NULL`-Check + 409 wenn bereits signiert.

7. **`server/services/letterxpress-service.ts:50` — Secret-Logging-Risiko.**
   Username + Key gehen in jedes Payload-Objekt; falls Payload je geloggt
   wird (z. B. bei 500er-Fehler), leakt das Secret. **Fix:** Vor jedem Log
   `payload.apikey`/`payload.username` redacten; Secret-Felder in
   `company_settings` als sensitive markieren (encryptedText).

### MITTEL

8. **`public-signing.ts:64` — `renderedHtml` an unauthenticated Caller.**
   PII (Kundenname, Adresse) im HTML der Signing-Page. Token ist 32 Bytes
   hoch-entropisch, also nicht praxisrelevant exploit-bar, aber unnötige
   Surface. **Fix:** Nur das tatsächlich für UI nötige Minimum zurückgeben.

9. **`server/storage/documents.ts:202` — Race in `uploadDocument`** beim
   `isCurrent`-Switch. **Fix:** Innerhalb der Transaktion
   `SELECT … FOR UPDATE` auf den (type, employeeId)-Bucket.

10. **`server/services/document-pdf.ts:301` — Token-TTL hart auf 7 Tage.**
    **Fix:** In `company_settings` konfigurierbar machen.

11. **`server/services/document-pdf.ts:146` — Integrity-Hash deckt
    `signingIp` und `signingLocation` nicht.**
    Audit-Trail-Felder können nachträglich verfälscht werden, ohne dass der
    Hash bricht. **Fix:** Diese Felder in den Hash-Input aufnehmen.

12. **`server/routes/admin/document-delivery.ts:69` — kein Customer-Scope-Check.**
    Bei aktuell flachen Admin-Rechten unkritisch, aber blockiert künftige
    Multi-Tenant-Erweiterung.

### NIEDRIG

13. `public-signing.ts:18` — Rate-Limit 1 000 für Dev/Test zu hoch.
14. `document-delivery.ts:174` — `combinePdfBuffers` lädt alles in RAM → für
    Massen-Versand-Batches Streaming nutzen.
15. `service-records-storage.ts:202` — `onConflictDoNothing` versteckt Bugs.
16. `template-engine.ts:406` — Silent-Replace fehlender Placeholder erschwert
    Debug.
17. `pdf-generator.ts:43` — Puppeteer-Timeout 15 s ggf. zu knapp.

## Architect-Bewertung

Drei KRITISCH-Findings sitzen auf dem in `threat_model.md` namentlich als
„highest-risk" markierten Pfad (`public-signing.ts`, `document-pdf.ts`).
**Empfohlene Folge-Tasks:** 3 dedizierte Tickets (siehe `REPORT.md`).
