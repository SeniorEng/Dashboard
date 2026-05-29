> **Refresh #822 (2026-05-29):** Deep-Dive-Refresh dieses Chunks. Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Maßgeblich bleibt `../REPORT.md` für die konsolidierten Severity-Counts.

# Chunk 16 — DevOps & Startup-Migrationen

**Tiefenstufe:** Deep (Refresh #822 — Gap-Fill Code-Walk)
**Commit:** `178b2574`
**Risiko:** MITTEL
**LOC / Files:** ~4 062 / 54 (`server/index.ts`, `server/lib/log.ts`, `server/startup/*`, Scheduler-Services)
**Code-Walk:** `server/index.ts` (Boot + `runStartupTasks` + Scheduler + Shutdown), `server/lib/log.ts`, Startup-Migrations-Kette

- ⚠️ **HOCH — Unbehandelte Startup-Schritte brechen die gesamte Migrations-/Seed-Kette ab** (`server/index.ts:168-645`): `runStartupTasks` umschließt **alle ~50 sequenziellen Schritte mit einem einzigen äußeren `try/catch`** (`:169` … `:643-645`). Mehrere Schritte sind **nicht** einzeln gewrappt — u. a. `serviceCatalogStorage.ensureSystemServices()` (`:201`), `documentStorage.ensureCustomerDocumentTypes()` (`:204`), `dropAppointmentsServiceTypeColumn()` (`:209`), `importPflegekassen()` (`:219`). Wirft einer davon, springt die Ausführung direkt in den äußeren Catch (`:644`) → **alle nachfolgenden Migrationen/Seeds/Backfills werden still übersprungen** (nur eine Logzeile „Kritischer Fehler bei Startup-Aufgaben"). Der Server bootet trotzdem und bedient Requests gegen ein potenziell halb-migriertes Schema. Schwer zu diagnostizieren, da kein Hinweis darauf, *welche* Schritte ausgelassen wurden.
  - **Folge:** Jeden Startup-Schritt einzeln in try/catch + Log kapseln (Muster ist bereits bei ~40 anderen Schritten vorhanden — die 4 ungewrappten angleichen), sodass ein Einzelfehler die restliche Kette nicht killt.

- ⚠️ **MITTEL — ~50 Startup-Tasks bei jedem Boot, viele einmalige Alt-Backfills** (Cross-Ref REPORT **N10**) (`server/index.ts:168-605`): Die Boot-Kette enthält zahlreiche historische One-Shot-Backfills (#576 `:468`, #601 `:430`, #643 `:417`, #684 `:443`, #685 `:455`, #728/#743 `:393`, …), die bei *jedem* Start erneut ihre Drift-/Waisen-Queries fahren, obwohl Production längst bereinigt ist. Erhöht Boot-Zeit und DB-Grundlast bei jedem Deploy/Cold-Start.
  - **Folge:** Abgeschlossene Backfills hinter einem persistenten „applied"-Flag (Migrations-Ledger) retiren statt bei jedem Boot zu re-evaluieren.

- ⚠️ **MITTEL — Scheduler an Boot-Offset statt Wall-Clock gekoppelt** (`server/index.ts:687-734`): Birthday-/Budget-Renewal-/Integrity-Checks laufen via `setTimeout(boot+X)` + `setInterval(6h/24h)` relativ zum Prozessstart, nicht als Wall-Clock-Cron. Häufige Deploys verschieben die effektiven Laufzeitpunkte und driften über Restarts. In Kombination mit dem Exact-Equality-Geburtstagshorizont (Chunk 14) verschärft das das Missed-Day-Risiko.
  - **Folge:** Zeitkritische Jobs auf Wall-Clock-Trigger (Berlin) umstellen; gemeinsam mit Chunk-14-Determinismus-Task.

- ⚠️ **MITTEL (Bestand) — Neon-Cold-Start-Race & Pre-Publish-Backup nicht CI-verankert** (aus #481, weiterhin gültig): DB-Startup-Race-500s in `auth/login` beim Neon-Warmup; `helmet`-CSP (`server/index.ts:24-36`) und Rate-Limiter (`:50-77`) sind gesetzt. Das Pre-Publish-Backup-Runbook existiert, ist aber nicht in einen automatisierten Pre-Deploy-Check eingehängt.
  - **Folge:** Retry-Wrapper im Auth-/Pool-Warmup + Pre-Publish-Backup-CI-Hook.

- ⚠️ **NIEDRIG — Logging-Senke ohne Levels/Struktur** (`server/lib/log.ts:1-10`): zentrale `log()` schreibt unstrukturiert via `console.log` ohne Log-Level/JSON; Scheduler-Catch-Blöcke umgehen sie teils mit direktem `console.error` (Cross-Ref M7). Erschwert Log-Aggregation/Alerting in Prod.

- ✅ **Graceful Shutdown sauber** (`server/index.ts:737-769`): alle `intervals`/`timeouts` werden getrackt und bei SIGTERM/SIGINT gecleart; Browser + DB-Pool werden gedrained; Forced-Exit-Fallback nach 10 s mit `.unref()`.
- ✅ **Neon-WebSocket-Treiberbug abgefangen** (`:96-124`): `unhandledRejection`/`uncaughtException` unterscheiden den nicht-fatalen Neon-Getter-Bug von echten Fatals.
- ✅ **API-Catch-All vor Vite-Fallback** (`:136-142`, Task #705): unbekannte `/api/*`-Requests liefern JSON-404 statt HTML.
- ✅ Idempotenz-Muster (`IF EXISTS`/Existenz-Check vor DDL) in den geprüften Migrations-Schritten sichtbar; Schema-DDL aus dem Startup wird laut Kommentar (`:491-500`) bewusst zugunsten von Storage-Guards vermieden (Replit-Publish-Diff-Problem).

## Empfohlener Folge-Task

`[HOCH] Startup-Robustheit: alle Startup-Schritte einzeln in try/catch kapseln (4 ungewrappte: index.ts:201/204/209/219), abgeschlossene One-Shot-Backfills hinter Migrations-Ledger retiren, zeitkritische Scheduler auf Wall-Clock(Berlin) umstellen, Neon-Cold-Start-Retry + Pre-Publish-Backup-CI-Hook.`
