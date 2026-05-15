# Chunk 3 — Customer-Domain Backend

**Tiefenstufe:** Pattern-Scan (breite Test-Suite vorhanden)
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 6 208 / 22

## Befunde

- ✅ `tests/customers.test.ts` (~50 Tests) deckt CRUD, Validierung,
  Pflegegrad, Deaktivierung.
- ✅ `customer-hard-delete.test.ts` deckt DSGVO-Anonymisierungs-Pfad.
- ⚠️ **HOCH:** Stichproben in `server/routes/customers/contacts.ts` zeigen,
  dass `contactId`-Path-Parameter genutzt werden — Threat-Model nennt das
  als „record binding check on secondary IDs"-Anker. Per Code-Walk
  verifizieren, dass jede contactId-Route ein **Customer-Ownership-Match**
  durchführt (nicht nur Existenz). **Folge-Task: dedizierter IDOR-Sweep
  über customers/contacts.ts, customers/documents.ts**.
- ⚠️ **MITTEL:** `server/routes/admin/customers.ts:5` hat 5 `console.log/error`-
  Aufrufe — verstößt gegen zentrales Logger-Pattern. **Folge-Task** in
  Code-Quality-Cleanup-Ticket.
- ⚠️ **MITTEL:** Pflegegrad-Sonderpreise — Audit-Log-Trigger laut Plan
  vorhanden, aber nicht pattern-scan-verifizierbar; vertiefter Audit
  empfohlen.

## Empfohlener Folge-Task

`[HOCH] IDOR-Sweep über Customer-Subresource-Routes (Contacts, Documents,
Pricing)`.
