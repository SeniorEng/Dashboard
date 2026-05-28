// @ts-check
/**
 * Stryker-Mutation-Testing (Incremental-Mode) für die kritischsten
 * Berechnungs-/Buchungs-Module (Task #770).
 *
 * Hintergrund: Line-Coverage allein sagt nichts darüber aus, ob die Tests
 * Fehler tatsächlich FANGEN. Mutation-Testing verändert den Produktivcode
 * (z.B. `+` → `-`, `>` → `>=`, Konstanten kippen) und prüft, ob mindestens
 * ein Test daraufhin rot wird. Überlebende Mutanten = blinde Flecken.
 *
 * Scope-Entscheidung (Schritt 1 der Task finalisiert):
 *  Gemutiert werden ausschließlich die PUREN Berechnungs-Module unter
 *  `shared/domain/`, die reine Unit-Tests OHNE DB/Server besitzen. Nur so
 *  läuft ein Run in Minuten statt Stunden (Out-of-scope: Full-Suite-Run).
 *  Die ursprünglich vorgeschlagenen DB-gebundenen Services
 *  (`consumption-engine`, `month-close-scheduler`) sind bewusst NICHT
 *  enthalten — ihre Tests brauchen Postgres + laufenden App-Server, was den
 *  expliziten „zu teuer"-Out-of-scope der Task verletzen würde. Statt ihrer
 *  decken wir die reinen Cap-/History-Berechnungen ab (`cap-math`,
 *  `history-aggregation`).
 *
 * Lokaler Lauf:        npm run mutation
 * Incremental-Re-Run:  npm run mutation (nutzt reports/stryker-incremental.json)
 * Nur geänderte Files: npm run mutation -- --mutate "<glob1>" "<glob2>"
 *
 * Siehe Runbook: docs/mutation-testing.md
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  // Command-Runner statt des dedizierten Vitest-Runners: vitest 4.x ist neuer
  // als die offizielle Stryker-Vitest-Runner-Integration (9.6.1), deren
  // Per-Mutant-Test-Selektion gegen die vitest-4-Internals hängt
  // ("Creating test runner process(es)" ohne Fortschritt). Der Command-Runner
  // ruft pro Mutant die komplette PURE Suite auf — bei 5 reinen Dateien in
  // ~1,3 s ist das schnell genug und vollständig versions-agnostisch.
  testRunner: "command",
  commandRunner: {
    command: "npx vitest run --config vitest.stryker.config.ts",
  },
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  // Nur die fünf Hotspot-Module mutieren. Bei einem PR-Lauf in CI wird dieser
  // Glob via `--mutate` auf die tatsächlich geänderten Files eingeengt.
  mutate: [
    "shared/domain/invoice-line-items.ts",
    "shared/domain/budget-invoice-split.ts",
    "shared/domain/budget/cost-estimate-outcome.ts",
    "shared/domain/budget/cap-math.ts",
    "shared/domain/budget/history-aggregation.ts",
  ],
  // Incremental-Mode: nur Mutanten erneut prüfen, die von Code-/Test-
  // Änderungen seit dem letzten Lauf betroffen sind. Die Datei wird per
  // CI-Cache (actions/cache) über Läufe hinweg erhalten, lokal liegt sie
  // unter reports/ und ist gitignored.
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  // Mutation-Score-Schwellen (Stryker-Default): >= high gilt als gut,
  // < break lässt den Lauf (und damit das CI-Gate) hart fehlschlagen.
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },
  // Vitest braucht keine TS-Vorkompilierung — der Runner nutzt die
  // vitest.stryker.config.ts mit demselben esbuild/alias-Setup wie die Tests.
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  // Allowlist statt Blocklist: der Workspace-Root enthält viele Dot-Verzeichnisse
  // (`.cache/`, `.config/pulse/` …) mit Sonderdateien (FIFOs, Bun-Cache), an
  // denen Strykers Sandbox-Copy mit EISDIR stirbt. Wir ignorieren daher ALLES
  // und geben nur die für die puren Tests nötigen Pfade frei. `node_modules`
  // wird von Stryker ohnehin separat symverlinkt (nicht kopiert).
  ignorePatterns: [
    "**",
    "!shared/**",
    "!tests/**",
    "!vitest.stryker.config.ts",
    "!vitest.config.ts",
    "!package.json",
    "!tsconfig.json",
    "!tsconfig.*.json",
  ],
  timeoutMS: 60000,
  concurrency: 2,
};
