/**
 * Coverage-Gate für `server/routes/billing.ts` (Task #109).
 *
 * Die Billing-Tests laufen als HTTP-Integrationstests gegen den Express-Server.
 * Vitest/v8-Coverage misst nur Code im Test-Runner-Prozess — nicht den
 * Server-Prozess. Wir starten daher hier eine separate, instrumentierte
 * Server-Instanz mit `NODE_V8_COVERAGE=...`, fahren die Tests gegen sie
 * und werten anschließend Lines-/Branch-Coverage über `c8 report
 * --check-coverage` aus.
 *
 * Aufruf:  npx tsx script/coverage-billing.ts
 *
 * Exit-Code:
 *   0 — alle Tests grün UND Coverage-Schwellen erfüllt
 *       (Default: Lines ≥ 55 %, Branches ≥ 45 % — siehe LINE_THRESHOLD /
 *        BRANCH_THRESHOLD weiter unten und tests/README.md für die
 *        Begründung der Werte).
 *   ≠0 — Tests fehlgeschlagen, Server hat sich nicht beendet, oder eine
 *        der Schwellen wurde unterschritten.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import process from "node:process";

const PORT = Number(process.env.COVERAGE_PORT || 5050);
const COVERAGE_DIR = path.resolve(process.cwd(), "coverage", "billing-raw");
const REPORT_DIR = path.resolve(process.cwd(), "coverage", "billing");
// Realistische Schwellen für HTTP-Integration-Coverage gegen
// einen produktiven Express-Server (nicht in-Process). V8-Branch-Coverage
// zählt nur Branches in BEOBACHTETEN Code-Pfaden — der ~280 Zeilen lange
// SMTP-/E-Mail-Pfad in `router.post("/:id/send")` lässt sich ohne Mail-
// Mocking nicht abdecken (würde echte Postausgänge erzeugen). Der Floor
// orientiert sich an der aktuellen, gemessenen Coverage und schützt vor
// Regressionen unter diese Linie.
const LINE_THRESHOLD = Number(process.env.COVERAGE_LINE_THRESHOLD || 55);
const BRANCH_THRESHOLD = Number(process.env.COVERAGE_BRANCH_THRESHOLD || 45);
const TARGET_FILE = "server/routes/billing.ts";
const TEST_FILE = "tests/billing/billing-flow.test.ts";

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

async function stopGracefully(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null) return;
  // detached:true gives the child its own process group → signal the whole group
  // so descendant tsx/node processes receive SIGTERM and V8 flushes coverage.
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

async function main(): Promise<number> {
  await rm(COVERAGE_DIR, { recursive: true, force: true });
  await rm(REPORT_DIR, { recursive: true, force: true });
  await mkdir(COVERAGE_DIR, { recursive: true });

  console.log(`▶ Starte instrumentierten Server auf Port ${PORT} (NODE_V8_COVERAGE=${COVERAGE_DIR})`);
  const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
  const server = spawn(tsxBin, ["server/index.ts"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      NODE_V8_COVERAGE: COVERAGE_DIR,
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
      ["vitest", "run", TEST_FILE],
      { TEST_BASE_URL: `http://localhost:${PORT}` },
    );

    console.log(`▶ Beende Server (SIGTERM) — V8 schreibt Coverage-Profile`);
    await stopGracefully(server);

    if (testExitCode !== 0) {
      console.error(`✖ Tests fehlgeschlagen (exit=${testExitCode})`);
      return testExitCode;
    }

    console.log(`▶ Werte Coverage für ${TARGET_FILE} aus (Lines ≥${LINE_THRESHOLD}%, Branches ≥${BRANCH_THRESHOLD}%)`);
    const reportExitCode = await runCommand(
      "npx",
      [
        "c8",
        "report",
        `--temp-directory=${COVERAGE_DIR}`,
        `--reports-dir=${REPORT_DIR}`,
        "--reporter=text",
        "--reporter=text-summary",
        "--reporter=html",
        "--reporter=json-summary",
        `--include=${TARGET_FILE}`,
        "--check-coverage",
        `--lines=${LINE_THRESHOLD}`,
        `--branches=${BRANCH_THRESHOLD}`,
      ],
      {},
    );

    if (reportExitCode !== 0) {
      console.error(`✖ Coverage-Schwelle nicht erreicht (exit=${reportExitCode})`);
      return reportExitCode;
    }
    console.log(`✔ Coverage-Schwellen für ${TARGET_FILE} erreicht (Lines ≥${LINE_THRESHOLD}%, Branches ≥${BRANCH_THRESHOLD}%)`);
    return 0;
  } finally {
    if (serverExitCode === null) {
      await stopGracefully(server);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
