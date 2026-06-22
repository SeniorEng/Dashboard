import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

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
    // Trace bei jedem Retry-Versuch aufzeichnen (nicht nur beim ersten),
    // damit jeder Flake-Retry diagnostizierbar ist.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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
