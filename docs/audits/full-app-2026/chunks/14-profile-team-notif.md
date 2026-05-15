# Chunk 14 — Profile, Team, Notifications, Tasks

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL
**LOC / Files:** 7 523 / 45

## Befunde

- ✅ `tests/notifications.test.ts` 12 Tests (alle grün außer DB-Race-Setup-
  Issue) decken Self-Assign-Schutz, Mitarbeiter-Wechsel-Notifications.
- ⚠️ **MITTEL:** Größter MITTEL-Chunk (45 Files / 7 523 LOC). Plan §1.2
  fordert striktes Phase-Splitting. Für Pattern-Scan-Tiefe akzeptabel; tieferer
  Audit nur dann nötig, wenn ein KRITISCH-Finding aus Chunk 2/12a darauf
  zeigt.
- ⚠️ **NIEDRIG:** Geburtstags-Erinnerungen Zeitzone-Berlin (Stop-Kriterium)
  in `tests/auto-close-scheduler.test.ts` teilweise abgedeckt, aber dieser
  Test ist aktuell rot (1 failed) — separater Folge-Task.

## Empfohlener Folge-Task

`[MITTEL] Profile-Team-Notif Deep-Audit` — kein blockierendes Finding,
aber großer Chunk verdient eigene tiefere Welle.
