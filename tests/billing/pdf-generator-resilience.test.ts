/**
 * Task #523 — Resilience-Unit-Tests für `server/services/pdf-generator.ts`.
 *
 * Härtungspfade aus Task #521 werden hier ohne echtes Chromium getestet, indem
 * `puppeteer-core` komplett gemockt wird:
 *   1. `withFreshPage` verwirft den Browser bei einem `ProtocolError`, fährt
 *      eine frische Instanz hoch und liefert das Ergebnis des 2. Versuchs.
 *   2. Ein "hängender" Renderer wird vom Race-Timeout (`PAGE_RENDER_TIMEOUT_MS`)
 *      mit klarer Fehlermeldung abgebrochen — es gibt keinen 180s-Stillstand
 *      durch Puppeteer's Default-Protocol-Timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const launchMock = vi.hoisted(() => vi.fn());

vi.mock("puppeteer-core", () => ({
  default: { launch: launchMock },
}));

type FakePage = {
  close: ReturnType<typeof vi.fn>;
  goto?: ReturnType<typeof vi.fn>;
  setContent?: ReturnType<typeof vi.fn>;
  pdf?: ReturnType<typeof vi.fn>;
};

type FakeBrowser = {
  connected: boolean;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
};

function makeBrowser(newPageImpl: () => Promise<FakePage>): FakeBrowser {
  const browser: FakeBrowser = {
    connected: true,
    close: vi.fn(async () => {
      browser.connected = false;
    }),
    on: vi.fn(),
    newPage: vi.fn(newPageImpl),
  };
  return browser;
}

function makePage(): FakePage {
  return {
    close: vi.fn(async () => {}),
    // Task #532: Warmup-Aufruf vor setContent — Mock liefert sofort.
    goto: vi.fn(async () => {}),
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("../../server/services/pdf-generator");
}

beforeEach(() => {
  launchMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
});

describe("withFreshPage — recovery from ProtocolError (Task #521)", () => {
  it("verwirft den Browser nach ProtocolError und gelingt im 2. Versuch", async () => {
    const { withFreshPage } = await freshModule();

    const protocolErr = Object.assign(new Error("Network.enable timed out"), {
      name: "ProtocolError",
    });
    const brokenBrowser = makeBrowser(async () => {
      throw protocolErr;
    });

    const goodPage = makePage();
    const goodBrowser = makeBrowser(async () => goodPage);

    launchMock
      .mockResolvedValueOnce(brokenBrowser)
      .mockResolvedValueOnce(goodBrowser);

    const result = await withFreshPage(async (page) => {
      expect(page).toBe(goodPage);
      return "rendered-ok";
    });

    expect(result).toBe("rendered-ok");
    // Browser #1 wurde verworfen (discardBrowser → close), Browser #2 neu gestartet.
    expect(brokenBrowser.close).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledTimes(2);
    // Regression-Guard für Task #521: Puppeteer wird mit explizitem
    // protocolTimeout (45s) gestartet — Default 180s würde Hänger durchreichen.
    for (const call of launchMock.mock.calls) {
      expect(call[0]).toMatchObject({ protocolTimeout: 45_000, headless: true });
    }
    expect(goodBrowser.newPage).toHaveBeenCalledTimes(1);
    expect(goodPage.close).toHaveBeenCalledTimes(1);
  });

  it("erkennt 'Requesting main frame too early' als recoverable und gelingt im 2. Versuch (Task #532)", async () => {
    const { withFreshPage } = await freshModule();

    const mainFrameErr = new Error("Requesting main frame too early!");

    // Erste Page wirft beim Render mit dem typischen Chromium-Race-Fehler.
    const brokenPage = makePage();
    const brokenBrowser = makeBrowser(async () => brokenPage);

    // Zweite Page (nach Browser-Discard) liefert erfolgreich.
    const goodPage = makePage();
    const goodBrowser = makeBrowser(async () => goodPage);

    launchMock
      .mockResolvedValueOnce(brokenBrowser)
      .mockResolvedValueOnce(goodBrowser);

    let attempt = 0;
    const result = await withFreshPage(async (page) => {
      attempt++;
      if (attempt === 1) {
        expect(page).toBe(brokenPage);
        throw mainFrameErr;
      }
      expect(page).toBe(goodPage);
      return "rendered-ok";
    });

    expect(result).toBe("rendered-ok");
    expect(attempt).toBe(2);
    // Browser #1 wurde verworfen, Browser #2 frisch gestartet.
    expect(brokenBrowser.close).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledTimes(2);
    // Frame-Warmup wurde auf BEIDEN Pages aufgerufen (about:blank vor setContent).
    expect(brokenPage.goto).toHaveBeenCalledWith(
      "about:blank",
      expect.objectContaining({ waitUntil: "load" }),
    );
    expect(goodPage.goto).toHaveBeenCalledWith(
      "about:blank",
      expect.objectContaining({ waitUntil: "load" }),
    );
  });

  it("propagiert nicht-recoverable Fehler ohne Retry", async () => {
    const { withFreshPage } = await freshModule();

    const page = makePage();
    const browser = makeBrowser(async () => page);
    launchMock.mockResolvedValue(browser);

    await expect(
      withFreshPage(async () => {
        throw new Error("template syntax invalid");
      }),
    ).rejects.toThrow("template syntax invalid");

    // Genau ein Launch, kein Browser-Discard.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});

describe("generatePdfFromHtml — Parallelität / Last (Task #526)", () => {
  it("liefert bei 10 parallelen Aufrufen pro Aufruf die korrekten Bytes (kein Cross-Render) und schließt alle Pages", async () => {
    const { generatePdfFromHtml } = await freshModule();

    const allPages: FakePage[] = [];

    const browser = makeBrowser(async () => {
      // Jede Page merkt sich das zuletzt gesetzte HTML und liefert dieses
      // beim pdf()-Aufruf zurück — so erkennen wir Cross-Render zwischen
      // gleichzeitig laufenden Aufrufen sofort.
      let lastHtml = "";
      const page: FakePage = {
        close: vi.fn(async () => {}),
        goto: vi.fn(async () => {}),
        setContent: vi.fn(async (html: string) => {
          lastHtml = html;
          // Mikro-Yield, damit andere parallel laufende Pages dazwischenfunken
          // könnten, wenn der Code versehentlich Zustand teilen würde.
          await new Promise((r) => setTimeout(r, 1));
        }),
        pdf: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 1));
          return Buffer.from(`PDF::${lastHtml}`);
        }),
      };
      allPages.push(page);
      return page;
    });
    launchMock.mockResolvedValue(browser);

    const N = 10;
    const inputs = Array.from({ length: N }, (_, i) =>
      `<!doctype html><html><body>doc-${i}-${"x".repeat(i + 1)}</body></html>`,
    );

    const results = await Promise.all(
      inputs.map((html, i) => generatePdfFromHtml(html, `title-${i}`)),
    );

    // Jeder Aufruf erhält die Bytes seines eigenen HTML — kein Cross-Render.
    for (let i = 0; i < N; i++) {
      expect(results[i].pdfBuffer.toString()).toBe(`PDF::${inputs[i]}`);
      const expectedHash = (await import("crypto"))
        .createHash("sha256")
        .update(Buffer.from(`PDF::${inputs[i]}`))
        .digest("hex");
      expect(results[i].integrityHash).toBe(expectedHash);
    }

    // Eine Page pro Aufruf, kein Sharing.
    expect(browser.newPage).toHaveBeenCalledTimes(N);
    expect(allPages).toHaveLength(N);

    // Keine Page-Leaks: jede Page wurde geschlossen.
    for (const page of allPages) {
      expect(page.close).toHaveBeenCalledTimes(1);
    }

    // Browser wurde nur einmal gestartet und nicht verworfen.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });
});

describe("withFreshPage — Race-Timeout gegen hängendes Chromium (Task #521)", () => {
  it("bricht hängenden Render nach PAGE_RENDER_TIMEOUT_MS mit klarer Fehlermeldung ab", async () => {
    const { withFreshPage } = await freshModule();

    const hangingPage = makePage();
    const hangingBrowser = makeBrowser(async () => hangingPage);
    launchMock.mockResolvedValue(hangingBrowser);

    vi.useFakeTimers();

    const promise = withFreshPage(
      () => new Promise<never>(() => { /* niemals auflösen */ }),
    );
    // Verhindert "unhandled rejection"-Warnings, bevor wir await machen.
    promise.catch(() => {});

    // Großzügig über den 30s-Race-Timeout hinaus.
    await vi.advanceTimersByTimeAsync(35_000);

    await expect(promise).rejects.toThrow(/PDF-Rendering überschritt \d+ms Timeout/);

    // Kein 180s-Stillstand: Promise.race greift, die Page wird geschlossen.
    // Die Timeout-Fehlermeldung ist bewusst NICHT als "recoverable" eingestuft
    // (kein "timed out" im Klartext), sodass kein Endlos-Retry-Loop entsteht
    // und der Browser für nachfolgende Renders erhalten bleibt.
    expect(hangingPage.close).toHaveBeenCalled();
    expect(hangingBrowser.close).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
