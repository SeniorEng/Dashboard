> **Refresh #822 (2026-05-29, Commit `178b2574`):** Dieser Chunk wurde in der Refresh-Welle als **Pattern-Scan** behandelt (keine neuen KRITISCH/HOCH-Findings in dieser Domäne). Maßgeblich ist `../REPORT.md` (Severity-Counts, Vorgänger-Status §5). Inhalt unten stammt aus dem #481-Lauf @`3e0d3fb`.

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
