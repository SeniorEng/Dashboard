/**
 * Task #427 — Architektur-Test: zentrale Berechnungen leben in `shared/domain/`.
 *
 * Hintergrund: Drift zwischen Anzeige und Buchung entsteht typischerweise,
 * wenn dieselbe Berechnung an zwei Orten parallel implementiert wird. Diese
 * Konvention zwingt uns, neue Cap-/Pricing-/Pro-Rata-/Cutoff-Funktionen in
 * `shared/domain/` (oder `shared/utils/`) zu verankern, damit Read- und
 * Write-Pfad denselben Code aufrufen.
 *
 * Was geprüft wird: Es darf keine NEUEN Funktionen mit Namen
 * `calculate*`/`compute*` für die unten gelisteten Hotspot-Kategorien
 * außerhalb von `shared/domain/`, `shared/utils/` oder einer expliziten
 * Allowlist (siehe `ALLOWED_PATHS`) entstehen. Bestehende
 * `server/storage/...`-Wrapper, die ausschließlich `shared/domain/` aufrufen,
 * sind in der Allowlist enthalten.
 *
 * Failure-Modus: Test schlägt fehl mit der Liste der Treffer und einer
 * Erklärung, wie man die Berechnung nach `shared/domain/` zieht.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

// Hotspot-Schlüsselwörter: wenn der DEKLARIERTE Funktionsname auf eines
// dieser Muster passt, MUSS er in shared/domain/ wohnen (oder explizit in
// der Allowlist stehen). Das `NAME`-Capture wird vom Declaration-Matcher
// unten eingesetzt.
const HOTSPOT_NAME_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^calculate(Cap|MonthlyLimit|.*45b|.*45a)/i, reason: "Cap-Mathe" },
  { regex: /^compute(Cap|MonthlyLimit|.*45b)/i, reason: "Cap-Mathe" },
  { regex: /^calculate(Pflegegrad|.*Price)/i, reason: "Pflegegrad-Preise" },
  { regex: /^calculate(ProRata|.*Vacation|.*Entitlement)/i, reason: "Pro-Rata-Urlaub" },
  { regex: /^calculate(.*Travel|.*Reisekost)/i, reason: "Reisekosten" },
  { regex: /^compute(.*Cutoff|.*MonthClose)/i, reason: "Monatsabschluss-Cutoff" },
];

/**
 * Extrahiert den Namen einer Funktions-/Konstanten-DEKLARATION aus einer
 * Code-Zeile. Aufrufstellen wie `const x = computeCapSlot(...)` werden
 * absichtlich NICHT getroffen, weil dort der zugewiesene Name (`x`)
 * extrahiert wird, nicht der aufgerufene Funktionsname.
 */
function extractDeclaredName(line: string): string | null {
  // function foo / async function foo / export (default)? function foo
  const fn = line.match(/\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/);
  if (fn) return fn[1];
  // const foo = ... | let foo = ... | var foo = ...
  // Erfasst auch arrow functions / function expressions als Wert. Wir
  // verlassen uns darauf, dass der NAME selbst dem Hotspot-Muster folgt.
  const cn = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
  if (cn) return cn[1];
  // Klassen-Methoden: `  calculateFoo(args) {` oder `  async calculateFoo(`
  const mt = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/);
  if (mt) return mt[1];
  return null;
}

// Pfade, die explizit erlaubt sind, weil sie reine Wrapper/Storage-Layer um
// shared/domain/ sind oder die kanonische Implementation bilden.
const ALLOWED_PATHS = [
  "shared/domain/",
  "shared/utils/",
  // Storage-Wrapper, die nur calculate*-Funktionen aus shared/domain/ aufrufen
  // bzw. die DB-Side-Effekte durchführen, die nicht reine Mathematik sind.
  // Wenn diese Wrapper neue Mathematik einführen, muss sie nach shared/domain/.
  "server/storage/budget/cap-calculator.ts",
  "server/storage/budget/appointment-cost-calculator.ts",
  "server/storage/time-tracking/vacation.ts",
  "server/services/month-close-scheduler.ts",
  // Bekannte Baseline-Treffer (Stand Task #427): bereits existierende
  // Funktionen, die historisch außerhalb von shared/domain/ leben. Vor
  // weiteren Refactors hier eintragen, NIEMALS einfach erweitern, ohne den
  // Hotspot zu prüfen — der Sinn der Architektur-Schranke wäre sonst hinüber.
  "server/services/travel-time.ts",
  "server/storage/budget/allocation-storage.ts",
  // Tests dürfen Referenzen auf hotspot-Berechnungen haben.
  "tests/",
  // Build/Skript-Artefakte.
  "dist/",
  "node_modules/",
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel.startsWith(p));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("Architektur — zentrale Berechnungen in shared/domain/", () => {
  it("Keine neuen Hotspot-`calculate*`/`compute*`-Funktionen außerhalb der Allowlist", () => {
    const hits: Array<{ file: string; line: number; match: string; reason: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walk(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const name = extractDeclaredName(line);
          if (!name) continue;
          // Filter: typische Keywords, die der Methoden-Matcher fälschlich
          // greift (`if (...)`, `for (...)`, `return (...)` etc.).
          if (/^(?:if|for|while|switch|return|throw|catch|else|do|try|new|await|typeof|void|in|of)$/i.test(name)) {
            continue;
          }
          for (const { regex, reason } of HOTSPOT_NAME_PATTERNS) {
            if (regex.test(name)) {
              hits.push({
                file: relative(ROOT, file).split(sep).join("/"),
                line: i + 1,
                match: name,
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
        .map((h) => `  ${h.file}:${h.line} — '${h.match}' (${h.reason})`)
        .join("\n");
      expect.fail(
        `Folgende Hotspot-Berechnungen liegen außerhalb von 'shared/domain/' bzw. der Allowlist:\n` +
        `${msg}\n\n` +
        `Verschiebe die Berechnungslogik nach 'shared/domain/' (oder ergänze die ` +
        `Allowlist in 'tests/architecture/calculations-in-shared.test.ts', wenn der ` +
        `Treffer ein reiner Wrapper ist).`,
      );
    }
  });
});
