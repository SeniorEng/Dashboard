/**
 * Task #441 — Architektur-Test: keine Money-Arithmetik außerhalb des
 * zentralen Helpers `shared/utils/money.ts`.
 *
 * Hintergrund: Vor #441 gab es ~12 Stellen, die `(x / 100).toFixed(2)`
 * direkt aufgerufen haben. Jeder dieser Callsites war eine potenzielle
 * Drift-Quelle (Tausenderpunkte fehlten, Vorzeichen vor "-", Whitespace
 * vor "€", ...). Mit diesem Test bleibt das Format an EINER Stelle
 * verankert. Neue Money-Patterns MÜSSEN `formatEuroDE` / `parseEuroDE` /
 * `centsToEuroNumber` aus `@shared/utils/money` benutzen.
 *
 * Was geprüft wird (positive Money-Signale):
 *   1. toFixed(2).replace(".", ",") — die kanonische DE-Money-Formel.
 *   2. `<centsVar> / 100` — Variable mit "cents"-Namen durch 100
 *      geteilt (Anzeige-Konvertierung).
 *   3. `Math.round(<eurosVar> * 100)` — Euro-Parsing-Muster
 *      (Eingabe-Konvertierung).
 *
 * Allowlist:
 *   - `shared/utils/money.ts` (Helper selbst)
 *   - `shared/utils/format.ts` (Re-Export-Shim, ruft Helper auf)
 *   - `server/lib/zugferd.ts` (XRechnung verlangt englisches Dezimal-
 *     Format mit "."; nutzt `centsToEuroNumber` + `.toFixed(2)`, kein
 *     `.replace(".", ",")`).
 *   - `server/scripts/*` (CLI-Tools für Daten-Reparatur).
 *   - `tests/*` (Equality- und Round-Trip-Tests dürfen Cent-Math ausdrücken).
 *   - Zeilen mit `// money-arithmetic-allowed: <reason>` (Spot-Override).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

const ALLOWED_PATHS = [
  "shared/utils/money.ts",
  "shared/utils/format.ts",
  "server/lib/zugferd.ts",
  "server/scripts/",
  "tests/",
  "dist/",
  "node_modules/",
  "e2e/",
];

const MONEY_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\.toFixed\(\s*2\s*\)\s*\.replace\(\s*["']\.["']\s*,\s*["'],["']\s*\)/,
    reason: "Deutsche Money-Formel `.toFixed(2).replace(\".\", \",\")` — nutze formatEuroDE().",
  },
  {
    regex: /\b\w*[Cc]ents?\b\s*\/\s*100\b/,
    reason: "`<...Cents>/100` — nutze centsToEuroNumber() oder formatEuroDE().",
  },
  {
    regex: /Math\.round\(\s*\w*[Ee]uros?\w*\s*\*\s*100\s*\)/,
    reason: "`Math.round(euros*100)` — nutze parseEuroDE().",
  },
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel.startsWith(p) || rel === p);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("Architektur — Money-Arithmetik nur in `shared/utils/money.ts`", () => {
  it("Keine `(x/100).toFixed(2)` / `Math.round(euros*100)` außerhalb der Allowlist", () => {
    const hits: Array<{ file: string; line: number; snippet: string; reason: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walk(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\/\/\s*money-arithmetic-allowed:/.test(line)) continue;
          if (i > 0 && /\/\/\s*money-arithmetic-allowed:/.test(lines[i - 1])) continue;
          for (const { regex, reason } of MONEY_PATTERNS) {
            if (regex.test(line)) {
              hits.push({
                file: relative(ROOT, file).split(sep).join("/"),
                line: i + 1,
                snippet: line.trim().slice(0, 160),
                reason,
              });
              break;
            }
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line}\n    ${h.reason}\n    > ${h.snippet}`)
        .join("\n");
      expect.fail(
        `Money-Arithmetik außerhalb von 'shared/utils/money.ts' gefunden:\n${msg}\n\n` +
        `Bitte 'formatEuroDE' / 'parseEuroDE' / 'centsToEuroNumber' aus ` +
        `'@shared/utils/money' verwenden. Falls eine Ausnahme nötig ist ` +
        `(z. B. nicht-deutsches Format), die Zeile mit dem Kommentar ` +
        `'// money-arithmetic-allowed: <Begründung>' davor markieren oder ` +
        `den Pfad in ALLOWED_PATHS dieses Tests eintragen.`,
      );
    }
  });
});
