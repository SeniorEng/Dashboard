/**
 * Task #550 — Standalone-Diagnose-Skript für Chromium-Launch.
 *
 * Aufruf:  npm run chromium:smoke
 *
 * Was es macht (in ≤20s):
 *   1. Löst den Chromium-Binary-Pfad via resolveChromiumPath() auf.
 *   2. Führt das Pre-Flight (chromium --version) aus.
 *   3. Versucht einen echten puppeteer.launch + about:blank-Render mit
 *      dumpio + denselben Args wie der Produktionscode.
 *   4. Beendet den Browser sauber und meldet OK / FAIL inkl. Chromium-stderr.
 *
 * Exit-Codes:
 *   0 = OK
 *   2 = Binary nicht gefunden
 *   3 = Pre-Flight scheitert (Binary nicht ausführbar)
 *   1 = Launch oder Render scheitert
 */
import puppeteer from "puppeteer-core";
import {
  resolveChromiumPath,
  runChromiumPreflight,
  getLaunchArgs,
  getChromiumLogSnapshot,
} from "../server/services/pdf-generator";

const TOTAL_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const start = Date.now();
  const path = resolveChromiumPath();
  console.log(`[smoke-chromium] Binary-Pfad: ${path ?? "NICHT GEFUNDEN"}`);
  if (!path) {
    console.error(
      "[smoke-chromium] FAIL: Chromium-Binary nicht auffindbar. " +
        "CHROMIUM_PATH-Env setzen oder Chromium über das Deployment-Image bereitstellen.",
    );
    process.exit(2);
  }

  const preflight = runChromiumPreflight();
  console.log(`[smoke-chromium] Pre-Flight: ${JSON.stringify(preflight)}`);
  if (!preflight.ok) {
    console.error(`[smoke-chromium] FAIL: Pre-Flight nicht erfolgreich — ${preflight.error}`);
    process.exit(3);
  }

  const args = getLaunchArgs();
  console.log(`[smoke-chromium] Launch-Args: ${JSON.stringify(args)}`);

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await Promise.race([
      puppeteer.launch({
        executablePath: path,
        headless: true,
        dumpio: true,
        timeout: 15_000,
        protocolTimeout: 15_000,
        args,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Launch überschritt ${TOTAL_TIMEOUT_MS}ms`)),
          TOTAL_TIMEOUT_MS,
        ),
      ),
    ]);
    const page = await browser.newPage();
    await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 });
    console.log(`[smoke-chromium] OK in ${Date.now() - start}ms — Chromium-Version: ${preflight.version}`);
  } catch (err) {
    const dump = getChromiumLogSnapshot(60);
    console.error(`[smoke-chromium] FAIL nach ${Date.now() - start}ms: ${err}`);
    if (dump) {
      console.error(`[smoke-chromium] Chromium-Output (Ring-Buffer):\n${dump}`);
    } else {
      console.error("[smoke-chromium] Chromium-Output: (leer — Prozess hat nichts geschrieben)");
    }
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error("[smoke-chromium] Unerwarteter Fehler:", err);
  process.exit(1);
});
