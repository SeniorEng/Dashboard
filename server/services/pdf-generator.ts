import puppeteer, { type Browser, type Page } from "puppeteer-core";
import crypto from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { wrapInPrintableHtml } from "./template-engine";

// Chromium legt sein User-Data-Dir sonst nach $HOME/.config/chromium INNERHALB
// des Workspaces ab (mehrere GiB Profil-/Cache-Müll). Beim Replit-Publish wird
// der gesamte Workspace ins Deployment-Image gepackt → das Image sprengt die
// 8-GiB-Cloud-Run-Grenze ("image size is over the limit of 8 GiB").
// Lösung: User-Data-Dir bewusst NACH /tmp (außerhalb des Workspaces, ephemer,
// wird NICHT mitdeployt).
//
// Task #1323: Pro `puppeteer.launch()` ein EIGENES Verzeichnis (pid + monoton
// steigender Zähler + Zufallssuffix). Ein nur aus `process.pid` abgeleitetes
// Dir ist über alle Browser-Starts EINES Prozesses hinweg konstant — wird der
// Browser nach einem recoverable Error verworfen und neu gestartet, hält der
// alte Chromium-Prozess den `SingletonLock` im selben Profilordner noch und der
// nächste Launch bricht mit „browser is already running" ab. Eindeutige Dirs
// pro Launch umgehen den Lock; verwaiste Dirs werden beim Verwerfen/Beenden des
// Browsers best-effort aufgeräumt, damit /tmp nicht zumüllt.
let chromiumUserDataDirCounter = 0;

// Verknüpft jede Browser-Instanz mit ihrem Profilordner, damit
// discardBrowser() und der `disconnected`-Handler ihn wieder löschen können.
const browserUserDataDirs = new WeakMap<Browser, string>();

function makeChromiumUserDataDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `careconnect-chromium-${process.pid}-${chromiumUserDataDirCounter++}-${crypto
      .randomBytes(4)
      .toString("hex")}`,
  );
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // mkdir best-effort; Puppeteer legt das Verzeichnis sonst selbst an.
  }
  return dir;
}

function cleanupChromiumUserDataDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort; Profilordner liegt in os.tmpdir() und wird sonst beim
    // nächsten /tmp-Cleanup entfernt.
  }
}

// Task #521: harte Timeouts gegen "Network.enable timed out" Hänger.
// In Produktion zeigte sich: Puppeteer-CDP-Verbindungen können nach längerer
// Idle-Zeit "tot" sein — newPage() blockiert dann 180s, bis Puppeteer von
// selbst aufgibt. Wir setzen den Protocol-Timeout deutlich niedriger (45s)
// und verwerfen den Browser bei jedem ProtocolError, sodass der nächste
// Render eine frische Instanz hochfährt.
// Task #1467: Launch-Timeout env-konfigurierbar mit höherem Production-Default.
// Production-Cold-Starts in der Autoscale-Umgebung emittieren die WS-Endpoint-URL
// teils erst NACH den bisherigen 20s (`DevTools listening on ws://…` taucht im
// Log nach der Deadline auf — Chromium startet, nur zu langsam). Der 20s-Timeout
// ließ damit JEDEN Render scheitern. Wir heben den Default in Production auf 60s
// an (Dev/Test bleiben bei 20s für schnelles Feedback) und machen ihn per
// `BROWSER_LAUNCH_TIMEOUT_MS` überschreibbar.
function resolveBrowserLaunchTimeoutMs(): number {
  const raw = process.env.BROWSER_LAUNCH_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return process.env.NODE_ENV === "production" ? 60_000 : 20_000;
}

// Task #544: harter Launch-Timeout, damit Puppeteer nicht 30s+ auf eine
// WS-Endpoint-URL eines nie startenden Prozesses wartet.
const BROWSER_LAUNCH_TIMEOUT_MS = resolveBrowserLaunchTimeoutMs();
// Der Protocol-Timeout (einzelne CDP-Calls, u.a. während des Launch-Handshakes)
// darf nicht UNTER dem Launch-Timeout liegen, sonst würde er bei langsamen
// Cold-Starts zur neuen Engstelle. Mindestens 45s (Task #521), sonst Launch-Wert.
const BROWSER_PROTOCOL_TIMEOUT_MS = Math.max(45_000, BROWSER_LAUNCH_TIMEOUT_MS);
const PAGE_RENDER_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;
let resolvedChromiumPath: string | null = null;
let chromiumResolutionLogged = false;

// Task #550: Ring-Buffer für Chromium-stderr/stdout während des Launch-Fensters.
// Wenn der WS-Endpoint nicht erscheint, brauchen wir den eigentlichen Crash-
// Grund (Missing-Lib, Segfault, OOM) im Log — nicht nur den generischen
// Timeout. Wir kapern process.stderr.write/process.stdout.write nur für die
// Dauer eines Launches und stellen die Originale danach wieder her.
const CHROMIUM_LOG_BUFFER_MAX_LINES = 200;
const chromiumLogBuffer: string[] = [];

function appendChromiumLog(chunk: string): void {
  const text = chunk.replace(/\r/g, "");
  if (!text) return;
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    chromiumLogBuffer.push(trimmed);
    if (chromiumLogBuffer.length > CHROMIUM_LOG_BUFFER_MAX_LINES) {
      chromiumLogBuffer.shift();
    }
  }
}

export function getChromiumLogSnapshot(maxLines = 40): string {
  return chromiumLogBuffer.slice(-maxLines).join("\n");
}

export function resetChromiumLogBuffer(): void {
  chromiumLogBuffer.length = 0;
}

// Task #544: Chromium-Pfad robust auflösen statt einen konkreten Nix-Store-Hash
// hart zu pinnen (der Hash ändert sich bei jedem Rebuild des Deployment-Images).
// Reihenfolge:
//   1. CHROMIUM_PATH-Env (Override für Deployments)
//   2. `which chromium` / `which chromium-browser` (Nix shim auf PATH)
//   3. Bekannte System-Pfade (/usr/bin/...)
function whichBinary(name: string): string | null {
  try {
    const out = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    /* not found on PATH */
  }
  return null;
}

const FALLBACK_BINARY_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

export function resolveChromiumPath(): string | null {
  if (resolvedChromiumPath) return resolvedChromiumPath;

  const candidates: Array<{ source: string; path: string | null }> = [];
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath) candidates.push({ source: "CHROMIUM_PATH env", path: envPath });
  candidates.push({ source: "which chromium", path: whichBinary("chromium") });
  candidates.push({ source: "which chromium-browser", path: whichBinary("chromium-browser") });
  for (const p of FALLBACK_BINARY_PATHS) {
    candidates.push({ source: `fallback ${p}`, path: p });
  }

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      resolvedChromiumPath = c.path;
      if (!chromiumResolutionLogged) {
        console.log(`[pdf-generator] Chromium gefunden via ${c.source}: ${c.path}`);
        chromiumResolutionLogged = true;
      }
      return resolvedChromiumPath;
    }
  }

  if (!chromiumResolutionLogged) {
    console.error(
      `[pdf-generator] Chromium NICHT gefunden auf Host ${os.hostname()}. Geprüfte Quellen: ` +
        candidates.map((c) => `${c.source}=${c.path ?? "—"}`).join("; "),
    );
    chromiumResolutionLogged = true;
  }
  return null;
}

/**
 * Task #544: Health-Check für Chromium-Verfügbarkeit. Wird von Startup-
 * Backfills aufgerufen, damit sie nicht durch N × 30s-Retries laufen, wenn
 * Chromium im Deployment-Image gar nicht installiert ist.
 */
export function isChromiumAvailable(): boolean {
  return resolveChromiumPath() !== null;
}

// Task #550: Pre-Flight beim Server-Start. Prüft nicht nur Binary-Existenz
// (das macht resolveChromiumPath), sondern auch, ob das Binary überhaupt
// ausführbar ist. Verhindert minutenlange Backfill-Retries gegen ein totes
// Binary (z.B. wegen fehlender shared libs).
export type ChromiumPreflightResult =
  | { ok: true; path: string; version: string }
  | { ok: false; path: string | null; error: string };

let chromiumPreflightResult: ChromiumPreflightResult | null = null;

export function runChromiumPreflight(force = false): ChromiumPreflightResult {
  if (chromiumPreflightResult && !force) return chromiumPreflightResult;
  const path = resolveChromiumPath();
  if (!path) {
    chromiumPreflightResult = {
      ok: false,
      path: null,
      error: "Chromium-Binary auf diesem Host nicht gefunden",
    };
    return chromiumPreflightResult;
  }
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    chromiumPreflightResult = { ok: true, path, version: out };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chromiumPreflightResult = { ok: false, path, error: message };
  }
  return chromiumPreflightResult;
}

export function getChromiumPreflightResult(): ChromiumPreflightResult | null {
  return chromiumPreflightResult;
}

export class ChromiumUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      "PDF-Engine (Chromium) ist auf diesem Server nicht installiert. " +
        "Bitte CHROMIUM_PATH setzen oder Chromium über das Deployment-Image bereitstellen." +
        (detail ? ` Details: ${detail}` : ""),
    );
    this.name = "ChromiumUnavailableError";
  }
}

/**
 * Task #550: Launch-Args konservativer und per Env steuerbar machen.
 *
 * - `--no-zygote` und `--single-process` zusammen sind eine bekannte Crash-
 *   Quelle in autoscale-Containern unter Memory-Druck. Wir behalten beides
 *   als getrennt steuerbare Flags und schalten `--single-process` in
 *   Production standardmäßig AB (Hauptverdacht für die WS-Endpoint-Timeouts
 *   nach #544).
 * - `--disable-software-rasterizer`, `--disable-extensions`, `--mute-audio`
 *   reduzieren unnötige Subsysteme.
 *
 * Env-Overrides (akzeptieren "1"/"true"/"0"/"false"):
 *   PUPPETEER_SINGLE_PROCESS — erzwingt/verbietet `--single-process`
 *   PUPPETEER_NO_ZYGOTE      — erzwingt/verbietet `--no-zygote`
 */
function envFlag(name: string): boolean | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  if (v === "1" || v.toLowerCase() === "true") return true;
  if (v === "0" || v.toLowerCase() === "false") return false;
  return null;
}

export function getLaunchArgs(): string[] {
  const isProd = process.env.NODE_ENV === "production";
  const singleProcessOverride = envFlag("PUPPETEER_SINGLE_PROCESS");
  const noZygoteOverride = envFlag("PUPPETEER_NO_ZYGOTE");

  // Default: in Production OHNE --single-process (Hauptverdacht für #550),
  // in Dev/Test bleibt das alte Verhalten erhalten, damit der lokale Stack
  // sich verhält wie vor #544.
  const useSingleProcess = singleProcessOverride !== null ? singleProcessOverride : !isProd;
  const useNoZygote = noZygoteOverride !== null ? noZygoteOverride : true;

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--mute-audio",
  ];
  if (useNoZygote) args.push("--no-zygote");
  if (useSingleProcess) args.push("--single-process");
  return args;
}

/**
 * Task #550: kapert process.stderr.write/process.stdout.write während eines
 * Launches, sodass Chromium-Output (dumpio: true) parallel in einen Ring-
 * Buffer geht. Originale werden in `restore()` wiederhergestellt.
 */
function capturePuppeteerOutput(): () => void {
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  const tap = (orig: typeof origErr) =>
    function tapped(
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      try {
        const text = typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString(
              typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
            );
        appendChromiumLog(text);
      } catch {
        /* never break stdout/stderr */
      }
      return orig(chunk as any, encodingOrCb as any, cb as any);
    };
  (process.stderr as any).write = tap(origErr);
  (process.stdout as any).write = tap(origOut);
  return () => {
    (process.stderr as any).write = origErr;
    (process.stdout as any).write = origOut;
  };
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumPath();
  if (!executablePath) {
    throw new ChromiumUnavailableError();
  }
  const args = getLaunchArgs();
  const userDataDir = makeChromiumUserDataDir();
  const restoreOutput = capturePuppeteerOutput();
  const launchPromiseInner = puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
    timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    // Task #550: dumpio = true, damit Chromium-stderr im Ring-Buffer landet
    // und beim Launch-Timeout zusammen mit der Fehlermeldung geloggt wird.
    dumpio: true,
    args,
  });
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Chromium-Launch überschritt ${BROWSER_LAUNCH_TIMEOUT_MS}ms (executablePath=${executablePath})`,
        ),
      );
    }, BROWSER_LAUNCH_TIMEOUT_MS + 1_000);
  });
  let browser: Browser;
  try {
    browser = await Promise.race([launchPromiseInner, timeoutPromise]);
  } catch (err) {
    const dump = getChromiumLogSnapshot(40);
    console.error(
      `[pdf-generator] Browser-Launch fehlgeschlagen (executablePath=${executablePath}, args=${JSON.stringify(args)}): ${err}` +
        (dump ? `\n[pdf-generator] Chromium-Output (letzte ${dump.split("\n").length} Zeilen):\n${dump}` : "\n[pdf-generator] Chromium-Output: (leer)"),
    );
    // Launch fehlgeschlagen → das eben angelegte (verwaiste) Profilverzeichnis
    // wieder entfernen, damit /tmp bei wiederholten Fehlversuchen nicht wächst.
    cleanupChromiumUserDataDir(userDataDir);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    restoreOutput();
  }
  browserUserDataDirs.set(browser, userDataDir);
  browser.on("disconnected", () => {
    if (browserInstance === browser) {
      browserInstance = null;
    }
    cleanupChromiumUserDataDir(browserUserDataDirs.get(browser));
    browserUserDataDirs.delete(browser);
  });
  return browser;
}

export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  if (launchPromise) {
    return launchPromise;
  }
  launchPromise = (async () => {
    try {
      const b = await launchBrowser();
      browserInstance = b;
      return b;
    } finally {
      launchPromise = null;
    }
  })();
  return launchPromise;
}

// Task #1479: Chromium beim Boot vorwärmen (PDF-Cold-Start vermeiden).
// Heute startet der Browser LAZY beim ersten PDF-Render — im Autoscale zahlt
// damit die erste echte PDF-Anfrage einer frischen Instanz den pathologisch
// langsamen Chromium-Cold-Launch (Binary-Erstzugriff aus /nix/store) auf dem
// kritischen Request-Pfad, wo das Launch-Timeout zuschlägt. Diese Funktion
// stößt EINEN Launch über das bestehende Singleton (`getBrowser`) an, sodass
// der Cost einmal beim Boot bezahlt wird.
//
// Garantien:
//  - WIRFT NIE (Fehler werden nur zurückgegeben, nie geworfen) — der Aufrufer
//    soll sie non-blocking nach dem HTTP-Listener anstoßen können.
//  - Kein Doppel-Launch, wenn bereits ein Browser verbunden ist.
//  - Bei nicht verfügbarem Chromium (kein Binary / ChromiumUnavailableError)
//    sauberer, leiser Abbruch ohne Launch-Versuch.
//  - Nutzt `getBrowser()` (Singleton + Single-in-flight-`launchPromise`):
//    rennt das Pre-Warm gegen einen gleichzeitigen ersten Render, teilen sich
//    beide denselben `launchPromise` → genau ein Launch.
export async function prewarmBrowser(): Promise<
  { ok: true; skipped?: boolean } | { ok: false; error: string }
> {
  // Bereits verbunden → nichts vorzuwärmen, kein zweiter Launch.
  if (browserInstance && browserInstance.connected) {
    return { ok: true, skipped: true };
  }
  // Chromium-Binary nicht auffindbar → leise abbrechen, keinen Launch wagen.
  if (!isChromiumAvailable()) {
    return { ok: false, error: "Chromium-Binary nicht verfügbar" };
  }
  try {
    await getBrowser();
    return { ok: true };
  } catch (err) {
    if (err instanceof ChromiumUnavailableError) {
      return { ok: false, error: "Chromium-Binary nicht verfügbar" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function discardBrowser(): Promise<void> {
  const b = browserInstance;
  browserInstance = null;
  if (b) {
    try {
      await b.close();
    } catch {
      // ignore; Prozess ist evtl. schon weg
    }
    // Profilordner explizit entfernen. Der `disconnected`-Handler räumt zwar
    // ebenfalls auf, aber bei einem hängenden/abgestürzten Browser feuert er
    // evtl. nicht zuverlässig; rmSync ist idempotent (force:true).
    cleanupChromiumUserDataDir(browserUserDataDirs.get(b));
    browserUserDataDirs.delete(b);
  }
}

export function isRecoverablePuppeteerError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  const message = (err as { message?: string }).message ?? "";
  return (
    name === "ProtocolError" ||
    name === "TargetCloseError" ||
    // Task #532: "Requesting main frame too early" tritt auf, wenn Chromium
    // unter --single-process beim ersten setContent() noch keinen Main-Frame
    // im CDP-FrameTree hat. Browser verwerfen und mit Warmup neu starten.
    // Task #594: "Navigating frame was detached" tritt unter paralleler
    // Render-Last auf (mehrere setImmediate-Persist-Calls + Test-Requests
    // teilen einen Browser). Page-Level transient — Browser bleibt nutzbar.
    // Task #1467: "Execution context was destroyed, most likely because of a
    // navigation." ist ein Navigations-Race während des Renders — die CDP-
    // Verbindung ist danach unzuverlässig. Wir behandeln ihn als recoverable:
    // Browser verwerfen, recyceln und neu rendern, statt den Persist-Versuch zu
    // verbrennen. Ebenso "Navigation failed"/getrennte Browser-Verbindungen.
    /Network\.enable|Protocol error|Target closed|Connection closed|Session closed|timed out|Requesting main frame too early|frame was detached|Navigating frame|Frame got detached|Execution context was destroyed|Navigation failed|browser has disconnected|Connection terminated/i.test(message)
  );
}

/**
 * Task #594: Eine spezielle Klasse transienter Fehler, die NICHT vom Browser
 * sondern vom konkreten Render (Frame/Target) verursacht werden. Diese Fehler
 * profitieren von einem Retry mit frischer Page — ein voller Browser-Discard
 * ist kontraproduktiv (zerstört auch alle anderen gerade laufenden Renders).
 */
function isPageLevelTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as { message?: string }).message ?? "";
  return /frame was detached|Navigating frame|Frame got detached|Target closed|Session closed/i.test(message);
}

/**
 * Task #906: Browser-LAUNCH-Fehler unter paralleler Worker-Last.
 *
 * Unter `fileParallelism: true` (Task #894) startet jeder Vitest-Worker einen
 * eigenen App-Server, und mehrere davon (zzgl. der e2e-Browser) feuern
 * gleichzeitig einen Chromium-Launch. Das Container-cgroup limitiert
 * `pids.max` auf ~1024 — die Lastspitze tötet dann den startenden Prozess mit
 * "Failed to launch the browser process: Code: null" bzw. "spawn EAGAIN".
 * Das ist Resource-Contention, kein Defekt: Der Render darf NICHT scheitern,
 * nur weil er das Launch-Rennen verloren hat. Solche Fehler werden mit
 * Browser-Discard + deutlichem, jitterndem Backoff erneut versucht. Der PDF-
 * Output ändert sich dadurch nicht — nur das Timing des Launches.
 */
function isBrowserLaunchError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as { message?: string }).message ?? "";
  return /Failed to launch the browser process|Code: null|spawn EAGAIN|Chromium-Launch überschritt|browser process .*exited|Browser was not found/i.test(
    message,
  );
}

/**
 * Task #594: Globaler Semaphor gegen Chromium-Resource-Contention.
 *
 * Hintergrund: `persistInvoicePdf` läuft seit Task #544 im Hintergrund
 * (`setImmediate`). In Test-Läufen (und in Produktion bei Burst-Last)
 * stapeln sich N parallele Hintergrund-Renders gleichzeitig auf demselben
 * Singleton-Browser. Unter `--no-zygote --single-process` (Dev/Test-Profile)
 * kollabieren Chromium-Frames dann mit "Navigating frame was detached".
 *
 * Wir begrenzen daher die parallele Page-Erzeugung pro Prozess. Default 2
 * (ein laufender + ein wartender Render), per `PDF_RENDER_CONCURRENCY`
 * überschreibbar. Der Resilience-Test "10 parallele Aufrufe" (Task #526)
 * läuft mit dem Default in Wellen durch — jeder Aufruf erhält weiterhin
 * seine eigene Page, nur eben nicht alle 10 simultan.
 */
const PDF_RENDER_MAX_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.PDF_RENDER_CONCURRENCY ?? "2", 10) || 2,
);
let activeRenderSlots = 0;
const renderSlotWaiters: Array<() => void> = [];

async function acquireRenderSlot(): Promise<void> {
  if (activeRenderSlots < PDF_RENDER_MAX_CONCURRENCY) {
    activeRenderSlots++;
    return;
  }
  await new Promise<void>((resolve) => {
    renderSlotWaiters.push(resolve);
  });
  // Slot wird in releaseRenderSlot() für uns übergeben (kein neuer Inkrement
  // hier, sonst würden zwei Aufrufer denselben Slot besitzen).
}

function releaseRenderSlot(): void {
  const next = renderSlotWaiters.shift();
  if (next) {
    // Slot 1:1 weiterreichen — activeRenderSlots bleibt konstant.
    next();
  } else {
    activeRenderSlots = Math.max(0, activeRenderSlots - 1);
  }
}

export function _getRenderSlotState(): { active: number; waiting: number; max: number } {
  return {
    active: activeRenderSlots,
    waiting: renderSlotWaiters.length,
    max: PDF_RENDER_MAX_CONCURRENCY,
  };
}

/**
 * Warmt eine frisch erzeugte Page auf, damit der CDP-FrameTree garantiert
 * einen Main-Frame enthält, bevor wir `setContent` (oder andere Frame-
 * abhängige APIs) aufrufen. Verhindert den "Requesting main frame too early"
 * Race aus Task #532.
 */
async function warmupPage(page: Page): Promise<void> {
  try {
    await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 });
  } catch {
    // Wenn das Warmup selbst scheitert (Browser bereits tot), lassen wir den
    // eigentlichen Render-Aufruf laufen — der Recovery-Pfad in withFreshPage
    // verwirft den Browser dann und versucht es nochmal.
  }
}

/**
 * Führt eine Render-Operation gegen eine frische Page aus. Bei einem
 * Protocol-/Connection-Fehler wird der Browser einmalig verworfen und neu
 * gestartet — danach wird der Fehler propagiert. Zusätzlich wrappt ein
 * Race-Timeout den gesamten Aufruf, sodass blockierte CDP-Calls nicht
 * länger als `PAGE_RENDER_TIMEOUT_MS` hängen.
 */
export const WITH_FRESH_PAGE_MAX_ATTEMPTS = 5;

export async function withFreshPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  // Task #594: Slot-Akquise VOR allem anderen — wenn der Browser bereits
  // saturiert ist, warten wir hier statt zusätzliche Pages aufzumachen.
  await acquireRenderSlot();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < WITH_FRESH_PAGE_MAX_ATTEMPTS; attempt++) {
      let page: Page | null = null;
      try {
        const browser = await getBrowser();
        page = await browser.newPage();
        // Task #532: Frame-Warmup gegen "Requesting main frame too early".
        await warmupPage(page);
        const runner = fn(page);
        const result = await Promise.race([
          runner,
          new Promise<T>((_, reject) =>
            setTimeout(
              () => reject(new Error(`PDF-Rendering überschritt ${PAGE_RENDER_TIMEOUT_MS}ms Timeout`)),
              PAGE_RENDER_TIMEOUT_MS,
            ),
          ),
        ]);
        return result;
      } catch (err) {
        lastErr = err;
        if (page) {
          try { await page.close(); } catch { /* ignore */ }
          page = null;
        }
        // Task #544: Bei fehlendem Chromium nicht retryen — schneller, klarer
        // Fehler statt minutenlanges Hängen.
        if (err instanceof ChromiumUnavailableError) {
          throw err;
        }
        const lastAttempt = attempt === WITH_FRESH_PAGE_MAX_ATTEMPTS - 1;
        if (lastAttempt) {
          throw err;
        }
        // Task #594: "Navigating frame was detached" ist Page-/Target-lokal
        // — der Browser-Prozess lebt weiter und andere parallel laufende
        // Renders dürfen nicht mit ihm sterben. Wir verwerfen den Browser
        // nur bei echten Connection-/Protocol-Fehlern (Task #521/#532) und
        // gönnen Frame-Detach-Retries kurz Backoff, damit der nächste
        // Versuch nicht in dieselbe Saturations-Welle läuft.
        if (isPageLevelTransientError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        // Task #906: Launch-Fehler unter PID-Druck (paralleler Worker-Last) —
        // Browser verwerfen und mit deutlichem, jitterndem Backoff erneut
        // versuchen, damit der nächste Launch nicht in dieselbe Lastspitze
        // läuft. Der Jitter entkoppelt parallele Worker, die sonst im
        // Gleichschritt retryen würden.
        if (isBrowserLaunchError(err)) {
          await discardBrowser();
          const backoff = 500 * (attempt + 1) + Math.floor(Math.random() * 400);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        if (isRecoverablePuppeteerError(err)) {
          await discardBrowser();
          continue;
        }
        throw err;
      } finally {
        if (page) {
          try { await page.close(); } catch { /* ignore */ }
        }
      }
    }
    throw lastErr ?? new Error("PDF-Rendering fehlgeschlagen");
  } finally {
    releaseRenderSlot();
  }
}

function isFullHtmlDocument(html: string): boolean {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

export async function generatePdfFromHtml(
  html: string,
  title: string
): Promise<{ pdfBuffer: Buffer; integrityHash: string }> {
  const fullHtml = isFullHtmlDocument(html) ? html : wrapInPrintableHtml(html, title);
  const isFullDoc = isFullHtmlDocument(html);

  const pdfBuffer = await withFreshPage(async (page) => {
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 15000 });
    const buf = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: isFullDoc ? { top: "0", right: "0", bottom: "0", left: "0" } : { top: "2cm", right: "2cm", bottom: "2cm", left: "2cm" },
      displayHeaderFooter: false,
    }));
    return buf;
  });

  const integrityHash = crypto
    .createHash("sha256")
    .update(pdfBuffer)
    .digest("hex");

  return { pdfBuffer, integrityHash };
}

export async function closeBrowser(): Promise<void> {
  await discardBrowser();
}
