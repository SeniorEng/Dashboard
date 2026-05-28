/**
 * Generalisiertes Targeted-Coverage-Gate (Task #771).
 *
 * Verallgemeinert das ursprüngliche `coverage-billing.ts`-Pattern auf eine
 * Konfig-Liste kritischer Hotspot-Module. Pro Datei wird eine eigene
 * Lines-/Branch-Schwelle erzwungen — Targeted-Gates sind laut Vitest-Praxis
 * 2025/26 die bessere Wahl als ein globaler Threshold über 100k+ LOC.
 *
 * ── Zwei Messmodi, weil die Tests unterschiedlich an den Code herankommen ──
 *
 *   mode "server"  (billing, qonto):
 *     Die Tests sind HTTP-Integrationstests gegen den Express-Server.
 *     Vitest/v8 misst nur den Test-Runner-Prozess — NICHT den separaten
 *     Server-Prozess. Daher starten wir eine instrumentierte Server-Instanz
 *     mit `NODE_V8_COVERAGE=<dir>`, fahren die Tests via `TEST_BASE_URL`
 *     dagegen, beenden den Server (V8 flusht die Profile) und werten mit
 *     `c8 report --check-coverage` aus.
 *
 *   mode "vitest"  (consumption-engine, month-close-scheduler):
 *     Die Tests importieren das Modul direkt und laufen im Vitest-Worker
 *     (`pool: forks`). Rohes `NODE_V8_COVERAGE` wird in diesen Worker-Forks
 *     NICHT zuverlässig geflusht — daher nutzen wir den nativen
 *     `@vitest/coverage-v8`-Provider, der die Worker korrekt instrumentiert.
 *     Schwellen werden gegen die `coverage-summary.json` geprüft. Diese Tests
 *     brauchen keinen eigenen Server: ihr `globalSetup` räumt über die bereits
 *     in CI gestartete App-Instanz (Port 5000) auf, die Testlogik selbst geht
 *     direkt gegen die DB (`DATABASE_URL`).
 *
 * Aufruf:
 *   npx tsx script/coverage-gate.ts                       # alle Module
 *   npx tsx script/coverage-gate.ts qonto                 # ein Modul
 *   npx tsx script/coverage-gate.ts billing consumption-engine
 *
 * Messmodus (Schwellen auf 0 / nur Reporting, Exit 0 sofern Tests grün):
 *   COVERAGE_MEASURE_ONLY=1 npx tsx script/coverage-gate.ts month-close-scheduler
 *
 * Neues Gate ergänzen: Eintrag in `MODULES` hinzufügen (key, mode, target,
 * tests, lines/branches) und in `.github/workflows/ci.yml` einen eigenen Step
 * `npx tsx script/coverage-gate.ts <key>` registrieren. Schwellen am
 * gemessenen Ist-Wert minus ~5 %-Puffer kalibrieren (siehe tests/README.md).
 *
 * Exit-Code:
 *   0  — Tests grün UND alle angeforderten Module erfüllen ihre Schwellen.
 *   ≠0 — Tests fehlgeschlagen, Server nicht beendet, oder Schwelle verfehlt.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import process from "node:process";

interface ModuleGate {
  /** CLI-Key + Verzeichnis-/Reportname. */
  key: string;
  /** "server" = instrumentierter Server + c8; "vitest" = nativer v8-Provider. */
  mode: "server" | "vitest";
  /** Zu messende Quelldatei (relativ zum Repo-Root). */
  target: string;
  /** Test-Dateien, die die Ziel-Datei abdecken. */
  tests: string[];
  /** Mindest-Lines-Coverage in Prozent. */
  lines: number;
  /** Mindest-Branch-Coverage in Prozent. */
  branches: number;
}

// Schwellen orientieren sich am gemessenen Ist-Wert minus ~5 %-Puffer, damit
// kleine Refactors nicht sofort rot werden, Regressionen aber auffallen.
const MODULES: ModuleGate[] = [
  {
    key: "billing",
    mode: "server",
    target: "server/routes/billing.ts",
    tests: ["tests/billing/billing-flow.test.ts"],
    // ~280 Zeilen SMTP-/E-Mail-Pfad in `/:id/send` sind ohne Mail-Mock nicht
    // abdeckbar — daher konservativer Floor. (Ist ~ Lines 55 / Branch 45.)
    lines: 55,
    branches: 45,
  },
  {
    key: "qonto",
    mode: "server",
    target: "server/services/qonto.ts",
    tests: ["tests/billing/qonto-match-audit.test.ts"],
    // Ist (Mai 2026): Lines 53.7 % / Branch 68.8 %. Der reine HTTP-Sync-Pfad
    // (`syncTransactions`) ruft die echte Qonto-API und ist nicht abgedeckt.
    lines: 48,
    branches: 60,
  },
  {
    key: "consumption-engine",
    mode: "vitest",
    target: "server/storage/budget/consumption-engine.ts",
    tests: [
      "tests/budget/cascade-concurrency.test.ts",
      "tests/budget/historization.test.ts",
      "tests/budget/task-721-phased-consumption.test.ts",
      "tests/equality/cascade-leg-field-sum.test.ts",
      "tests/equality/consumption-leg-sum.test.ts",
      "tests/equality/storno-summe-null.test.ts",
      "tests/equality/selbstzahler-private-booking.test.ts",
    ],
    // Ist (Mai 2026): Lines 86.8 % / Branch 67.8 %.
    lines: 82,
    branches: 62,
  },
  {
    key: "month-close-scheduler",
    mode: "vitest",
    target: "server/services/month-close-scheduler.ts",
    tests: [
      "tests/auto-close-scheduler.test.ts",
      "tests/month-closing.test.ts",
    ],
    // Ist (Mai 2026): Lines 38.5 % / Branch 26.1 %. Reminder-Versand
    // (WhatsApp/SMTP) und Banner-HTTP-Pfade laufen außerhalb der direkt
    // importierenden Tests und sind daher nicht abgedeckt.
    lines: 33,
    branches: 21,
  },
];

const PORT = Number(process.env.COVERAGE_PORT || 5050);
const MEASURE_ONLY = /^(1|true)$/i.test(process.env.COVERAGE_MEASURE_ONLY || "");

function header(mod: ModuleGate): void {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`▶ Coverage-Gate „${mod.key}" (${mod.mode}) — Ziel: ${mod.target}`);
  console.log(`══════════════════════════════════════════════════════════════`);
}

async function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1_000);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, "127.0.0.1");
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server auf Port ${port} ist nicht innerhalb von ${timeoutMs}ms gestartet`);
}

/**
 * Wartet, bis V8 mindestens eine `coverage-*.json` in `dir` geschrieben hat.
 * `NODE_V8_COVERAGE`-Profile werden beim Prozess-Exit geschrieben; unter Last
 * kann das einen Moment dauern, nachdem das 'exit'-Event gefeuert hat. Ohne
 * dieses Warten liest c8 ein leeres Verzeichnis und meldet 0/0.
 */
async function waitForCoverageFiles(dir: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const files = await readdir(dir);
      if (files.some((f) => f.startsWith("coverage-") && f.endsWith(".json"))) return true;
    } catch { /* dir not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Wertet eine `coverage-summary.json` (von c8 ODER vitest erzeugt, gleiches
 * Istanbul-Format) gegen die Modul-Schwellen aus.
 *
 * WICHTIG: Ein leeres Resultat (`total.lines.total === 0`) bedeutet, dass die
 * Ziel-Datei NICHT gemessen wurde (Profile nicht geflusht, falscher Pfad …).
 * Das MUSS ein harter Fehler sein — sonst „besteht" das Gate mit 0 % und kann
 * keine Regression mehr erkennen (false positive). `c8 --check-coverage`
 * alleine fällt auf diese 0/0-Falle herein, daher prüfen wir hier selbst.
 */
async function checkSummary(reportDir: string, mod: ModuleGate): Promise<number> {
  const summaryPath = path.join(reportDir, "coverage-summary.json");
  let summary: {
    total?: {
      lines?: { pct?: number; total?: number };
      branches?: { pct?: number };
    };
  };
  try {
    summary = JSON.parse(await readFile(summaryPath, "utf8"));
  } catch (err) {
    console.error(`✖ [${mod.key}] Coverage-Summary nicht lesbar (${summaryPath}):`, err);
    return 1;
  }

  const measuredLines = Number(summary.total?.lines?.total ?? 0);
  if (measuredLines === 0) {
    console.error(
      `✖ [${mod.key}] Keine Coverage-Daten für ${mod.target} (0 messbare Zeilen). ` +
        `Die Datei wurde von den Tests nicht ausgeführt oder die V8-Profile wurden ` +
        `nicht geschrieben — das Gate wird NICHT als bestanden gewertet.`,
    );
    return 1;
  }

  const linesPct = Number(summary.total?.lines?.pct ?? 0);
  const branchesPct = Number(summary.total?.branches?.pct ?? 0);
  console.log(
    `▶ [${mod.key}] Gemessen: Lines ${linesPct.toFixed(2)}% / Branches ${branchesPct.toFixed(2)}%`,
  );

  if (MEASURE_ONLY) return 0;

  const linesOk = linesPct >= mod.lines;
  const branchesOk = branchesPct >= mod.branches;
  if (!linesOk || !branchesOk) {
    if (!linesOk) console.error(`✖ [${mod.key}] Lines ${linesPct.toFixed(2)}% < ${mod.lines}%`);
    if (!branchesOk) console.error(`✖ [${mod.key}] Branches ${branchesPct.toFixed(2)}% < ${mod.branches}%`);
    return 1;
  }
  console.log(`✔ [${mod.key}] Coverage-Schwellen erreicht (Lines ≥${mod.lines}%, Branches ≥${mod.branches}%)`);
  return 0;
}

async function stopGracefully(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null) return;
  // detached:true gibt dem Kind eine eigene Prozessgruppe → die ganze Gruppe
  // signalisieren, damit nachgelagerte tsx/node-Prozesse SIGTERM erhalten und
  // V8 die Coverage flusht.
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* group may already be gone */ }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
      resolve();
    }, timeoutMs);
    child.on("exit", () => { clearTimeout(t); resolve(); });
  });
}

/** mode "server": instrumentierter Server + HTTP-Tests + c8 report. */
async function runServerGate(mod: ModuleGate): Promise<number> {
  const coverageDir = path.resolve(process.cwd(), "coverage", `${mod.key}-raw`);
  const reportDir = path.resolve(process.cwd(), "coverage", mod.key);

  await rm(coverageDir, { recursive: true, force: true });
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(coverageDir, { recursive: true });

  console.log(`▶ Starte instrumentierten Server auf Port ${PORT} (NODE_V8_COVERAGE=${coverageDir})`);
  // WICHTIG: `node --import tsx server/index.ts` statt der `tsx`-Bin-Wrapper.
  // Der `tsx`-Wrapper spawnt einen KIND-Prozess für die eigentliche Ausführung;
  // dessen V8-Profile werden beim Beenden unter Last nicht zuverlässig
  // geflusht (der Wrapper-Prozess schreibt nur die Loader-Module → c8 sieht
  // 0/0). `--import tsx` läuft im selben Prozess, dessen Coverage wir per
  // NODE_V8_COVERAGE + sauberem SIGTERM-Shutdown deterministisch erhalten.
  const server = spawn("node", ["--import", "tsx", "server/index.ts"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      NODE_V8_COVERAGE: coverageDir,
    },
  });

  let serverExitCode: number | null = null;
  server.on("exit", (code) => { serverExitCode = code; });

  try {
    await waitForPort(PORT);
    console.log(`✔ Server bereit auf Port ${PORT}`);

    console.log(`▶ Starte Vitest gegen TEST_BASE_URL=http://localhost:${PORT}`);
    const testExitCode = await runCommand(
      "npx",
      ["vitest", "run", ...mod.tests],
      { TEST_BASE_URL: `http://localhost:${PORT}` },
    );

    console.log(`▶ Beende Server (SIGTERM) — V8 schreibt Coverage-Profile`);
    await stopGracefully(server, 25_000);

    if (testExitCode !== 0) {
      console.error(`✖ [${mod.key}] Tests fehlgeschlagen (exit=${testExitCode})`);
      return testExitCode;
    }

    const flushed = await waitForCoverageFiles(coverageDir);
    if (!flushed) {
      console.error(
        `✖ [${mod.key}] V8 hat keine Coverage-Profile in ${coverageDir} geschrieben — ` +
          `Server-Shutdown vermutlich abgebrochen. Gate gilt als NICHT bestanden.`,
      );
      return 1;
    }

    console.log(`▶ [${mod.key}] Erzeuge c8-Report für ${mod.target}`);
    // Kein `--check-coverage` hier: c8 wertet 0/0 ("Unknown") als bestanden,
    // was ein false-positive-Gate erzeugt. Die Schwellen-/Leer-Prüfung macht
    // `checkSummary` anhand der json-summary — identisch für beide Modi.
    const reportExitCode = await runCommand(
      "npx",
      [
        "c8",
        "report",
        `--temp-directory=${coverageDir}`,
        `--reports-dir=${reportDir}`,
        "--reporter=text",
        "--reporter=text-summary",
        "--reporter=html",
        "--reporter=json-summary",
        `--include=${mod.target}`,
      ],
      {},
    );

    if (reportExitCode !== 0) {
      console.error(`✖ [${mod.key}] c8-Report fehlgeschlagen (exit=${reportExitCode})`);
      return reportExitCode;
    }
    return checkSummary(reportDir, mod);
  } finally {
    if (serverExitCode === null) {
      await stopGracefully(server);
    }
  }
}

/** mode "vitest": nativer @vitest/coverage-v8-Provider + JSON-Summary-Check. */
async function runVitestGate(mod: ModuleGate): Promise<number> {
  const reportDir = path.resolve(process.cwd(), "coverage", mod.key);
  await rm(reportDir, { recursive: true, force: true });

  console.log(`▶ [${mod.key}] Starte Vitest mit nativer v8-Coverage`);
  const testExitCode = await runCommand(
    "npx",
    [
      "vitest",
      "run",
      ...mod.tests,
      "--coverage",
      "--coverage.provider=v8",
      `--coverage.include=${mod.target}`,
      "--coverage.all=false",
      "--coverage.reporter=text",
      "--coverage.reporter=html",
      "--coverage.reporter=json-summary",
      `--coverage.reportsDirectory=${reportDir}`,
    ],
    {},
  );

  if (testExitCode !== 0) {
    console.error(`✖ [${mod.key}] Tests fehlgeschlagen (exit=${testExitCode})`);
    return testExitCode;
  }

  return checkSummary(reportDir, mod);
}

async function runGate(mod: ModuleGate): Promise<number> {
  header(mod);
  return mod.mode === "server" ? runServerGate(mod) : runVitestGate(mod);
}

async function main(): Promise<number> {
  const requested = process.argv.slice(2);
  const gates = requested.length === 0
    ? MODULES
    : requested.map((key) => {
        const mod = MODULES.find((m) => m.key === key);
        if (!mod) {
          throw new Error(
            `Unbekanntes Coverage-Gate „${key}". Verfügbar: ${MODULES.map((m) => m.key).join(", ")}`,
          );
        }
        return mod;
      });

  for (const mod of gates) {
    const code = await runGate(mod);
    if (code !== 0) return code;
  }
  console.log(`\n✔ Alle angeforderten Coverage-Gates erfüllt: ${gates.map((g) => g.key).join(", ")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
