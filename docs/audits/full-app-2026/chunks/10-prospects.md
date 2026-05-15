# Chunk 10 — Lead/Prospect Pipeline

**Tiefenstufe:** Pattern-Scan
**Commit:** `3e0d3fb`
**Risiko:** MITTEL
**LOC / Files:** 3 251 / 17

## Befunde

- ⚠️ **HOCH:** Threat-Model nennt `server/routes/prospects.ts` als High-Value-
  Anker für „role-scoping of employee-facing lead operations" — Pattern-Scan
  zeigt Datei existiert, aber kein automatisierter Role-Scope-Test in
  `tests/`. **Folge-Task:** Dedizierter Role-Scope-Sweep auf Prospects-Routes.
- ⚠️ **MITTEL:** `webhook-twilio.ts` hat 5 `console`-Logs → Logger-Konsolidierung.
- ⚠️ **MITTEL:** E-Mail-Parsing-Service — Injection-Surface bei Raw-Email-
  Bodies (Stored-XSS in `notes`-Anzeige). Verifizieren, dass Lead-Notes im
  Frontend escaped angezeigt werden.

## Empfohlener Folge-Task

`[HOCH] Prospects-Role-Scope + Email-Parsing-Injection-Sweep`.
