# Chunk 9a — Documents / Signing (Deep-Audit, Refresh #822)

**Commit:** `178b2574` · **Stand:** 2026-05-29 · **Tiefe:** Deep
**Skills:** Security · Error-Handling · Business-Logic

## Befunde

### MITTEL-1 — Template-Engine Defense-in-Depth
- `server/services/template-engine.ts:404` — `rawHtmlKeys` (customer_signature,
  employee_signature, company_logo) werden ohne erneute Validierung als Raw-HTML in den
  PDF-Render injiziert. Der **öffentliche** Signing-Pfad validiert die Data-URL bereits
  per Regex (`public-signing.ts:81`), aber interne/künftige Aufrufer könnten das umgehen.
  Fix: Validierungshelfer (Data-Image-URL-only) im Engine selbst. Effort S.

### NIEDRIG-1 — iframe srcDoc
- `client/src/features/documents/document-preview.tsx` — `srcDoc` mit `sandbox="allow-same-origin"`;
  an diesem Eintrittspunkt nicht zwingend sanitisiert. Fix: Sanitize/strikterer Sandbox.

### NIEDRIG-2 — Hardcoded HTML im Service
- `template-engine.ts:61` — Logo/Signatur-HTML-Struktur in den Service eingebettet
  (Wartbarkeit, in `wrapInPrintableHtml`/Fragment-Builder auslagern).

## Status Vorgänger-KRITISCH (alle verifiziert)
- **Signature-HTML-Injection (K3):** PARTIAL — Route-Regex-Validierung vorhanden,
  Engine-Defense-in-Depth offen (→ MITTEL-1).
- **Path-Traversal (K4):** FIXED — `document-pdf.ts:312` `path.posix.normalize` + `..`-Check + `/objects/`-Prefix.
- **Token-Claim-vs-PDF-Race (K5):** FIXED — Tx + `markSigningTokenUsed WHERE usedAt IS NULL`.
- **Object-Storage-ACL:** FIXED — `requireObjectAccess` record-level (employee/customer/generated docs).
- **Double-Signature:** FIXED — `documents.ts:689` `WHERE signingStatus='pending_employee_signature'` → 409.
- **DOMPurify:** FIXED — `public-signing.tsx`, `document-preview.tsx` mit Whitelist.
- **Rate-Limiting:** FIXED — `publicSigningLimiter` (20/min prod).
