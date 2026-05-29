import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest-Konfiguration für das Stryker-Profil "vitest" (Task #804).
 *
 * Wird vom nativen `@stryker-mutator/vitest-runner` genutzt
 * (`stryker.vitest.conf.mjs` → `vitest.configFile`). Enthält ausschließlich die
 * Tests der DETERMINISTISCHEN Hotspot-Module — KEINE fast-check-Property-Tests
 * (die laufen im Command-Profil über `vitest.stryker.config.ts`).
 *
 * Wie die Schwester-Config gibt es KEIN `globalSetup` (kein DB-/Server-I/O),
 * damit der Lauf rein gegen die puren Berechnungs-Module läuft.
 *
 * Wer ein neues DETERMINISTISCHES Berechnungs-Modul aufnimmt, trägt es in
 * `stryker.vitest.conf.mjs` (`mutate`) UND die zugehörige Test-Datei hier in
 * `include` ein. Property-basierte Module gehören stattdessen ins Command-Profil.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/budget/cost-estimate-outcome.test.ts",
      "tests/budget/cap-math.test.ts",
      "tests/budget/history-aggregation.test.ts",
      "tests/budget/statutory-clamp.test.ts",
      "tests/unit/vacation-pro-rata.test.ts",
      "tests/unit/cancellation-policy.test.ts",
      "tests/utils/money.test.ts",
      "tests/unit/import-cutoff.test.ts",
      "tests/month-close-cutoff.test.ts",
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@assets": path.resolve(__dirname, "./attached_assets"),
      "@": path.resolve(__dirname, "./client/src"),
    },
  },
});
