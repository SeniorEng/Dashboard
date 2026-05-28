import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Dedizierte Vitest-Konfiguration für Stryker-Mutation-Testing (Task #770).
 *
 * Unterschiede zur Haupt-`vitest.config.ts`:
 *  - KEIN `globalSetup` (der braucht eine laufende DB + App-Server für den
 *    Test-Daten-Cleanup). Mutation-Testing läuft ausschließlich gegen die
 *    PUREN Berechnungs-Module in `shared/domain/` und deren reine Unit-Tests
 *    — ohne I/O, damit ein Run in Minuten statt Stunden durchläuft.
 *  - `include` ist eng auf die Tests gepinnt, die die fünf Hotspot-Module
 *    abdecken. Stryker führt pro Mutant nur diese Suite aus.
 *  - `fileParallelism` bleibt aktiv (keine geteilte DB → keine Races).
 *
 * Wer ein neues pures Berechnungs-Modul in die Mutation-Suite aufnimmt,
 * trägt es in `stryker.conf.mjs` (`mutate`) UND die zugehörige reine
 * Test-Datei hier in `include` ein.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/equality/invoice-line-item-arithmetic.test.ts",
      "tests/equality/invoice-per-pot-arithmetic.test.ts",
      "tests/budget/cost-estimate-outcome.test.ts",
      "tests/budget/cap-math.test.ts",
      "tests/budget/history-aggregation.test.ts",
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
