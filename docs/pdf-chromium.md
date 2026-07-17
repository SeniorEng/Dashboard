# PDF-Rendering & Chromium (Puppeteer)

Detail-Runbook zum Chromium-/Puppeteer-Setup für die server-seitige PDF-Generierung.
Übergeordneter Projekt-README: [`../replit.md`](../replit.md).

## Chromium-Pfad für Puppeteer

`server/services/pdf-generator.ts` löst den Chromium-Binary-Pfad zur Laufzeit auf — `CHROMIUM_PATH`-Env (Override) → `which chromium`/`which chromium-browser` (Nix shim auf PATH) → System-Fallbacks `/usr/bin/chromium*`. KEIN hartcodierter Nix-Store-Hash mehr (der ändert sich bei jedem Deployment-Image-Rebuild und führte zu 30s-WS-Endpoint-Timeouts). Chromium wird über `.replit` (`nix.packages = ["chromium"]`) bereitgestellt; im Deployment kann zusätzlich `CHROMIUM_PATH` gesetzt werden. Fehlt das Binary, schlägt der Render schnell mit `ChromiumUnavailableError` fehl statt minutenlang zu hängen, und der Startup-PDF-Backfill überspringt sich selbst. Rechnungs-PDFs werden außerdem im Hintergrund (`setImmediate`) persistiert, damit `POST /api/billing/generate` nicht auf Puppeteer wartet — `GET /:id/pdf` und `/leistungsnachweis` rendern bei Cache-Miss on-demand nach (Task #544).

## Chromium-Launch-Härtung & Diagnose (Task #550)

Beim Boot läuft `runChromiumPreflight()` einmal und prüft via `chromium --version` (5s-Timeout), ob das Binary tatsächlich ausführbar ist — nicht nur existiert. Ergebnis wird gecached und unter `/api/health → chromium` exponiert. `getLaunchArgs()` schaltet `--single-process` in Production standardmäßig AB (Hauptverdacht für WS-Endpoint-Timeouts nach #544) und behält es in Dev/Test bei; per `PUPPETEER_SINGLE_PROCESS=1/0` und `PUPPETEER_NO_ZYGOTE=1/0` überschreibbar. Zusätzlich `--disable-software-rasterizer`, `--disable-extensions`, `--mute-audio`. `dumpio: true` ist aktiv, und ein Ring-Buffer (`getChromiumLogSnapshot`) fängt Chromium-stderr/stdout während des Launch-Fensters ab — beim Launch-Timeout landet der Crash-Grund (Missing-Lib, Segfault) im Fehler-Log statt nur dem generischen WS-Timeout. Backfill prüft jetzt `runChromiumPreflight().ok` und überspringt sich, wenn Chromium nicht startfähig ist. Diagnose-Skript: `npm run chromium:smoke` (führt Resolver + Pre-Flight + echten Launch + about:blank-Render in ≤20s aus, exit 0/1/2/3 mit Ring-Buffer-Dump im Fehlerfall).

## Launch-Timeout & Retry-Budget (Task #1467)

Production-Cold-Starts in der Autoscale-Umgebung emittieren die WS-Endpoint-URL (`DevTools listening on ws://…`) teilweise erst **nach** den ursprünglichen 20s — Chromium startet, nur zu langsam. Der harte 20s-Launch-Timeout ließ damit *jeden* Render scheitern und die Rechnung blieb (mangels `pdfPath`) dauerhaft im roten „PDF-Fehler"-Badge hängen. Daher:

- **`BROWSER_LAUNCH_TIMEOUT_MS`** — Launch-Timeout in ms, env-konfigurierbar. Default jetzt **60s in Production**, 20s in Dev/Test (schnelles Feedback). Der Race-Guard-Timer und der Puppeteer-`timeout`-Wert ziehen denselben Wert; der Protocol-Timeout (`BROWSER_PROTOCOL_TIMEOUT_MS`) ist `max(45s, Launch-Timeout)`, damit er bei langsamen Cold-Starts nicht zur neuen Engstelle wird.
- **„Execution context was destroyed, most likely because of a navigation."** wird in `isRecoverablePuppeteerError()` jetzt als recoverable behandelt: Der Singleton-Browser wird verworfen/recycelt und der Render erneut versucht, statt den (Hintergrund-)Persist-Versuch zu verbrennen.
- **`BACKGROUND_PDF_MAX_ATTEMPTS`** (Default **4**) und **`BACKGROUND_PDF_RETRY_DELAY_MS`** (Default 30s, linear ×Versuch) im `invoice-pdf-orchestrator` sind env-konfigurierbar. Der letzte Fehlschlag schreibt weiterhin den `invoice_pdf_persist_failed`-Audit-Eintrag.

**Stuck-Rechnungen reparieren:** Der Startup-Backfill `backfillInvoicePdfs()` rendert pro Boot bis zu 20 Rechnungen mit leerem `pdfPath` (GoBD-byte-stabil aus dem `render_snapshot`) neu — nach dem Publish des Launch-Fixes löst er die Badges von RE-2026-0309 (#309), #310 und Geschwistern auf. Größere Rückstände in mehreren Boots. **Verifikation nach Publish:** `/api/health → chromium` muss `ok` melden, eine frisch erzeugte Rechnung darf den Badge nicht zeigen, und die zuvor steckengebliebenen Rechnungen haben jetzt ein PDF.

## Cold-Start-Stampede entzerren (Task #1494)

**Symptom:** In Production (Autoscale) reißt *jede* PDF-Generierung den 60s-Launch-Timeout. In den Logs taucht u.a. `network_service_instance_impl.cc … Network service crashed, restarting service` auf — das ist ein **Symptom**, nicht die Ursache.

**Wurzel:** Autoscale skaliert auf 0 und startet bei Last mehrere Instanzen **gleichzeitig**. Jede Instanz wärmt beim Boot Chromium an und liest das Binary + dessen Shared-Libs **kalt** aus demselben `/nix/store`-Image-Layer. Die simultanen Cold-Reads konkurrieren um Disk-I/O (und CPU), sodass jeder einzelne `puppeteer.launch` so langsam wird, dass er den (bewusst nicht gesenkten) 60s-Timeout reißt. Das ist ein klassischer **Cold-Start-Stampede**.

**Gebaute Hebel** (alle non-blocking, best-effort, env-tunebar; Defaults greifen nur in Production, in Dev/Test = 0/aus):

| Hebel | Wo | Default (Prod) | Env |
| --- | --- | --- | --- |
| (a) **Jitter** vor dem Boot-Pre-Warm | `server/index.ts` | 0–8000ms zufällig | `CHROMIUM_PREWARM_JITTER_MS` |
| (b) **Advisory-Lock** über die DB (instanzübergreifend) | `server/index.ts` | Lock-Inhaber wärmt sofort, andere warten 6000ms | `CHROMIUM_PREWARM_LOCK_WAIT_MS` |
| (c) **Page-Cache-Warming** von Binary + `ldd`-Libs | `warmChromiumBinaryCache()` in `pdf-generator.ts` | immer (vor 1. Launch) | — |
| (d) **Retry mit jitterndem Backoff** im Pre-Warm | `prewarmBrowser()` | 3 Versuche, Basis 2000ms | `CHROMIUM_PREWARM_MAX_ATTEMPTS`, `CHROMIUM_PREWARM_RETRY_DELAY_MS` |

- (a)+(b) sorgen dafür, dass nicht alle Instanzen denselben Layer im selben Moment kalt lesen. Die DB ist die einzige geteilte Ressource der Autoscale-Instanzen → `pg_try_advisory_lock` (nicht-blockierend) koordiniert das Pre-Warm instanzübergreifend; der Boot hängt **nie** am Lock (jeder DB-Fehler/Engpass = leise weiter wärmen).
- (c) senkt die Kosten **jedes** Cold-Launch, indem Binary + `.so`-Dateien vorab in den OS-Page-Cache gelesen werden (1-MiB-Fenster, konstanter Speicher, idempotent pro Prozess).
- (d) ist ein Sicherheitsnetz: reißt der erste Launch trotz Entzerrung, bleibt die Instanz nicht dauerhaft kalt. Kein Doppel-Launch — jeder Versuch geht durch das `getBrowser()`-Singleton; zwischen Versuchen wird eine verwaiste Instanz verworfen.

**Bewusst NICHT angefasst** (Determinismus/GoBD): Render-Pfad, `pdf_hash`/ZUGFeRD-Byte-Stabilität, `pipe=true`, `getBrowser`-Singleton, `withFreshPage`-Retries, Render-Semaphor (`PDF_RENDER_CONCURRENCY`), Background-Retry, der 60s-Launch-Timeout und der Chromium-stderr-Ring-Buffer. `--single-process` bleibt reiner Env-Override (Default in Prod AUS, siehe oben) — es würde den Network-Service-Restart höchstens kaschieren und ist unter Memory-Druck selbst eine Crash-Quelle.

## Strukturelle Wurzel-Elimination — Entscheidung: Autoscale bleibt (Task #1499)

Der Stampede entsteht nur, weil Autoscale kalt aus 0 hochfährt. Eine **Reserved VM** (dauerhaft warme Instanz) hätte gar keinen Boot-Stampede — Chromium wäre nach dem ersten Pre-Warm permanent heiß und die ganze Cold-Start-Klasse (#544, #1467, #1494) verschwände strukturell statt nur entzerrt zu sein.

**Bewertete Optionen:**

| Option | Vorteil | Nachteil |
| --- | --- | --- |
| **Reserved VM** (`deploymentTarget = "vm"`) | Chromium permanent heiß → Cold-Start-Stampede strukturell beseitigt; keine PDF-Fehler-Badges mehr aus diesem Grund | Läuft rund um die Uhr kostenpflichtig (auch im Leerlauf nachts/Wochenende); eine feste Instanz, kein Auto-Scale (bei dem überschaubaren Nutzerprofil aber unkritisch) |
| **Autoscale** (Status quo, `deploymentTarget = "autoscale"`) | Skaliert auf 0, zahlt nur bei Last → deutlich günstiger | Cold-Start durch die #1494-Hebel nur entzerrt, nicht beseitigt; unter ungünstigem Timing weiterhin Verzögerung/Retry möglich |

**Entscheidung (Alrik, 2026-06-30): Autoscale bleibt.** Der Kostenvorteil wiegt schwerer als die verbleibende Cold-Start-Restwahrscheinlichkeit; ein gelegentlicher Render-Retry ist akzeptabel. Die in #1494 gebauten Hebel (Jitter, instanzübergreifender Advisory-Lock, Page-Cache-Warming, Retry-Backoff) **sind damit der bewusst gewählte, akzeptierte Ansatz** — nicht nur ein Provisorium bis zu einer VM-Migration. Das Sicherheitsnetz (Hintergrund-Retry im `invoice-pdf-orchestrator` + Startup-Backfill `backfillInvoicePdfs()`) fängt verbleibende Fehlschläge auf. `.replit` (`[deployment] deploymentTarget = "autoscale"`) bleibt unverändert.

**Re-Evaluierung sinnvoll, falls** sich das Lastprofil ändert (deutlich höhere PDF-Frequenz / mehr gleichzeitige Nutzer), die #1494-Hebel die Cold-Start-Fehler nicht mehr ausreichend dämpfen, oder Reserved-VM-Kosten/Plan-Konditionen die Rechnung kippen. Dann ist der Umzug ein reiner `deployConfig({ deploymentTarget: "vm", run: [...] })`-Schritt (Run-Command aus dem `[deployment]`-Block übernehmen) plus erneuter Publish.

## Autoscale-Maschinengröße (vCPU/RAM) — Right-Sizing-Sondierung (Task #1805)

Autoscale rechnet **Compute-Zeit × Maschinenstärke (vCPU/RAM) × Instanzen** ab. Die Maschinengröße wurde nie gegen den echten Bedarf gemessen — Verdacht: großzügig gewählt, damit die Chromium/PDF-Spitze passt, wodurch **jeder** normale Request Headroom mitbezahlt. Diese Sondierung misst den echten Fußabdruck und leitet die kleinste sichere Stufe ab. Der Deployment-**Typ** bleibt Autoscale (siehe #1499); nur die **Größe** stand zur Debatte.

**Gemessener Fußabdruck (Prod, 2026-07-17, warme Instanz):**

- **Steady-State Node-RSS: ~201 MB** (heapUsed ~65 MB, heapTotal ~73 MB), über mehrere Samples praktisch konstant — abgelesen live aus `/api/health → memory` der laufenden Prod-Instanz.
- **Memory-Watchdog: keine einzige WARN-Zeile in den Prod-Logs.** Der RSS bleibt also weit unter der Watchdog-Schwelle (`MEMORY_WATCHDOG_WARN_MB`, Default 700–1024 MB). In Prod ist niemals ein OOM oder eine RSS-Eskalation aufgetreten.
- Die einzigen Render-Fehlschläge in den Logs sind **Chromium-Cold-Start-Timeouts** (Integrity-Check-Navigation/PDF-Timeout) — das ist die bereits in #1494/#1499 behandelte Cold-Start-Klasse, **kein Speicherproblem**.

**Sizing-Treiber ist Chromium, nicht Node.** `process.memoryUsage()` (und damit `/api/health` + Watchdog) sieht nur den Node-Prozess; das gerenderte Chromium läuft als **eigener Prozess** und geht nicht in diese ~201 MB ein. Die Maschinen-RAM muss also Node (~200 MB steady) **plus** die transiente Chromium-Render-Spitze (grob ~0,3–0,7 GB pro Render, `PDF_RENDER_CONCURRENCY`-begrenzt) tragen → Peak-Bedarf grob **~1 GB**.

**Empfehlung: 1 vCPU / 2 GiB (Autoscale-Default) ist die kleinste sichere Stufe — nicht kleiner gehen.**

- Eine kleinere Stufe **0,5 vCPU / 1 GiB** ist riskant auf **beiden** Achsen: 1 GiB RAM deckt Node + eine gleichzeitige Chromium-Render-Spitze nur knapp → OOM-Gefahr (verstößt gegen „kein OOM reintroduzieren"); und der geteilte/fraktionale vCPU **verlangsamt den Chromium-Launch** → verschärft genau die Cold-Start-Timeouts, die wir in den Logs schon sehen (verstößt gegen „Cold-Start nicht verschlechtern").
- 2 GiB clearen die gemessene ~1-GB-Peak mit komfortablem Watchdog-Sicherheitsabstand; die Node-Grundlast (~201 MB) lässt reichlich Luft. Da Autoscale nur bei Last und skaliert nach Instanzen abrechnet, kostet der 2-GiB-Kopfraum im Leerlauf nichts extra.

**Anwendung / Grenze des Hebels:** Die Autoscale-Maschinengröße ist **kein `.replit`-Feld** und **nicht über `deployConfig()` setzbar** (das akzeptiert nur `deploymentTarget`/`run`/`build`/`publicDir`). Sie wird ausschließlich im **Publishing-Tool → Advanced (Machine power / vCPU-RAM)** durch den Nutzer beim Publish gewählt. Der Agent kann sie nicht programmatisch lesen oder ändern. Handlungsempfehlung an Alrik: beim nächsten Publish im Advanced-Bereich sicherstellen, dass **1 vCPU / 2 GiB** gewählt ist; ist bereits eine größere Stufe aktiv, auf 1 vCPU / 2 GiB reduzieren und danach eine Live-Rechnung erzeugen (PDF rendert, kein OOM, kein rotes „PDF-Fehler"-Badge). Eine noch kleinere Stufe ist aus den obigen Gründen bewusst **nicht** empfohlen — damit ist dieser Kostenhebel geschlossen.

**Re-Evaluierung sinnvoll, falls** die PDF-Frequenz/Parallelität deutlich steigt (dann eher `PDF_RENDER_CONCURRENCY` + Stufe gemeinsam betrachten) oder Replit die Autoscale-Stufen-Staffelung/Preise ändert.
