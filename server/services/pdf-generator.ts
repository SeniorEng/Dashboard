import puppeteer, { type Browser, type Page } from "puppeteer-core";
import crypto from "crypto";
import { wrapInPrintableHtml } from "./template-engine";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

// Task #521: harte Timeouts gegen "Network.enable timed out" Hänger.
// In Produktion zeigte sich: Puppeteer-CDP-Verbindungen können nach längerer
// Idle-Zeit "tot" sein — newPage() blockiert dann 180s, bis Puppeteer von
// selbst aufgibt. Wir setzen den Protocol-Timeout deutlich niedriger (45s)
// und verwerfen den Browser bei jedem ProtocolError, sodass der nächste
// Render eine frische Instanz hochfährt.
const BROWSER_PROTOCOL_TIMEOUT_MS = 45_000;
const PAGE_RENDER_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });
  browser.on("disconnected", () => {
    if (browserInstance === browser) {
      browserInstance = null;
    }
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

export async function discardBrowser(): Promise<void> {
  const b = browserInstance;
  browserInstance = null;
  if (b) {
    try {
      await b.close();
    } catch {
      // ignore; Prozess ist evtl. schon weg
    }
  }
}

function isRecoverablePuppeteerError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  const message = (err as { message?: string }).message ?? "";
  return (
    name === "ProtocolError" ||
    name === "TargetCloseError" ||
    /Network\.enable|Protocol error|Target closed|Connection closed|Session closed|timed out/i.test(message)
  );
}

/**
 * Führt eine Render-Operation gegen eine frische Page aus. Bei einem
 * Protocol-/Connection-Fehler wird der Browser einmalig verworfen und neu
 * gestartet — danach wird der Fehler propagiert. Zusätzlich wrappt ein
 * Race-Timeout den gesamten Aufruf, sodass blockierte CDP-Calls nicht
 * länger als `PAGE_RENDER_TIMEOUT_MS` hängen.
 */
export async function withFreshPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let page: Page | null = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
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
      if (isRecoverablePuppeteerError(err) && attempt === 0) {
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
