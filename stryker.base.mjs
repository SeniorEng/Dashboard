// @ts-check
/**
 * Geteilte Stryker-Basis-Optionen für die beiden Mutation-Profile (Task #804).
 *
 * Hintergrund: Mutation-Testing wird in CareConnect in ZWEI Profile aufgeteilt,
 * weil die fünf+ Hotspot-Module unterschiedliche Test-Runner brauchen:
 *
 *  - Profil "vitest" (`stryker.vitest.conf.mjs`): die DETERMINISTISCHEN Module
 *    (`cost-estimate-outcome`, `cap-math`, `history-aggregation`, `budgets`,
 *    `vacation`, `cancellation-policy`) laufen auf dem nativen
 *    `@stryker-mutator/vitest-runner` mit Per-Mutant-Test-Selektion — deutlich
 *    schneller (~6-8s je Modul isoliert) als der Command-Runner-Kaltstart.
 *
 *  - Profil "command" (`stryker.command.conf.mjs`): die beiden
 *    PROPERTY-BASIERTEN Module (`invoice-line-items`, `budget-invoice-split`,
 *    abgedeckt von fast-check-Tests unter `tests/equality/*`) bleiben auf dem
 *    Command-Runner. Manche Mutanten dieser Module erzeugen in den
 *    Property-Tests eine SYNCHRONE Endlosschleife; der native vitest-Worker
 *    lässt sich synchron nicht abbrechen, der Per-Mutant-Timeout greift nicht,
 *    der Lauf hängt. Der Command-Runner startet pro Mutant einen frischen
 *    Kindprozess und SIGKILLt ihn nach `timeoutMS` — versions-agnostisch sicher.
 *    (Re-verifiziert Task #792, 2026-05-28, runner 9.6.1 / vitest 4.0.18.)
 *
 * `npm run mutation` orchestriert beide Profile (`scripts/run-mutation.mjs`),
 * aggregiert den Mutation-Score über beide Reports und erzwingt das Gate
 * `break: 60` auf dem AGGREGIERTEN Score. Die einzelnen Profile setzen daher
 * KEIN eigenes `break` (würde sonst pro Profil gaten statt aggregiert).
 *
 * Siehe Runbook: docs/mutation-testing.md
 */

/** @type {Partial<import('@stryker-mutator/api/core').PartialStrykerOptions>} */
export const baseOptions = {
  packageManager: "npm",
  reporters: ["html", "clear-text", "progress", "json"],
  // Incremental-Mode: nur von Code-/Test-Änderungen betroffene Mutanten erneut
  // prüfen. Jedes Profil hat seine EIGENE Incremental-Datei (siehe Profile),
  // damit sich die beiden Läufe nicht gegenseitig den Cache überschreiben.
  incremental: true,
  // Score-Schwellen nur für die Farb-/Text-Ausgabe der Einzel-Reports. Das
  // harte Gate (`break: 60`) erzwingt der Orchestrator auf dem AGGREGIERTEN
  // Score, NICHT die Einzel-Profile — sonst würde ein einzelnes Profil <60 den
  // Lauf killen, obwohl der kombinierte Score das Gate besteht.
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
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
    "!vitest.stryker-vitest.config.ts",
    "!vitest.config.ts",
    "!package.json",
    "!tsconfig.json",
    "!tsconfig.*.json",
  ],
  // Manche Mutanten der PROPERTY-Module erzeugen eine synchrone Endlosschleife;
  // der Command-Runner SIGKILLt den Mutant erst nach `timeoutMS`. Die Suites
  // selbst laufen in ~3s, daher reichen 25s als grosszuegiger Sicherheitspuffer
  // (effektiv netTime*timeoutFactor + 25s) — und der Lauf ist deutlich schneller
  // als mit den fruheren 60s, weil jeder Endlosschleifen-Mutant ~35s frueher
  // abgebrochen wird (Task #804).
  timeoutMS: 25000,
  // KEIN explizites `concurrency` — der Default (n bzw. n-1 Worker) ist fuer
  // diese winzige Suite voellig ausreichend. Bei Bedarf via Prozent-String
  // (z.B. "50%") oder Ganzzahl setzen. WICHTIG: Die Config-Datei MUSS als
  // POSITIONALES Argument an `stryker run` uebergeben werden, NICHT via `-c`
  // — `-c` ist die Kurzform fuer `--concurrency`; ueber `-c <datei>` landet der
  // Dateipfad als concurrency-Wert und der Lauf bricht mit
  // "concurrency must match pattern …" ab (Task #804). Der Orchestrator
  // `scripts/run-mutation.mjs` uebergibt die Config korrekt positional.
};
