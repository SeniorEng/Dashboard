import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config";

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
 * Erbt die geteilte Basis (Aliase, JSX-Transform, globals/environment/isolate)
 * via `mergeConfig(baseConfig, …)` aus `vitest.config.ts` (Task #930) und trägt
 * nur noch die Profil-Deltas:
 *  - KEIN `globalSetup`/`projects` (die Basis hat bewusst keines). Mutation-
 *    Testing läuft ausschließlich gegen die PUREN Berechnungs-Module in
 *    `shared/domain/` und deren reine Tests — ohne I/O, damit ein Run in Minuten
 *    statt Stunden durchläuft.
 *  - `include` ist eng auf die zwei Property-Test-Dateien gepinnt.
 *  - Kürzere Timeouts (20s) als die Haupt-Config.
 *  - `fileParallelism` bleibt aktiv (keine geteilte DB → keine Races).
 *
 * Wer ein neues PROPERTY-basiertes Modul in das Command-Profil aufnimmt,
 * trägt es in `stryker.command.conf.mjs` (`mutate`) UND die zugehörige
 * Test-Datei hier in `include` ein.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        "tests/equality/invoice-line-item-arithmetic.test.ts",
        "tests/equality/invoice-per-pot-arithmetic.test.ts",
      ],
      testTimeout: 20000,
      hookTimeout: 20000,
    },
  }),
);
