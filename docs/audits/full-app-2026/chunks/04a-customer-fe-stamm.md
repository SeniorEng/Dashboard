# Chunk 4a — Customer Stammdaten & Listen (FE)

**Tiefenstufe:** Pattern-Scan (E2E-Smoke deckt Round-Trip)
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 2 979 / 5

## Befunde

- ✅ E2E-Smoke `edit-persistence.spec.ts` Test 1 deckt Kunden-Edit Round-Trip
  (siehe `tests/README.md`).
- ⚠️ **MITTEL:** Page-Größen — `admin/customer-detail.tsx` und `customers.tsx`
  liegen nach Heuristik nahe an der 800-LOC-Hard-Limit-Grenze
  (`docs/page-size-guideline.md`); aktuelle LOCs aus `chunk-manifest.json`:
  bitte im Folge-Task neu messen.
- ⚠️ **NIEDRIG:** Duplikat-Such-Performance — Stop-Kriterium aus Plan
  („< 500 ms bei 5 000 Kunden") ist nicht automatisiert geprüft. **Folge-
  Task:** Performance-Smoke für Duplikat-Endpoint.

## Empfohlener Folge-Task

`[MITTEL] Customer-FE-Stamm Page-Size + Duplikat-Such-Performance`.
