> **Refresh #822 (2026-05-29, Commit `178b2574`):** Dieser Chunk wurde in der Refresh-Welle als **Pattern-Scan** behandelt (keine neuen KRITISCH/HOCH-Findings in dieser Domäne). Maßgeblich ist `../REPORT.md` (Severity-Counts, Vorgänger-Status §5). Inhalt unten stammt aus dem #481-Lauf @`3e0d3fb`.

# Chunk 5b — Appointments Frontend

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** HOCH
**LOC / Files:** 7 918 / 34

## Befunde

- ⚠️ **HOCH:** Größter Chunk (7 918 LOC, knapp unter 8 000-Cap). Plan §1.2
  fordert striktes Phase 1/2/3-Splitting; in dieser Sitzung **deferred**.
- 🔴 E2E-Smoke (Tests 6+7 für Termin-Round-Trips) ist aktuell rot wegen
  DB-Race beim Test-Setup — Stop-Kriterium aus Plan nicht erreichbar.
- ⚠️ **MITTEL:** Mobile-Scroll/Datepicker-Bugs aus offenem Backlog nicht
  pattern-scanbar; vertiefter Audit empfohlen.

## Empfohlener Folge-Task

`[HOCH] Appointments-FE Deep-Audit (Doku-Wizard + Mobile-Persistenz)`.
