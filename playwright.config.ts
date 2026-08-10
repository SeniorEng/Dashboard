import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// In Replit liegt Chromium im Nix-Store; in CI (GitHub Actions) wird es per
// `npx playwright install --with-deps chromium` an Playwrights Standardpfad
// installiert. Wir setzen `executablePath` nur, wenn ein konkreter Pfad
// per Env vorgegeben ist ODER der Nix-Store-Pfad tatsächlich existiert.
// Andernfalls (CI) bleibt `executablePath` undefined und Playwright nutzt
// den selbst installierten Browser.
const NIX_CHROMIUM =
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (existsSync(NIX_CHROMIUM) ? NIX_CHROMIUM : undefined);

// Task #1818: Video-Aufnahme braucht Playwrights EIGENE gebündelte ffmpeg-Binary
// (nicht die System-ffmpeg). Fehlt sie (Agent-/Validation-Umgebung ohne
// `npx playwright install ffmpeg`), wirft `context.newPage()` bei aktivem Video
// hart — das ließ `e2e-smoke` reproduzierbar schon vor dem ersten Test rotbrechen.
// Wir prüfen daher, ob die gebündelte ffmpeg vorhanden ist, und schalten die
// Video-Aufnahme sonst sauber ab (statt zu crashen). In Replit/CI mit installierter
// ffmpeg bleibt „retain-on-failure" aktiv. Override: `PLAYWRIGHT_FORCE_VIDEO=off|on`.
function hasPlaywrightFfmpeg(): boolean {
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
    path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    return readdirSync(base).some((entry) => {
      if (!entry.startsWith("ffmpeg-")) return false;
      try {
        return readdirSync(path.join(base, entry)).some((f) =>
          f.startsWith("ffmpeg"),
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const forceVideo = process.env.PLAYWRIGHT_FORCE_VIDEO?.trim().toLowerCase();
const videoEnabled =
  forceVideo === "on" ? true : forceVideo === "off" ? false : hasPlaywrightFfmpeg();
if (!videoEnabled) {
  console.warn(
    "[playwright] Video-Aufnahme deaktiviert — Playwrights gebündelte ffmpeg-Binary " +
      "ist nicht installiert. Einmalig `npx playwright install ffmpeg` ausführen, " +
      "um Fehler-Videos wieder zu aktivieren (oder PLAYWRIGHT_FORCE_VIDEO=on erzwingen).",
  );
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Flake-Härtung (Task #774): in CI bis zu 2 Retries. Ein Test, der erst im
  // Retry grün wird, gilt als Flake — Playwright markiert ihn im Report als
  // "flaky" (eigener Status neben passed/failed), die JUnit-XML enthält die
  // Retry-Attempts. So ist die Flake-Rate aus den CI-Artifacts ablesbar.
  retries: process.env.CI ? 2 : 1,
  // Task #541: Im Replit-Workspace (begrenzter RAM) auf 1 Worker begrenzen, um
  // Workspace-Überlastung/OOM zu vermeiden. In CI ohnehin 1 Worker. Nur außerhalb
  // beider Umgebungen (z.B. lokale Entwickler-Maschine) lässt Playwright die
  // Worker-Anzahl frei (undefined = Default ≈ halbe CPU-Kerne).
  workers:
    process.env.CI || process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN
      ? 1
      : undefined,
  // In CI zusätzlich JUnit-XML für Flake-Tracking-Tooling schreiben; lokal
  // bleibt die kompakte Listen-Ausgabe.
  reporter: process.env.CI
    ? [
        ["list"],
        ["junit", { outputFile: "test-results/playwright-junit.xml" }],
        ["html", { open: "never" }],
      ]
    : "list",
  timeout: 30000,
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://localhost:5000",
    // Hoeher als Playwrights Default (1280x720). Der Datepicker-Popover des
    // Wizards braucht bei einem Monat mit sechs Kalenderzeilen mehr Hoehe, als
    // unter dem Trigger frei war; `PopoverContent` deklariert zwar
    // `side="bottom"`, Radix kippt aber bei Platzmangel nach oben und der
    // Popover-Kopf landete bei negativem y (gemessen: -14) — ausserhalb des
    // Viewports, unklickbar. Der Wizard-Schritt ist kuerzer als der Viewport,
    // das Dokument also nicht scrollbar: Scrollen half nachweislich nicht
    // (CI-Lauf 31369343726), nur mehr Hoehe hilft.
    viewport: { width: 1280, height: 1000 },
    // Trace bei jedem Retry-Versuch aufzeichnen (nicht nur beim ersten),
    // damit jeder Flake-Retry diagnostizierbar ist.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: videoEnabled ? "retain-on-failure" : "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          executablePath: chromiumExecutablePath,
        },
      },
    },
  ],
});
