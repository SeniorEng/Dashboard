# Chunk 5a — Appointments Backend

**Tiefenstufe:** Pattern-Scan (53-Test-Suite deckt das Wesentliche)
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 5 359 / 11

## Befunde

- ✅ `tests/appointments.test.ts` 53 Tests + `tests/equality/pflegegrad-pricing`
  und `tests/equality/travel-cost` decken das Stop-Kriterium aus dem Plan.
- ✅ `tests/architecture/soft-delete-coverage.test.ts` läuft erfolgreich gegen
  Routes/Storage (Service-Module hat 1 Test rot — separater Tech-Debt-
  Folge-Task).
- ⚠️ **MITTEL:** 11 SuperAdmin-Stellen in `appointments.ts` — meiste Logik
  hängt an Admin-Gate. Per Stichprobe verifizieren, dass keine
  Datums-Vergangenheit-Bypass-Routes für Nicht-Admins existieren.
- ⚠️ **NIEDRIG:** Auto-Breaks-Service (ArbZG) laut Plan-Annotation
  „Cross-Ref Chunk 6"; im vertieften Audit verifizieren, dass nur ein
  Pfad ihn aufruft.

## Empfohlener Folge-Task

Teil eines übergreifenden `[MITTEL] Appointments-Backend Slot-Validation +
ArbZG-Pfad Deep-Audit` (zusammen mit Chunk 6).
