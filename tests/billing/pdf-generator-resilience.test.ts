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

// Diese Suite provoziert BEWUSST Launch-Fehlschläge (`launchMock` rejektiert mit
// „Network service crashed" / „Timed out …") und setzt CHROMIUM_PATH auf
// `process.execPath`, damit `isChromiumAvailable()` true liefert. Der Launch
// selbst ist über den `puppeteer-core`-Mock abgefangen — es wird NIE wirklich
// Node als Browser gestartet. `pdf-generator` loggt diese *simulierten* Fehler
// aber via `console.error`/`console.log` mit `executablePath=<node-Binary>`. Im
// CI-tests-Job liest sich das wie ein echter Chromium-Infra-Crash und hat schon
// zu einer Fehldiagnose geführt. Wir schlucken daher NUR die `[pdf-generator]`-
// Rauschzeilen DIESER Suite; jede andere Konsolenausgabe bleibt unverändert.
let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

function isPdfGeneratorNoise(args: unknown[]): boolean {
  return typeof args[0] === "string" && args[0].startsWith("[pdf-generator]");
}

beforeEach(() => {
  launchMock.mockReset();
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    if (!isPdfGeneratorNoise(args)) origLog(...args);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!isPdfGeneratorNoise(args)) origError(...args);
  });
});

afterEach(async () => {
  consoleLogSpy?.mockRestore();
  consoleErrorSpy?.mockRestore();
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

describe("withFreshPage — Recovery von 'Navigating frame was detached' unter Last (Task #594)", () => {
  it("erkennt 'Navigating frame was detached' als page-level transient und retryed OHNE Browser-Discard", async () => {
    const { withFreshPage } = await freshModule();

    const browser = makeBrowser(async () => makePage());
    launchMock.mockResolvedValue(browser);

    const detachErr = new Error("Navigating frame was detached");
    let attempt = 0;
    const result = await withFreshPage(async () => {
      attempt++;
      if (attempt === 1) throw detachErr;
      return "ok-after-retry";
    });

    expect(result).toBe("ok-after-retry");
    expect(attempt).toBe(2);
    // Page-level transient: Browser bleibt erhalten, kein Re-Launch.
    expect(browser.close).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledTimes(1);
    // Zwei Pages (eine pro Versuch), beide geschlossen.
    expect(browser.newPage).toHaveBeenCalledTimes(2);
  });

  it("retryed bis zum Versuchs-Limit bei wiederholtem Frame-Detach, dann propagiert der Fehler", async () => {
    const { withFreshPage, WITH_FRESH_PAGE_MAX_ATTEMPTS } = await freshModule();

    const browser = makeBrowser(async () => makePage());
    launchMock.mockResolvedValue(browser);

    const detachErr = new Error("frame was detached");
    let attempt = 0;

    await expect(
      withFreshPage(async () => {
        attempt++;
        throw detachErr;
      }),
    ).rejects.toThrow(/frame was detached/);

    // An die Quell-Konstante gekoppelt, damit der Test nicht erneut driftet,
    // wenn das Versuchs-Limit (Task #906: Launch-Retries unter PID-Druck)
    // verändert wird. Frame-Detach ist page-level transient → retryed im selben
    // Loop bis zum letzten Versuch, dann wird der Fehler propagiert.
    expect(attempt).toBe(WITH_FRESH_PAGE_MAX_ATTEMPTS);
    expect(browser.close).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("begrenzt parallele Page-Erzeugung über den Render-Slot-Semaphor (PDF_RENDER_CONCURRENCY)", async () => {
    const { withFreshPage, _getRenderSlotState } = await freshModule();

    let liveNewPageCalls = 0;
    let peakLive = 0;
    const browser = makeBrowser(async () => {
      liveNewPageCalls++;
      peakLive = Math.max(peakLive, liveNewPageCalls);
      const page = makePage();
      const origClose = page.close;
      page.close = vi.fn(async () => {
        liveNewPageCalls--;
        return origClose();
      });
      return page;
    });
    launchMock.mockResolvedValue(browser);

    // 10 parallele Aufrufer — jeder hält die Page kurz fest.
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withFreshPage(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return i;
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: N }, (_, i) => i));
    // Slot-Concurrency-Default = 2 → maximal 2 Pages gleichzeitig live.
    expect(peakLive).toBeLessThanOrEqual(_getRenderSlotState().max);
    expect(peakLive).toBeLessThanOrEqual(2);
    // Trotzdem bekommt jeder Aufruf seine eigene Page.
    expect(browser.newPage).toHaveBeenCalledTimes(N);
    // Slot-State nach Abschluss: keine Lecks.
    expect(_getRenderSlotState().active).toBe(0);
    expect(_getRenderSlotState().waiting).toBe(0);
  });
});

describe("prewarmBrowser — Boot-Pre-Warm (Task #1479)", () => {
  const ORIGINAL_CHROMIUM_PATH = process.env.CHROMIUM_PATH;

  beforeEach(() => {
    // `resolveChromiumPath()` nimmt CHROMIUM_PATH als erste Quelle und prüft
    // nur, ob der Pfad existiert. Der Node-Prozess-Pfad existiert garantiert,
    // sodass `isChromiumAvailable()` true liefert — der eigentliche Launch ist
    // über `puppeteer-core` gemockt, es wird also nie Node als Chromium gestartet.
    process.env.CHROMIUM_PATH = process.execPath;
  });

  afterEach(() => {
    if (ORIGINAL_CHROMIUM_PATH === undefined) delete process.env.CHROMIUM_PATH;
    else process.env.CHROMIUM_PATH = ORIGINAL_CHROMIUM_PATH;
  });

  it("löst genau einen Launch aus; ein folgender withFreshPage-Render teilt den Browser (kein 2. Launch)", async () => {
    const { prewarmBrowser, withFreshPage } = await freshModule();

    const page = makePage();
    const browser = makeBrowser(async () => page);
    launchMock.mockResolvedValue(browser);

    const warm = await prewarmBrowser();
    expect(warm.ok).toBe(true);
    // Genau EIN Launch durch das Pre-Warm.
    expect(launchMock).toHaveBeenCalledTimes(1);
    // Pre-Warm öffnet keine Page — es fährt nur das Singleton hoch.
    expect(browser.newPage).not.toHaveBeenCalled();

    // Die erste echte PDF-Anfrage findet den vorgewärmten Browser verbunden vor.
    const result = await withFreshPage(async (p) => {
      expect(p).toBe(page);
      return "rendered-ok";
    });

    expect(result).toBe("rendered-ok");
    // KEIN zweiter Launch — geteiltes Browser-Singleton.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("ist idempotent: ein 2. Pre-Warm bei verbundenem Browser löst keinen weiteren Launch aus", async () => {
    const { prewarmBrowser } = await freshModule();

    const browser = makeBrowser(async () => makePage());
    launchMock.mockResolvedValue(browser);

    const first = await prewarmBrowser();
    expect(first).toEqual({ ok: true });
    const second = await prewarmBrowser();
    expect(second).toMatchObject({ ok: true, skipped: true });
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("zwei parallele Render nach Pre-Warm teilen denselben Browser (genau ein Launch, je eigene Page, beide geschlossen)", async () => {
    const { prewarmBrowser, withFreshPage } = await freshModule();

    const allPages: FakePage[] = [];
    const browser = makeBrowser(async () => {
      const page = makePage();
      allPages.push(page);
      return page;
    });
    launchMock.mockResolvedValue(browser);

    await prewarmBrowser();
    expect(launchMock).toHaveBeenCalledTimes(1);

    const [a, b] = await Promise.all([
      withFreshPage(async () => "a"),
      withFreshPage(async () => "b"),
    ]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    // Genau ein Launch (vom Pre-Warm) — die parallelen Render teilen ihn.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(allPages).toHaveLength(2);
    for (const p of allPages) {
      expect(p.close).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Cold-Start-Stampede-Entzerrung (Task #1494)", () => {
  const ENV_KEYS = [
    "CHROMIUM_PATH",
    "CHROMIUM_PREWARM_MAX_ATTEMPTS",
    "CHROMIUM_PREWARM_RETRY_DELAY_MS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Existiert garantiert → isChromiumAvailable()/resolveChromiumPath() liefern
    // einen gültigen Pfad; der eigentliche Launch ist gemockt.
    process.env.CHROMIUM_PATH = process.execPath;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("warmChromiumBinaryCache() wirft nie und ist idempotent (2. Aufruf = skipped)", async () => {
    const { warmChromiumBinaryCache } = await freshModule();

    const first = warmChromiumBinaryCache();
    expect(first.ok).toBe(true);
    // Mindestens das Binary selbst wurde in den Page-Cache gelesen.
    expect(first.warmedFiles).toBeGreaterThanOrEqual(1);
    expect(first.skipped).toBeUndefined();

    // Idempotent: pro Prozess nur einmal nötig.
    const second = warmChromiumBinaryCache();
    expect(second).toMatchObject({ ok: true, skipped: true, warmedFiles: 0 });
  });

  it("warmChromiumBinaryCache() meldet ok:false ohne auffindbares Binary statt zu werfen", async () => {
    delete process.env.CHROMIUM_PATH;
    const { warmChromiumBinaryCache } = await freshModule();
    // Kein CHROMIUM_PATH + (i.d.R.) kein System-Chromium im Test-Container.
    const res = warmChromiumBinaryCache();
    if (!res.ok) {
      expect(res.warmedFiles).toBe(0);
      expect(res.error).toBeTruthy();
    } else {
      // Falls die Umgebung doch ein Chromium auflöst: niemals geworfen.
      expect(res.warmedFiles).toBeGreaterThanOrEqual(1);
    }
  });

  it("prewarmBrowser() überlebt eine verlorene Cold-Start-Welle: 1× Fehlschlag → Retry → Erfolg, am Ende EIN verbundener Browser", async () => {
    process.env.CHROMIUM_PREWARM_MAX_ATTEMPTS = "3";
    process.env.CHROMIUM_PREWARM_RETRY_DELAY_MS = "0"; // kein realer Backoff im Test
    const { prewarmBrowser, withFreshPage } = await freshModule();

    const page = makePage();
    const goodBrowser = makeBrowser(async () => page);
    launchMock
      // Erster Versuch reißt den Launch-Timeout (verlorene Cold-Start-Welle).
      .mockRejectedValueOnce(Object.assign(new Error("Timed out after 60000 ms while trying to connect to the browser")))
      // Zweiter Versuch (nach Discard + Backoff) gelingt.
      .mockResolvedValueOnce(goodBrowser);

    const warm = await prewarmBrowser();
    expect(warm).toEqual({ ok: true });
    // Genau zwei Launch-Versuche: 1 Fehlschlag + 1 Erfolg.
    expect(launchMock).toHaveBeenCalledTimes(2);

    // Der nachfolgende echte Render teilt den vorgewärmten Browser — kein 3.
    // Launch (Singleton-Hebel bleibt intakt trotz Retry-Logik).
    const result = await withFreshPage(async (p) => {
      expect(p).toBe(page);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(goodBrowser.newPage).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("prewarmBrowser() gibt nach erschöpften Versuchen sauber {ok:false} zurück (kein Throw, kein Endlos-Loop)", async () => {
    process.env.CHROMIUM_PREWARM_MAX_ATTEMPTS = "2";
    process.env.CHROMIUM_PREWARM_RETRY_DELAY_MS = "0";
    const { prewarmBrowser } = await freshModule();

    launchMock.mockRejectedValue(new Error("Network service crashed, restarting service"));

    const warm = await prewarmBrowser();
    expect(warm.ok).toBe(false);
    if (!warm.ok) expect(warm.error).toMatch(/Network service crashed/);
    // Genau so viele Launch-Versuche wie konfiguriert — kein unbeschränkter Loop.
    expect(launchMock).toHaveBeenCalledTimes(2);
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
