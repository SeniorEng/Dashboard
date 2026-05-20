/**
 * Task #547 — Unit-Tests für `resolveChromiumPath()` aus
 * `server/services/pdf-generator.ts`.
 *
 * Geprüft wird die Reihenfolge der Auflösung:
 *   1. `CHROMIUM_PATH`-Env (Override für Deployments)
 *   2. `which chromium` / `which chromium-browser` (Nix-Shim auf PATH)
 *   3. Bekannte System-Fallbacks (`/usr/bin/chromium*`, `/usr/bin/google-chrome*`)
 *
 * `fs.existsSync` und `child_process.execFileSync` werden gemockt, damit der
 * Test völlig unabhängig vom Host-System ist (kein echtes Chromium nötig).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const existsSyncMock = vi.hoisted(() => vi.fn<(path: string) => boolean>());
const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: any[]) => string | Buffer>());

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

async function freshModule() {
  vi.resetModules();
  return await import("../../server/services/pdf-generator");
}

const ORIGINAL_ENV = process.env.CHROMIUM_PATH;

beforeEach(() => {
  existsSyncMock.mockReset();
  execFileSyncMock.mockReset();
  delete process.env.CHROMIUM_PATH;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CHROMIUM_PATH;
  } else {
    process.env.CHROMIUM_PATH = ORIGINAL_ENV;
  }
});

describe("resolveChromiumPath — Auflösungs-Reihenfolge (Task #547)", () => {
  it("priorisiert `CHROMIUM_PATH`-Env vor `which` und System-Fallback, wenn das Binary existiert", async () => {
    process.env.CHROMIUM_PATH = "/custom/deploy/chromium";
    // `which` würde zwar einen anderen Pfad finden — der darf aber nicht gewinnen.
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which" && args[0] === "chromium") return "/nix/profile/bin/chromium\n";
      throw new Error("not found");
    });
    existsSyncMock.mockImplementation(
      (p: string) => p === "/custom/deploy/chromium" || p === "/nix/profile/bin/chromium" || p === "/usr/bin/chromium",
    );

    const { resolveChromiumPath } = await freshModule();
    expect(resolveChromiumPath()).toBe("/custom/deploy/chromium");
  });

  it("fällt auf `which chromium` zurück, wenn Env nicht gesetzt ist", async () => {
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which" && args[0] === "chromium") return "/nix/profile/bin/chromium\n";
      throw new Error("not found");
    });
    existsSyncMock.mockImplementation((p: string) => p === "/nix/profile/bin/chromium");

    const { resolveChromiumPath } = await freshModule();
    expect(resolveChromiumPath()).toBe("/nix/profile/bin/chromium");
  });

  it("fällt auf `which chromium-browser` zurück, wenn `chromium` nicht auf PATH ist", async () => {
    execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === "which" && args[0] === "chromium") throw new Error("not found");
      if (bin === "which" && args[0] === "chromium-browser") return "/usr/local/bin/chromium-browser\n";
      throw new Error("unexpected");
    });
    existsSyncMock.mockImplementation((p: string) => p === "/usr/local/bin/chromium-browser");

    const { resolveChromiumPath } = await freshModule();
    expect(resolveChromiumPath()).toBe("/usr/local/bin/chromium-browser");
  });

  it("fällt auf `/usr/bin/...`-System-Pfade zurück, wenn weder Env noch `which` greifen", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("which: not found");
    });
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/chromium");

    const { resolveChromiumPath } = await freshModule();
    expect(resolveChromiumPath()).toBe("/usr/bin/chromium");
  });

  it("ignoriert eine `CHROMIUM_PATH`-Env, deren Binary nicht existiert, und fällt sauber durch", async () => {
    process.env.CHROMIUM_PATH = "/does/not/exist/chromium";
    execFileSyncMock.mockImplementation(() => {
      throw new Error("which: not found");
    });
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/google-chrome-stable");

    const { resolveChromiumPath } = await freshModule();
    expect(resolveChromiumPath()).toBe("/usr/bin/google-chrome-stable");
  });

  it("liefert `null`, wenn kein einziger Kandidat existiert (Health-Check kann früh fehlschlagen)", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("which: not found");
    });
    existsSyncMock.mockReturnValue(false);

    const { resolveChromiumPath, isChromiumAvailable } = await freshModule();
    expect(resolveChromiumPath()).toBeNull();
    expect(isChromiumAvailable()).toBe(false);
  });
});
