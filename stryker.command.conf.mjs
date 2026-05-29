// @ts-check
/**
 * Stryker-Profil "command" (Task #804) — PROPERTY-basierte Module.
 *
 * Diese beiden Module sind von fast-check-Property-Tests (`tests/equality/*`)
 * abgedeckt. Manche Mutanten erzeugen dort eine SYNCHRONE Endlosschleife; der
 * native vitest-Worker lässt sich synchron nicht abbrechen, der Per-Mutant-
 * Timeout greift nicht, der Lauf hängt (re-verifiziert Task #792, 2026-05-28,
 * runner 9.6.1 / vitest 4.0.18). Der Command-Runner umgeht das, weil Stryker
 * pro Mutant einen frischen `npx vitest run`-Kindprozess startet und ihn nach
 * `timeoutMS` hart per SIGKILL beendet — versions-agnostisch sicher, ~3s
 * Kaltstart je Mutant bei dieser winzigen Suite akzeptabel.
 *
 * Die DETERMINISTISCHEN Module laufen NICHT hier, sondern im (schnelleren)
 * vitest-Profil (`stryker.vitest.conf.mjs`).
 *
 * Lauf via Orchestrator: npm run mutation
 * Direkter Lauf:         npx stryker run stryker.command.conf.mjs
 */
import { baseOptions } from "./stryker.base.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...baseOptions,
  testRunner: "command",
  commandRunner: {
    command: "npx vitest run --config vitest.stryker.config.ts",
  },
  mutate: [
    "shared/domain/invoice-line-items.ts",
    "shared/domain/budget-invoice-split.ts",
  ],
  incrementalFile: "reports/stryker-incremental-command.json",
  htmlReporter: {
    fileName: "reports/mutation/command/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/command.json",
  },
  tempDirName: ".stryker-tmp-command",
};
