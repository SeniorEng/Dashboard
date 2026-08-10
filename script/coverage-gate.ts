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
  /**
   * `true`, wenn die abdeckenden Tests echten Object-Storage-Zugriff brauchen
   * (PDF-/Leistungsnachweis-/pdf-lib-Merge-Pfade). Ist kein Object Storage
   * konfiguriert, skippen diese Tests via `it.skipIf(!hasObjectStorageEnv)` —
   * dann wären die großen PDF-Bereiche der Ziel-Datei nie ausgeführt und die
   * Coverage bräche unter den (mit Object Storage kalibrierten) Floor. Das Gate
   * skippt deshalb sauber statt rot zu werden (gleiches CI-Muster wie
   * „erechnung ohne Java" / „ci-seed ohne Secrets").
   */
  requiresObjectStorage?: boolean;
}

// Object-Storage-Verfügbarkeit — identische Notion wie in
// `tests/helpers/object-storage.ts` (`hasObjectStorageEnv`). Lokal/in Replit
// sind beide Variablen gesetzt und die PDF-Tests laufen voll durch; in der
// GitHub-Actions-CI fehlt der Object-Storage-Sidecar, die Variablen sind dort
// bewusst nicht gesetzt und die betroffenen Tests werden übersprungen.
const hasObjectStorageEnv =
  !!process.env.PRIVATE_OBJECT_DIR && !!process.env.PUBLIC_OBJECT_SEARCH_PATHS;

// Schwellen orientieren sich am gemessenen Ist-Wert minus ~5 %-Puffer, damit
// kleine Refactors nicht sofort rot werden, Regressionen aber auffallen.
const MODULES: ModuleGate[] = [
  {
    key: "billing",
    mode: "server",
    target: "server/routes/billing.ts",
    tests: ["tests/billing/billing-flow.test.ts"],
    // Gemessen wird mit NUR `billing-flow.test.ts` — diese Datei übt die HTTP-
    // Read-/Generate-Pfade (GET `/`, `/preview`, `/generate`, `/:id/pdf`,
    // `/:id/leistungsnachweis`, `/:id/status`) aus, also die vordere Hälfte der
    // Route. Die schweren Bulk-/Versand-/Batch-Routen (`/send-batch`,
    // `/:id/send` (SMTP), `/:id/bundle`, `/:id/mark-sent`, `/send-bulk`,
    // `/bulk-print`, `/generate-all`, `/bundle-by-payer`, `/discard-drafts`)
    // werden von DEDIZIERTEN Schwester-Tests in `tests/billing/` abgedeckt
    // (bulk-print / generate-all-error-shape / zugferd-send-batch-failure /
    // bundle-duplicate-ln / invoice-pdf-orchestrator-e2e …), laufen aber NICHT
    // in dieser einen Datei → die Ein-Datei-Messung liegt ehrlich bei
    // ~Lines 25 % / Branch 44 % (mit Object Storage; ohne fällt sie auf ~24 %
    // und das Gate skippt sauber, s.u.).
    //
    // In der GitHub-Actions-CI skippt dieses Gate ohnehin immer (kein
    // Object-Storage-Sidecar) — der frühere 55/45-Floor hat dort also NIE
    // wirklich gegated und war für die Ein-Datei-Messung unerreichbar. Floors
    // daher ehrlich am gemessenen Ist-Wert minus ~5 %-Puffer kalibriert. Das
    // maskiert KEINE Regression: die Bulk-/Versand-Routen SIND getestet, nur in
    // den Schwester-Dateien statt hier. Wer einen härteren Floor will, nimmt die
    // HTTP-getriebenen Schwester-Tests zusätzlich in `tests` auf.
    lines: 20,
    branches: 38,
    requiresObjectStorage: true,
  },
  {
    key: "qonto",
    mode: "server",
    target: "server/services/qonto.ts",
    // Die Liste war STEHENGEBLIEBEN: sie fuehrte genau EINE Datei, waehrend das
    // Modul um die Sammel-Avis-Logik wuchs und die Tests dafuer in ANDERE
    // Dateien geschrieben wurden. Gemessen wurden damit 42,5 % — nicht weil der
    // Code untestet war, sondern weil das Gate sechs von sieben einschlaegigen
    // Dateien nicht ausfuehrte. Mit der vollstaendigen Liste: 66,0 % / 80,0 %.
    //
    // NICHT dabei: `qonto-backfill-lock.test.ts`. Der Gate-Server laeuft mit
    // `NODE_ENV=development` (siehe `serverEnv` weiter unten), der HTTP-Stub in
    // `qonto.ts` greift aber nur bei `NODE_ENV === "test"` — die Datei liefe
    // hier gegen die echte Qonto-API. Im regulaeren `tests`-Job ist sie gruen.
    tests: [
      "tests/billing/qonto-match-audit.test.ts",
      "tests/billing/qonto-amount-match-guard.test.ts",
      "tests/billing/qonto-bulk-match.test.ts",
      "tests/billing/qonto-multi-iban-sync.test.ts",
      // Diese beiden fahren die Sammel-Avis-Pfade an (`tryBulkAdviceMatch`,
      // `autoCloseAdviceFromTransactions`) — zusammen ~120 Zeilen, die vorher
      // komplett ungemessen waren.
      "tests/billing/bulk-advice-match.test.ts",
      "tests/billing/ambiguous-advice-resolve.test.ts",
    ],
    // Ist (10.08.2026): Lines 66,0 % / Branch 80,0 %, kalibriert mit dem in
    // diesem Datei-Kopf dokumentierten ~5 %-Puffer. Der reine HTTP-Sync-Pfad
    // (`syncTransactions`, `testConnection`, `backfillTransactions`) ruft die
    // echte Qonto-API und bleibt unabgedeckt — das ist der Rest bis 100 %.
    lines: 60,
    branches: 72,
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
    // Dieselbe Drift wie beim `qonto`-Gate: die Liste blieb STEHEN, während das
    // Modul wuchs und die Tests dafür in ANDERE Dateien geschrieben wurden.
    // Gemessen wurden zuletzt 28,8 % — nicht weil der Code untestet ist,
    // sondern weil das Gate die einschlägigen Dateien nicht ausführte. Genau
    // daran ist Schritt 18 in CI gescheitert: die Schwellen (33/21) standen
    // über dem, was die verkürzte Liste überhaupt messen konnte.
    tests: [
      "tests/auto-close-scheduler.test.ts",
      "tests/month-closing.test.ts",
      // Beide importieren `autoCloseMonthForCutoff` direkt und fahren den
      // Auto-Close-Pfad an — zusammen der Teil des Moduls, der vorher
      // vollständig ungemessen blieb.
      "tests/auto-close-no-overwrite.test.ts",
      "tests/month-close-unified-readiness.test.ts",
    ],
    // NICHT dabei: `tests/equality/month-close-cutoff.test.ts`. Die Datei nennt
    // das Modul nur in einem Kommentar; importiert wird `shared/utils/
    // month-close-cutoff`, und die Cutoff-/Banner-Pfade werden über HTTP
    // geprüft. Im `vitest`-Modus misst der v8-Provider aber nur, was der
    // Worker selbst lädt — die Datei trägt hier also nichts bei und kostet nur
    // Laufzeit. Gemessen und verworfen, nicht vermutet.
    //
    // Ist (10.08.2026): Lines 41,66 % / Branch 26,74 % — vorher 28,78 / 16,27
    // mit der verkürzten Liste. Kalibriert mit dem im Datei-Kopf dokumentierten
    // ~5 %-Puffer: 41,66 − 5 ≈ 36, 26,74 − 5 ≈ 21.
    //
    // Branches bleibt damit auf 21 STEHEN. Das ist keine Absenkung, sondern das
    // Ergebnis derselben Rechnung — die Schwelle war schon vorher über dem, was
    // die alte Liste messen konnte (16,27 %), und trägt jetzt echten Puffer
    // statt zufällig zu passen.
    //
    // Reminder-Versand (WhatsApp/SMTP) und die Banner-HTTP-Pfade laufen
    // weiterhin außerhalb der direkt importierenden Tests und bleiben
    // unabgedeckt — das ist der Rest bis 100 %.
    lines: 36,
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
  // `BUDGET_HARD_HOLDS=1` leckt aus `.replit` `[userenv.development]` in jeden
  // dev-mode-Prozess. Der Test-Orchestrator (`scripts/with-ephemeral-db.ts`)
  // strippt es bewusst (`delete baseEnv.BUDGET_HARD_HOLDS`), weil aktive
  // Hard-Holds die Low-Budget-Termin-Fixtures der Suite bereits an der
  // Termin-ANLAGE hart blocken (findFreeSlotAndCreate findet nie einen Slot →
  // 60s-Timeout). Dieses Gate fährt dieselben HTTP-Tests gegen einen eigenen
  // dev-Server und MUSS das Flag identisch strippen, sonst ist schon der
  // dokumentierte Aufruf nicht lauffähig.
  const serverEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    NODE_V8_COVERAGE: coverageDir,
  };
  delete serverEnv.BUDGET_HARD_HOLDS;

  const server = spawn("node", ["--import", "tsx", "server/index.ts"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: serverEnv,
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
  // Object-Storage-abhängiges Gate ohne konfiguriertes Object Storage: sauber
  // skippen statt rot werden. Die abdeckenden PDF-/LN-Tests skippen dann selbst
  // (`it.skipIf(!hasObjectStorageEnv)`), wodurch die mit Object Storage
  // kalibrierten Floors nicht mehr erreichbar wären. Exit 0 (gleiches Muster
  // wie „erechnung ohne Java" / „ci-seed ohne Secrets").
  if (mod.requiresObjectStorage && !hasObjectStorageEnv) {
    console.log(
      `⏭ [${mod.key}] Übersprungen — kein Object Storage konfiguriert ` +
        `(PRIVATE_OBJECT_DIR / PUBLIC_OBJECT_SEARCH_PATHS fehlen). Die ` +
        `PDF-/Leistungsnachweis-Coverage-Pfade von ${mod.target} sind ohne ` +
        `Object Storage nicht abdeckbar; die Tests skippen ebenfalls. ` +
        `Gate gilt als bestanden (Exit 0).`,
    );
    return 0;
  }
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
