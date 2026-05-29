import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest-Konfiguration für das Stryker-Profil "command" (Task #770/#804).
 *
 * Wird vom Command-Runner (`stryker.command.conf.mjs`) pro Mutant als frischer
 * `npx vitest run --config vitest.stryker.config.ts`-Kindprozess gestartet.
 * Enthält ausschließlich die fast-check-PROPERTY-Tests der beiden Module, die
 * den nativen vitest-Runner zum Hängen bringen (synchrone Endlosschleifen unter
 * Mutation). Die deterministischen Module laufen im schnelleren vitest-Profil
 * über `vitest.stryker-vitest.config.ts`.
 *
 * Unterschiede zur Haupt-`vitest.config.ts`:
 *  - KEIN `globalSetup` (der braucht eine laufende DB + App-Server für den
 *    Test-Daten-Cleanup). Mutation-Testing läuft ausschließlich gegen die
 *    PUREN Berechnungs-Module in `shared/domain/` und deren reine Tests
 *    — ohne I/O, damit ein Run in Minuten statt Stunden durchläuft.
 *  - `include` ist eng auf die zwei Property-Test-Dateien gepinnt.
 *  - `fileParallelism` bleibt aktiv (keine geteilte DB → keine Races).
 *
 * Wer ein neues PROPERTY-basiertes Modul in das Command-Profil aufnimmt,
 * trägt es in `stryker.command.conf.mjs` (`mutate`) UND die zugehörige
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
