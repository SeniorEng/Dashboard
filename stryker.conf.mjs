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
  // Command-Runner statt des nativen Vitest-Runners — auf vitest 4.x weiterhin
  // nötig (re-verifiziert für Task #792, 2026-05-28, @stryker-mutator/vitest-
  // runner 9.6.1, vitest 4.0.18):
  //   * Der DRY-RUN läuft mit dem nativen Runner inzwischen durch (der alte
  //     "Creating test runner process(es)"-Hang ist weg), ABER
  //   * mit dem Default `coverageAnalysis: "perTest"` verklemmt sich die
  //     eigentliche Mutations-Phase reproduzierbar (bleibt bei ~152/269 ohne
  //     Fortschritt stehen, der Per-Mutant-Timeout greift nicht), und
  //   * selbst mit `coverageAnalysis: "off"` hängt der Lauf an einzelnen
  //     Mutanten, die in den fast-check-Property-Tests (tests/equality/*) eine
  //     SYNCHRONE Endlosschleife erzeugen: vitests Worker-Thread lässt sich
  //     synchron nicht abbrechen, der Timeout feuert nicht zuverlässig.
  // Der Command-Runner umgeht das, weil Stryker pro Mutant einen frischen
  // `npx vitest run`-Kindprozess startet und ihn nach timeoutMS hart per
  // SIGKILL beendet — versions-agnostisch und ohne Hang. Bei 5 reinen Dateien
  // (~42 schnelle Tests) ist der ~3s-Kaltstart je Mutant akzeptabel.
  // Wieder-Umstellung erst, wenn ein neuer Runner einen VOLLEN Lauf (nicht nur
  // den Dry-Run) auf der installierten vitest-Major nachweislich durchzieht.
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
    "shared/domain/budgets.ts",
    "shared/domain/vacation.ts",
    "shared/domain/cancellation-policy.ts",
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
