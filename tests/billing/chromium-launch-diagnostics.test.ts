/**
 * Task #550 — Diagnose- und Launch-Args-Tests für `server/services/pdf-generator.ts`.
 *
 * Geprüft wird:
 *   1. `runChromiumPreflight()` cached das Ergebnis und schlägt mit einem
 *      `error`-Feld fehl, wenn das Binary nicht ausführbar ist.
 *   2. `getLaunchArgs()` enthält in Production NICHT `--single-process`
 *      (Hauptverdacht aus dem WS-Endpoint-Timeout), in Development aber schon.
 *   3. Bei einem Launch-Timeout landet der Chromium-Output (Ring-Buffer) im
 *      Fehler-Log — wir sehen den Crash-Grund, nicht nur den generischen
 *      Timeout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const existsSyncMock = vi.hoisted(() => vi.fn<(path: string) => boolean>());
const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: any[]) => string | Buffer>());
const launchMock = vi.hoisted(() => vi.fn());

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock("puppeteer-core", () => ({
  default: { launch: launchMock },
}));

async function freshModule() {
  vi.resetModules();
  return await import("../../server/services/pdf-generator");
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const ORIGINAL_SINGLE_PROCESS = process.env.PUPPETEER_SINGLE_PROCESS;
const ORIGINAL_NO_ZYGOTE = process.env.PUPPETEER_NO_ZYGOTE;
const ORIGINAL_LAUNCH_TIMEOUT = process.env.BROWSER_LAUNCH_TIMEOUT_MS;

beforeEach(() => {
  existsSyncMock.mockReset();
  execFileSyncMock.mockReset();
  launchMock.mockReset();
  delete process.env.CHROMIUM_PATH;
  delete process.env.PUPPETEER_SINGLE_PROCESS;
  delete process.env.PUPPETEER_NO_ZYGOTE;
  delete process.env.BROWSER_LAUNCH_TIMEOUT_MS;
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_CHROMIUM_PATH === undefined) delete process.env.CHROMIUM_PATH;
  else process.env.CHROMIUM_PATH = ORIGINAL_CHROMIUM_PATH;
  if (ORIGINAL_SINGLE_PROCESS === undefined) delete process.env.PUPPETEER_SINGLE_PROCESS;
  else process.env.PUPPETEER_SINGLE_PROCESS = ORIGINAL_SINGLE_PROCESS;
  if (ORIGINAL_NO_ZYGOTE === undefined) delete process.env.PUPPETEER_NO_ZYGOTE;
  else process.env.PUPPETEER_NO_ZYGOTE = ORIGINAL_NO_ZYGOTE;
  if (ORIGINAL_LAUNCH_TIMEOUT === undefined) delete process.env.BROWSER_LAUNCH_TIMEOUT_MS;
  else process.env.BROWSER_LAUNCH_TIMEOUT_MS = ORIGINAL_LAUNCH_TIMEOUT;
});

describe("runChromiumPreflight (Task #550)", () => {
  it("gibt `ok: true` zurück, wenn `chromium --version` erfolgreich antwortet", async () => {
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which") throw new Error("not found");
      if (bin === "/usr/bin/chromium" && args[0] === "--version") {
        return "Chromium 125.0.6422.141\n";
      }
      throw new Error("unexpected");
    });
    const { runChromiumPreflight } = await freshModule();
    const result = runChromiumPreflight();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("Chromium 125.0.6422.141");
      expect(result.path).toBe("/usr/bin/chromium");
    }
  });

  it("gibt `ok: false` mit Fehlertext zurück, wenn Binary nicht ausführbar ist", async () => {
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which") throw new Error("not found");
      if (bin === "/usr/bin/chromium" && args[0] === "--version") {
        throw new Error("error while loading shared libraries: libnss3.so");
      }
      throw new Error("unexpected");
    });
    const { runChromiumPreflight } = await freshModule();
    const result = runChromiumPreflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/libnss3/);
      expect(result.path).toBe("/usr/bin/chromium");
    }
  });

  it("gibt `ok: false` zurück und meldet 'nicht gefunden', wenn kein Pfad auflöst", async () => {
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const { runChromiumPreflight } = await freshModule();
    const result = runChromiumPreflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBeNull();
      expect(result.error).toMatch(/nicht gefunden/i);
    }
  });

  it("cached das Ergebnis und ruft execFileSync nicht erneut auf", async () => {
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which") throw new Error("not found");
      if (bin === "/usr/bin/chromium" && args[0] === "--version") return "Chromium 1.2.3";
      throw new Error("unexpected");
    });
    const { runChromiumPreflight, getChromiumPreflightResult } = await freshModule();
    runChromiumPreflight();
    runChromiumPreflight();
    runChromiumPreflight();
    const versionCalls = execFileSyncMock.mock.calls.filter(
      (c) => c[0] === "/usr/bin/chromium" && Array.isArray(c[1]) && c[1][0] === "--version",
    );
    expect(versionCalls).toHaveLength(1);
    expect(getChromiumPreflightResult()).toBeTruthy();
  });
});

describe("getLaunchArgs (Task #550)", () => {
  it("enthält in Production NICHT --single-process (Hauptverdacht für WS-Endpoint-Timeout)", async () => {
    process.env.NODE_ENV = "production";
    const { getLaunchArgs } = await freshModule();
    const args = getLaunchArgs();
    expect(args).not.toContain("--single-process");
    expect(args).toContain("--no-zygote");
    expect(args).toContain("--disable-software-rasterizer");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--mute-audio");
  });

  it("enthält in Development weiterhin --single-process (Status quo, lokale Stabilität)", async () => {
    process.env.NODE_ENV = "development";
    const { getLaunchArgs } = await freshModule();
    const args = getLaunchArgs();
    expect(args).toContain("--single-process");
    expect(args).toContain("--no-zygote");
  });

  it("respektiert PUPPETEER_SINGLE_PROCESS=1 als Override in Production", async () => {
    process.env.NODE_ENV = "production";
    process.env.PUPPETEER_SINGLE_PROCESS = "1";
    const { getLaunchArgs } = await freshModule();
    expect(getLaunchArgs()).toContain("--single-process");
  });

  it("respektiert PUPPETEER_NO_ZYGOTE=0 als Override (no-zygote entfernen)", async () => {
    process.env.NODE_ENV = "production";
    process.env.PUPPETEER_NO_ZYGOTE = "0";
    const { getLaunchArgs } = await freshModule();
    expect(getLaunchArgs()).not.toContain("--no-zygote");
  });
});

describe("Launch-Timeout — Chromium-Output landet im Fehler-Log (Task #550)", () => {
  it("loggt den Ring-Buffer-Inhalt, wenn der Launch in einen Timeout läuft", async () => {
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which") throw new Error("not found");
      if (bin === "/usr/bin/chromium" && args[0] === "--version") return "Chromium 1.2.3";
      throw new Error("unexpected");
    });
    // puppeteer.launch schreibt während des "Launches" simulierte Chromium-
    // Stderr-Zeilen direkt auf process.stderr — diese werden durch den
    // monkey-patched Output-Tap in den Ring-Buffer übernommen. Anschließend
    // wirft die Funktion einen Fehler, der den Launch zum Scheitern bringt.
    launchMock.mockImplementation(async () => {
      process.stderr.write(
        "[0521/094512.123:FATAL:zygote_host_impl_linux.cc(202)] " +
          "error while loading shared libraries: libnss3.so: cannot open shared object file\n",
      );
      throw new Error("Timed out after 30000 ms while waiting for the WS endpoint URL");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getBrowser, getChromiumLogSnapshot } = await freshModule();

    await expect(getBrowser()).rejects.toThrow(/WS endpoint URL/);

    // Ring-Buffer enthält jetzt die Chromium-Stderr-Zeile.
    const snapshot = getChromiumLogSnapshot();
    expect(snapshot).toMatch(/libnss3\.so/);

    // console.error wurde mit den Chromium-Output-Zeilen aufgerufen.
    const calls = errorSpy.mock.calls.map((c) => c.join(" "));
    const dumpLogged = calls.some(
      (c) => c.includes("Browser-Launch fehlgeschlagen") && c.includes("libnss3"),
    );
    expect(dumpLogged).toBe(true);
    errorSpy.mockRestore();
  });
});

describe("isRecoverablePuppeteerError — Navigations-Race (Task #1467)", () => {
  it("behandelt 'Execution context was destroyed, ... navigation.' als recoverable", async () => {
    const { isRecoverablePuppeteerError } = await freshModule();
    const err = new Error(
      "Execution context was destroyed, most likely because of a navigation.",
    );
    expect(isRecoverablePuppeteerError(err)).toBe(true);
  });

  it("erkennt den Navigations-Race auch ohne Error-Instanz (nur message-Feld)", async () => {
    const { isRecoverablePuppeteerError } = await freshModule();
    expect(
      isRecoverablePuppeteerError({
        message: "Execution context was destroyed, most likely because of a navigation.",
      }),
    ).toBe(true);
  });

  it("klassifiziert einen unverwandten Fehler weiterhin als NICHT recoverable", async () => {
    const { isRecoverablePuppeteerError } = await freshModule();
    expect(isRecoverablePuppeteerError(new Error("Totally unrelated boom"))).toBe(false);
  });
});

describe("Launch-Timeout-Default & Override (Task #1467)", () => {
  // Hilfsfunktion: triggert genau EINEN Browser-Launch und gibt das an
  // puppeteer.launch übergebene Optionen-Objekt zurück. So prüfen wir, dass
  // der aufgelöste Timeout TATSÄCHLICH bis zum Launch-Aufruf durchgereicht
  // wird (statt nur einen internen Helper isoliert zu testen).
  async function captureLaunchOptions(): Promise<{ timeout: number; protocolTimeout: number }> {
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which") throw new Error("not found");
      if (bin === "/usr/bin/chromium" && args[0] === "--version") return "Chromium 1.2.3";
      throw new Error("unexpected");
    });
    const fakeBrowser = { on: vi.fn(), connected: true };
    launchMock.mockResolvedValue(fakeBrowser as never);
    const { getBrowser } = await freshModule();
    await getBrowser();
    expect(launchMock).toHaveBeenCalledTimes(1);
    return launchMock.mock.calls[0][0] as { timeout: number; protocolTimeout: number };
  }

  it("nutzt in Production den höheren Default von 60s", async () => {
    process.env.NODE_ENV = "production";
    const opts = await captureLaunchOptions();
    expect(opts.timeout).toBe(60_000);
  });

  it("bleibt in Development/Test beim schnellen 20s-Default", async () => {
    process.env.NODE_ENV = "development";
    const opts = await captureLaunchOptions();
    expect(opts.timeout).toBe(20_000);
  });

  it("respektiert BROWSER_LAUNCH_TIMEOUT_MS als Override (auch in Production)", async () => {
    process.env.NODE_ENV = "production";
    process.env.BROWSER_LAUNCH_TIMEOUT_MS = "90000";
    const opts = await captureLaunchOptions();
    expect(opts.timeout).toBe(90_000);
  });

  it("ignoriert ungültige BROWSER_LAUNCH_TIMEOUT_MS-Werte und fällt auf den Default zurück", async () => {
    process.env.NODE_ENV = "production";
    process.env.BROWSER_LAUNCH_TIMEOUT_MS = "nonsense";
    const opts = await captureLaunchOptions();
    expect(opts.timeout).toBe(60_000);
  });

  it("hält den Protocol-Timeout mindestens auf Launch-Timeout-Höhe (kein neuer Engpass)", async () => {
    process.env.NODE_ENV = "production";
    process.env.BROWSER_LAUNCH_TIMEOUT_MS = "90000";
    const opts = await captureLaunchOptions();
    expect(opts.protocolTimeout).toBeGreaterThanOrEqual(opts.timeout);
  });
});
