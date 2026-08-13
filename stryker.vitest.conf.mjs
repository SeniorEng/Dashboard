// @ts-check
/**
 * Stryker-Profil "vitest" (Task #804) — DETERMINISTISCHE Berechnungs-Module.
 *
 * Diese sechs Module werden vom nativen `@stryker-mutator/vitest-runner`
 * mutiert. Ihre Tests sind deterministisch (KEINE fast-check-Property-Tests),
 * d.h. keine Mutation erzeugt eine synchrone Endlosschleife — der native
 * Runner mit Per-Mutant-Test-Selektion läuft hier sauber und deutlich schneller
 * als der Command-Runner-Kaltstart (~6-8s je Modul isoliert).
 *
 * `coverageAnalysis: "off"`: Per-Test-Coverage brachte in dieser Suite keinen
 * Geschwindigkeitsvorteil (winzige, schnelle Test-Dateien) und der
 * `perTest`-Modus verklemmte sich auf vitest 4.x — "off" ist robust.
 *
 * Die PROPERTY-basierten Module (`invoice-line-items`, `budget-invoice-split`)
 * laufen NICHT hier, sondern im Command-Profil (`stryker.command.conf.mjs`).
 *
 * Lauf via Orchestrator: npm run mutation
 * Direkter Lauf:         npx stryker run stryker.vitest.conf.mjs
 */
import { baseOptions } from "./stryker.base.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...baseOptions,
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.stryker-vitest.config.ts",
  },
  coverageAnalysis: "off",
  mutate: [
    "shared/domain/budget/cost-estimate-outcome.ts",
    "shared/domain/budget/cap-math.ts",
    "shared/domain/budget/history-aggregation.ts",
    "shared/domain/budgets.ts",
    "shared/domain/vacation.ts",
    "shared/domain/cancellation-policy.ts",
    "shared/utils/money.ts",
    "shared/domain/import-cutoff.ts",
    "shared/utils/month-close-cutoff.ts",
    "shared/domain/invoice-amounts.ts",
  ],
  incrementalFile: "reports/stryker-incremental-vitest.json",
  htmlReporter: {
    fileName: "reports/mutation/vitest/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/vitest.json",
  },
  tempDirName: ".stryker-tmp-vitest",
};
