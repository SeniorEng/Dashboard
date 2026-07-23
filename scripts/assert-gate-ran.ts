// ---------------------------------------------------------------------------
// Gate-Meta-Check (Task #1841 — SSoT-AP0)
//
// Verriegelt den „stillen Skip"-Failure-Mode: Ein Test-Gate kann im CI grün
// durchlaufen, OHNE tatsächlich Tests ausgeführt zu haben — z.B. wenn ein
// Vitest-Project-Filter ins Leere greift, ein `outputFile` fehlt, ein
// esbuild-Transform-Fehler eine ganze Datei auf „(0 test)" kollabiert
// (siehe MEMORY: esbuild-straight-quote-zero-tests) oder ein `if:`-Guard den
// Test-Step versehentlich überspringt. Ein grünes Gate ohne Tests ist
// schlimmer als ein rotes: Es täuscht Sicherheit vor.
//
// Dieser Check läuft im CI als UNBEDINGTER (kein `if:`-Guard) finaler Step des
// `tests`-Jobs. Er entscheidet SELBST anhand desselben Secrets, das die
// Test-Steps gated (`TEST_USER_PASSWORD`), ob Tests laufen MUSSTEN:
//
//   - Secret NICHT gesetzt  → legitimer Skip (Fork-PR ohne Secrets). Exit 0.
//   - Secret gesetzt        → jede erwartete JUnit-Datei MUSS existieren UND
//                             Σ(testsuite tests) > 0 melden. Sonst Exit 1.
//
// Weil der Step unbedingt läuft (auch wenn die Test-Steps geskippt wurden —
// ein geskippter Step gilt für `success()` als erfolgreich), fängt er auch
// einen kaputten `if:`-Guard auf den Test-Steps selbst ab.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";

/** Standard-JUnit-Reports, die der `tests`-Job schreibt. */
const DEFAULT_REPORTS = [
  "test-results/vitest-junit.xml",
  "test-results/architecture-junit.xml",
];

/**
 * Summiert das `tests`-Attribut aller `<testsuite …>`-Elemente. Der Regex
 * matcht bewusst NUR `<testsuite ` (mit folgendem Whitespace) und damit NICHT
 * das Wurzelelement `<testsuites …>` — sonst würde die Gesamtsumme doppelt
 * gezählt. Kein XML-Parser-Dependency nötig; das JUnit-Format ist flach.
 */
export function sumTestsuiteTests(xml: string): number {
  let total = 0;
  const re = /<testsuite\s[^>]*\btests="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    total += Number(m[1]);
  }
  return total;
}

type ReportResult =
  | { path: string; ok: true; tests: number }
  | { path: string; ok: false; reason: string };

/** Prüft eine einzelne JUnit-Datei auf Existenz und tests>0. */
export function checkReport(path: string): ReportResult {
  if (!existsSync(path)) {
    return { path, ok: false, reason: "Datei fehlt (Gate hat keinen Report geschrieben)" };
  }
  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch (err) {
    return { path, ok: false, reason: `Datei nicht lesbar: ${(err as Error).message}` };
  }
  const tests = sumTestsuiteTests(xml);
  if (tests <= 0) {
    return { path, ok: false, reason: "Σ(testsuite tests) == 0 — Gate lief, aber ohne Tests" };
  }
  return { path, ok: true, tests };
}

/** Liefert `true`, wenn Tests laufen MUSSTEN (Secret vorhanden). */
function testsWereRequired(): boolean {
  return (process.env.TEST_USER_PASSWORD ?? "") !== "";
}

export function runGateMetaCheck(reports: string[]): number {
  if (!testsWereRequired()) {
    console.log(
      "[assert-gate-ran] TEST_USER_PASSWORD nicht gesetzt — Test-Gates wurden " +
        "legitim übersprungen (z.B. Fork-PR ohne Secrets). Kein Report erwartet. OK.",
    );
    return 0;
  }

  const results = reports.map(checkReport);
  const failures = results.filter((r): r is Extract<ReportResult, { ok: false }> => !r.ok);

  for (const r of results) {
    if (r.ok) {
      console.log(`[assert-gate-ran] OK  ${r.path} — ${r.tests} Test(s) ausgeführt.`);
    } else {
      console.error(`[assert-gate-ran] FAIL ${r.path} — ${r.reason}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      "\n==============================================================================\n" +
        "  GATE-META-CHECK FEHLGESCHLAGEN (Task #1841)\n" +
        "==============================================================================\n" +
        "  TEST_USER_PASSWORD ist gesetzt ⇒ die Test-Gates MUSSTEN laufen, aber\n" +
        "  mindestens ein JUnit-Report fehlt oder meldet 0 Tests. Ein grün\n" +
        "  durchlaufendes Gate OHNE Tests täuscht Sicherheit vor — der Lauf wird\n" +
        "  deshalb rot gestellt. Prüfe Vitest-Project-Filter, `--outputFile`-Pfade\n" +
        "  und die `if:`-Guards der Test-Steps in .github/workflows/ci.yml.\n" +
        "==============================================================================",
    );
    return 1;
  }

  console.log("[assert-gate-ran] Alle erwarteten Gates haben Tests ausgeführt. OK.");
  return 0;
}

// Direktaufruf-Erkennung robust via pathToFileURL (korrektes Encoding für Pfade
// mit Sonderzeichen) — ein String-Vergleich `file://${argv[1]}` könnte sonst
// fehlschlagen und ausgerechnet dieses Anti-Silent-Skip-Werkzeug selbst
// stillschweigend zum No-Op machen.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const args = process.argv.slice(2);
  const reports = args.length > 0 ? args : DEFAULT_REPORTS;
  process.exit(runGateMetaCheck(reports));
}
