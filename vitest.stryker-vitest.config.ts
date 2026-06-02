import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config";

/**
 * Vitest-Konfiguration für das Stryker-Profil "vitest" (Task #804).
 *
 * Wird vom nativen `@stryker-mutator/vitest-runner` genutzt
 * (`stryker.vitest.conf.mjs` → `vitest.configFile`). Enthält ausschließlich die
 * Tests der DETERMINISTISCHEN Hotspot-Module — KEINE fast-check-Property-Tests
 * (die laufen im Command-Profil über `vitest.stryker.config.ts`).
 *
 * Erbt die geteilte Basis (Aliase, JSX-Transform, globals/environment/isolate)
 * via `mergeConfig(baseConfig, …)` aus `vitest.config.ts` (Task #930). Wie die
 * Schwester-Config gibt es KEIN `globalSetup` (kein DB-/Server-I/O) — die Basis
 * hat bewusst keines — damit der Lauf rein gegen die puren Berechnungs-Module
 * läuft. Eigene Deltas: die eng gepinnte `include`-Liste + kürzere Timeouts.
 *
 * Wer ein neues DETERMINISTISCHES Berechnungs-Modul aufnimmt, trägt es in
 * `stryker.vitest.conf.mjs` (`mutate`) UND die zugehörige Test-Datei hier in
 * `include` ein. Property-basierte Module gehören stattdessen ins Command-Profil.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
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
  }),
);
