# PDF-Rendering & Chromium (Puppeteer)

Detail-Runbook zum Chromium-/Puppeteer-Setup für die server-seitige PDF-Generierung.
Übergeordneter Projekt-README: [`../replit.md`](../replit.md).

## Chromium-Pfad für Puppeteer

`server/services/pdf-generator.ts` löst den Chromium-Binary-Pfad zur Laufzeit auf — `CHROMIUM_PATH`-Env (Override) → `which chromium`/`which chromium-browser` (Nix shim auf PATH) → System-Fallbacks `/usr/bin/chromium*`. KEIN hartcodierter Nix-Store-Hash mehr (der ändert sich bei jedem Deployment-Image-Rebuild und führte zu 30s-WS-Endpoint-Timeouts). Chromium wird über `.replit` (`nix.packages = ["chromium"]`) bereitgestellt; im Deployment kann zusätzlich `CHROMIUM_PATH` gesetzt werden. Fehlt das Binary, schlägt der Render schnell mit `ChromiumUnavailableError` fehl statt minutenlang zu hängen, und der Startup-PDF-Backfill überspringt sich selbst. Rechnungs-PDFs werden außerdem im Hintergrund (`setImmediate`) persistiert, damit `POST /api/billing/generate` nicht auf Puppeteer wartet — `GET /:id/pdf` und `/leistungsnachweis` rendern bei Cache-Miss on-demand nach (Task #544).

## Chromium-Launch-Härtung & Diagnose (Task #550)

Beim Boot läuft `runChromiumPreflight()` einmal und prüft via `chromium --version` (5s-Timeout), ob das Binary tatsächlich ausführbar ist — nicht nur existiert. Ergebnis wird gecached und unter `/api/health → chromium` exponiert. `getLaunchArgs()` schaltet `--single-process` in Production standardmäßig AB (Hauptverdacht für WS-Endpoint-Timeouts nach #544) und behält es in Dev/Test bei; per `PUPPETEER_SINGLE_PROCESS=1/0` und `PUPPETEER_NO_ZYGOTE=1/0` überschreibbar. Zusätzlich `--disable-software-rasterizer`, `--disable-extensions`, `--mute-audio`. `dumpio: true` ist aktiv, und ein Ring-Buffer (`getChromiumLogSnapshot`) fängt Chromium-stderr/stdout während des Launch-Fensters ab — beim Launch-Timeout landet der Crash-Grund (Missing-Lib, Segfault) im Fehler-Log statt nur dem generischen WS-Timeout. Backfill prüft jetzt `runChromiumPreflight().ok` und überspringt sich, wenn Chromium nicht startfähig ist. Diagnose-Skript: `npm run chromium:smoke` (führt Resolver + Pre-Flight + echten Launch + about:blank-Render in ≤20s aus, exit 0/1/2/3 mit Ring-Buffer-Dump im Fehlerfall).
