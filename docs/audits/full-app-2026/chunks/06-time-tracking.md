# Chunk 6 — Time-Tracking & Vacation

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 5 566 / 27

## Befunde

- ✅ `tests/equality/pro-rata-vacation.test.ts` deckt das Stop-Kriterium.
- ✅ Auto-Pausen-Logik (ArbZG) hat eigenen Service-Modul + Tests.
- ⚠️ **MITTEL:** Mitarbeiter- vs. Admin-Totale-Identität (Plan-Cross-Ref
  „offener Backlog") nicht pattern-scanbar — vertiefter Audit empfohlen.
- ⚠️ **NIEDRIG:** `server/routes/time-entries.ts` hat 4 SuperAdmin-Gates —
  konsistent mit Monatsabschluss-Modell.

## Empfohlener Folge-Task

Bündel mit Chunk 5a in `[MITTEL] Appointments-BE + Time-Tracking Deep-Audit`.
