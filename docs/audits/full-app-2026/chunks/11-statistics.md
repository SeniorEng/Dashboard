# Chunk 11 — Statistics & Cockpit

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL (hochgesetzt, da Finanz-KPIs gespiegelt)
**LOC / Files:** 6 922 / 25

## Befunde

- ✅ `tests/statistics.test.ts` (6 Tests) deckt Overview, Trends, Budget,
  Margen Smoke-Level.
- ⚠️ **MITTEL:** P95-Performance-Stop-Kriterium („≤ 800 ms aller Statistik-
  Endpoints") nicht automatisiert geprüft. **Folge-Task:** Performance-Smoke-
  Suite mit k6/autocannon für `/api/admin/statistics/*`.
- ⚠️ **MITTEL:** Aggregations-Korrektheit gegen Roh-Daten — Stop-Kriterium
  „Stichprobe bestätigt" ist menschlicher Akt; eigenes Folge-Ticket.

## Empfohlener Folge-Task

`[MITTEL] Statistics-Performance-Smoke + Aggregations-Korrektheit-Stichprobe`.
