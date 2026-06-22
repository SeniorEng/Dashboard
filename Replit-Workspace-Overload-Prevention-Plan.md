# Replit-Workspace-Overload-Prevention-Plan (Task #541)

Dieser Plan verhindert dauerhaft, dass der Replit-Workspace beim Start überlastet
(RAM/OOM, Preview-Disconnects).

## Ursache (RCA)

Replit erzeugt einen Sammel-Workflow `Project`, der **alle** Workflows
**parallel** startet. Solange der Run-Button (`runButton` in `.replit`) auf
`Project` zeigt, fährt jeder Workspace-Start sechs schwere Tasks gleichzeitig
hoch:

- `Start application` (App-Server)
- `typecheck` (`npm run check`)
- `lint` (`npm run lint`)
- `test` (volle Vitest-Suite über Wegwerf-DB)
- `billing-cov` (Coverage-Gate mit eigenem Dev-Server)
- `e2e-smoke` (Playwright + Wegwerf-DB)

Das sprengt den begrenzten Workspace-Speicher → OOM, abgebrochene Preview,
`spawn EAGAIN` (Prozess-/Thread-Limit erschöpft).

## Schutzschichten (L1–L6)

### L1 — Boot startet nur die App
Der Run-Button muss auf **`Start application`** zeigen (einmalig im
Run-Dropdown oben setzen → wird dauerhaft in `.replit` als
`runButton = "Start application"` gespeichert). Die fünf Check-Workflows bleiben
**erhalten** und werden bei Bedarf **einzeln** aus dem Workflow-Panel gestartet.
Zusätzlich gibt es den sequentiellen Workflow **`Full QA Check`**
(`typecheck → lint → test`, ohne `e2e-smoke`/`billing-cov`) für einen geordneten
Komplettlauf in einem Worker.

> ⚠️ Der Sammel-Workflow **`Project` ist Legacy — NICHT klicken.** Er startet
> alles parallel und löst genau die Überlast aus, die dieser Plan verhindert.

### L2 — Playwright im Workspace gedrosselt
`playwright.config.ts` begrenzt die Worker im Replit-Workspace (und in CI) auf
**1** (`process.env.CI || REPL_ID || REPLIT_DEV_DOMAIN`). Nur auf einer lokalen
Entwickler-Maschine bleibt die Worker-Anzahl frei.

### L3 — Memory-Watchdog + Health-Sichtbarkeit
`server/lib/memory-watchdog.ts` prüft periodisch den Prozess-Speicher und
**warnt im Log**, bevor es kritisch wird. Schwellen über Env:
`MEMORY_WATCHDOG_WARN_MB` (Default 700) und `MEMORY_WATCHDOG_INTERVAL_MS`
(Default 30000). Der Timer ist `unref`'d (blockiert das Beenden nicht).
`/api/health` meldet zusätzlich live `memory.rssMB` / `memory.heapMB` /
`memory.heapTotalMB` und `uptime`.

### L4 — Architektur-Fitness-Function
`tests/architecture/replit-boot-path.test.ts` liest `.replit`, löst den
Boot-Pfad des `runButton` (inkl. `workflow.run`-Komposita) auf und schlägt fehl,
sobald ein schweres Test-/Check-/Coverage-Kommando beim Boot mitläuft. So kann
niemand versehentlich wieder auf den parallelen `Project`-Boot zurückfallen.

### L5 — Dokumentation
Boot-Disziplin und das Emergency-Restart-Playbook stehen in `replit.md`
(Abschnitt „Workspace-Boot & Stabilität").

### L6 — Dieser Präventionsplan
Diese Datei ist die zentrale Referenz für Ursache, Schutzschichten und Betrieb.

## Emergency-Restart-Playbook

Wenn der Workspace hängt / Preview tot ist / `spawn EAGAIN` auftritt:

1. **Heavy-Workflows stoppen:** Im Workflow-Panel laufende `test`,
   `billing-cov`, `e2e-smoke` (und ggf. `typecheck`/`lint`) per **Stop**
   beenden. `Project` **nicht** starten.
2. **App neu starten:** `Start application` neu starten (Run-Button oder Panel).
3. **Gesundheit prüfen:** `curl -s localhost:5000/api/health | jq '.memory'`
   — `rssMB` sollte deutlich unter dem Container-Limit liegen.
4. **Checks danach einzeln** laufen lassen, oder `Full QA Check` für einen
   sequentiellen `typecheck → lint → test`-Lauf.

## Nicht im Scope

Keine Ressourcen-Erhöhung, kein Löschen von Workflows, keine CI-Änderungen.
