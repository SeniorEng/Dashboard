import puppeteer, { type Browser } from "puppeteer-core";
import crypto from "crypto";
import { wrapInPrintableHtml } from "./template-engine";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  browserInstance = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
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
  return browserInstance;
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
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 15000 });

    const isFullDoc = isFullHtmlDocument(html);
    const pdfBuffer = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: isFullDoc ? { top: "0", right: "0", bottom: "0", left: "0" } : { top: "2cm", right: "2cm", bottom: "2cm", left: "2cm" },
      displayHeaderFooter: false,
    }));

    const integrityHash = crypto
      .createHash("sha256")
      .update(pdfBuffer)
      .digest("hex");

    return { pdfBuffer, integrityHash };
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
