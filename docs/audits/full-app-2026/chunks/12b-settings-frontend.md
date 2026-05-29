> **Refresh #822 (2026-05-29, Commit `178b2574`):** Dieser Chunk wurde in der Refresh-Welle als **Pattern-Scan** behandelt (keine neuen KRITISCH/HOCH-Findings in dieser Domäne). Maßgeblich ist `../REPORT.md` (Severity-Counts, Vorgänger-Status §5). Inhalt unten stammt aus dem #481-Lauf @`3e0d3fb`.

# Chunk 12b — Settings Frontend

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL
**LOC / Files:** 5 016 / 11

## Befunde

- ✅ E2E-Smoke Test 10 (Firmenstammdaten-Telefon Round-Trip) deckt
  Persistenz.
- ⚠️ **HOCH:** Self-Demotion-Schutz von Superadmin (Stop-Kriterium) ist
  gleichzeitig in Chunk 2 als KRITISCH-Finding 4 identifiziert. UI-seitig
  bitte sicherstellen, dass der „Superadmin entfernen"-Button für eigene
  Row deaktiviert ist.
- ⚠️ **MITTEL:** 11 Files in der Größenordnung ~450 LOC/File im Schnitt;
  Page-Size-Guideline ist nicht verletzt, aber `admin/settings.tsx` knapp
  am Soft-Limit.

## Empfohlener Folge-Task

Im Chunk-2-Auth-Folge-Task mitnehmen; kein eigenes Ticket.
