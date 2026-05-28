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
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5000",
    trace: "on-first-retry",
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
