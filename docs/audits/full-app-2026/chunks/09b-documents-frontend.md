# Chunk 9b — Documents Frontend

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 3 327 / 8

## Befunde

- ✅ SignaturePad-SSoT eingehalten — `<canvas` außerhalb `signature-pad.tsx`
  ergab 0 Treffer.
- ⚠️ **HOCH:** `dangerouslySetInnerHTML` in `public-signing.tsx` und
  `document-templates.tsx` — wenn Template-Body Admin-editierbar ist, ist
  hier eine **Stored-XSS-Surface** für PII-Anzeige im Public-Signing-Kontext.
  Folge-Task identisch mit Foundation-Sub-Report.

## Empfohlener Folge-Task

Mit Chunk 9a-Tickets bundeln: `[HOCH] Template-Sanitization vor
HTML-Injection (Stored-XSS-Risiko)`.
