// @ts-check
/**
 * Mutation-Testing-Orchestrator (Task #804).
 *
 * Führt die ZWEI Stryker-Profile nacheinander aus und aggregiert das Ergebnis:
 *
 *  - "vitest"  (stryker.vitest.conf.mjs)  → deterministische Module, nativer
 *    `@stryker-mutator/vitest-runner` (schnell, Per-Mutant-Test-Selektion).
 *  - "command" (stryker.command.conf.mjs) → property-basierte Module, Command-
 *    Runner (sicher gegen synchrone Endlosschleifen-Mutanten).
 *
 * Beide Profile setzen KEIN eigenes `break`-Gate. Stattdessen liest dieser
 * Orchestrator die JSON-Reports beider Läufe, berechnet den AGGREGIERTEN
 * Mutation-Score und erzwingt das Gate `break: 60` darauf — ein einzelnes
 * Profil <60 soll den Lauf nicht killen, solange der kombinierte Score passt.
 *
 * CLI:
 *   node scripts/run-mutation.mjs
 *   node scripts/run-mutation.mjs --mutate <datei> [<datei> ...]
 *
 * Mit `--mutate` werden die übergebenen Dateien nach Profil zugeordnet und nur
 * die betroffenen Profile gestartet (so nutzt es CI für geänderte Hotspots).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const BREAK_THRESHOLD = 60;

/** Module, die ZWINGEND auf dem Command-Runner laufen (Property-Tests). */
const COMMAND_MODULES = new Set([
  "shared/domain/invoice-line-items.ts",
  "shared/domain/budget-invoice-split.ts",
]);

/** @typedef {{ name: string, config: string, report: string }} Profile */

/** @type {Profile[]} */
const PROFILES = [
  {
    name: "vitest",
    config: "stryker.vitest.conf.mjs",
    report: "reports/mutation/vitest.json",
  },
  {
    name: "command",
    config: "stryker.command.conf.mjs",
    report: "reports/mutation/command.json",
  },
];

function parseMutateArg(argv) {
  const idx = argv.indexOf("--mutate");
  if (idx === -1) return null;
  const files = [];
  for (let i = idx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) break;
    files.push(a);
  }
  return files;
}

/**
 * Ermittelt für jedes Profil die zu mutierenden Dateien.
 * Ohne `--mutate` → null (Profil nutzt seine vollständige `mutate`-Liste).
 */
function partitionTargets(profileName, mutateFiles) {
  if (mutateFiles === null) return null;
  return mutateFiles.filter((f) =>
    profileName === "command"
      ? COMMAND_MODULES.has(f)
      : !COMMAND_MODULES.has(f),
  );
}

function runProfile(profile, targets) {
  // WICHTIG: Die Config-Datei ist ein POSITIONALES Argument von `stryker run`.
  // `-c` ist die Kurzform für `--concurrency`, NICHT für die Config-Datei — wird
  // sie über `-c` übergeben, landet der Dateipfad als concurrency-Wert und der
  // Lauf bricht mit "concurrency must match pattern …" ab (Task #804).
  const args = ["stryker", "run", profile.config];
  if (targets && targets.length > 0) {
    args.push("--mutate", ...targets);
  }
  console.log(`\n=== Stryker-Profil "${profile.name}" (${profile.config}) ===`);
  console.log(`> npx ${args.join(" ")}\n`);
  const res = spawnSync("npx", args, { stdio: "inherit" });
  if (res.error) {
    throw new Error(`Profil "${profile.name}" konnte nicht gestartet werden: ${res.error.message}`);
  }
  if (res.status !== 0) {
    // Da die Profile kein `break` setzen, ist ein Exit != 0 ein ECHTER Fehler
    // (Crash, Sandbox-Problem, Runner-Hang-Kill) — kein Score-Gate.
    throw new Error(`Profil "${profile.name}" ist mit Exit-Code ${res.status} fehlgeschlagen.`);
  }
}

/**
 * Zählt Mutanten-Status über alle Dateien eines Stryker-JSON-Reports.
 * Score-Formel (Stryker-Standard): detected / valid,
 *   detected = Killed + Timeout
 *   valid    = detected + Survived + NoCoverage
 * (RuntimeError/CompileError sind "invalid" und zählen NICHT in den Score.)
 */
function tallyReport(reportPath) {
  const tally = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    NoCoverage: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0,
  };
  if (!existsSync(reportPath)) {
    throw new Error(`Erwarteter Mutation-Report fehlt: ${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      if (mutant.status in tally) tally[mutant.status]++;
    }
  }
  return tally;
}

function scoreFromTally(t) {
  const detected = t.Killed + t.Timeout;
  const valid = detected + t.Survived + t.NoCoverage;
  return valid === 0 ? 100 : (detected / valid) * 100;
}

function main() {
  const argv = process.argv.slice(2);
  const mutateFiles = parseMutateArg(argv);

  const ran = [];
  for (const profile of PROFILES) {
    const targets = partitionTargets(profile.name, mutateFiles);
    if (targets !== null && targets.length === 0) {
      console.log(`\n--- Profil "${profile.name}" übersprungen (keine passenden geänderten Module) ---`);
      continue;
    }
    runProfile(profile, targets);
    ran.push(profile);
  }

  if (ran.length === 0) {
    console.log("\nKeine Mutation-Profile ausgeführt — nichts zu aggregieren.");
    return;
  }

  const combined = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    NoCoverage: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0,
  };
  console.log("\n========== Mutation-Score-Aggregation ==========");
  for (const profile of ran) {
    const t = tallyReport(profile.report);
    for (const k of Object.keys(combined)) combined[k] += t[k];
    console.log(
      `Profil "${profile.name}": ${scoreFromTally(t).toFixed(2)}% ` +
        `(killed ${t.Killed}, timeout ${t.Timeout}, survived ${t.Survived}, no-cov ${t.NoCoverage})`,
    );
  }

  const score = scoreFromTally(combined);
  console.log(
    `\nAGGREGIERT: ${score.toFixed(2)}% ` +
      `(killed ${combined.Killed}, timeout ${combined.Timeout}, ` +
      `survived ${combined.Survived}, no-cov ${combined.NoCoverage})`,
  );
  console.log(`Gate: break >= ${BREAK_THRESHOLD}%`);

  if (score < BREAK_THRESHOLD) {
    console.error(
      `\n❌ Mutation-Score ${score.toFixed(2)}% liegt unter dem Gate (${BREAK_THRESHOLD}%).`,
    );
    process.exit(1);
  }
  console.log(`\n✅ Mutation-Score-Gate bestanden.`);
}

main();
