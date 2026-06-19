/**
 * Task #874 — Budget GF Phase 4 Architecture-Test (Invariante I1):
 * EIN Verfügbarkeits-Reader.
 *
 * Hintergrund: Die Budget-Verfügbarkeit („wieviel ist noch frei") wird aus dem
 * Cap-Slot abgeleitet — konkret aus `computeCapSlot(...).netUsedInWindowCents`
 * (bzw. der pure Cap-Math-Eingabe). Damit nicht erneut Parallel-Reader
 * entstehen, die ihre eigene Verfügbarkeits-Mathematik aus `netUsedInWindowCents`
 * zusammenbauen, ist der **lesende Zugriff** auf `.netUsedInWindowCents` auf eine
 * Allowlist beschränkt:
 *
 *  - `unified-reader.ts`     — DER eine Verfügbarkeits-Reader (Task #874).
 *  - `cap-math.ts`           — pure Cap-Math (`input.netUsedInWindowCents`).
 *  - `summary-queries.ts`    — Legacy-Reader; bleibt bis Phase 6 SSoT-Fallback
 *                              (Shadow-Soak überwacht die Drift), wird in
 *                              Phase 6 entfernt — NICHT in dieser Phase.
 *
 * Failure-Modus: Test listet neue/veraltete Dateien. Behebung: Verfügbarkeit
 * über `readUnifiedBudgetAvailability` lesen statt einen eigenen Reader aus
 * `netUsedInWindowCents` zu bauen. Ein bewusst neuer Reader muss hier UND in der
 * Architektur-Doku dokumentiert werden.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

/**
 * Allowlist: jede Datei, die den Cap-Slot-Verbrauch (`.netUsedInWindowCents`)
 * liest, um Verfügbarkeit abzuleiten, MUSS hier stehen.
 */
const ALLOWLIST = new Set<string>([
  "server/storage/budget/unified-reader.ts",
  "shared/domain/budget/cap-math.ts",
  "server/storage/budget/summary-queries.ts",
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/**
 * Sammelt alle PRODUKTIVEN (`server/`+`shared/`, ohne `tests/` und
 * `server/scripts/`) `.ts`-Dateien, deren Code (Kommentare gestrippt) `callRe`
 * matcht. Reine Imports/Doku triggern bewusst nicht (siehe jeweiliges `callRe`).
 */
function collectProductionCallSites(callRe: RegExp): Set<string> {
  const scanRoots = ["server", "shared"].map((p) => join(ROOT, p));
  const hits = new Set<string>();
  for (const root of scanRoots) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    for (const file of walk(root)) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (rel.startsWith("tests/")) continue;
      if (rel.startsWith("server/scripts/")) continue;
      const content = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (!callRe.test(content)) continue;
      hits.add(rel);
    }
  }
  return hits;
}

describe("Architektur — EIN Budget-Verfügbarkeits-Reader (Task #874 I1)", () => {
  it("Verfügbarkeits-Ableitung aus `.netUsedInWindowCents` nur in der Allowlist", () => {
    const scanRoots = ["server", "shared"].map((p) => join(ROOT, p));
    const hits = new Set<string>();

    // Property-Zugriff (führender Punkt) => Konsum des Cap-Slots zur
    // Verfügbarkeits-Ableitung. Die reine Feld-Deklaration
    // (`netUsedInWindowCents: number;`) hat KEINEN führenden Punkt und triggert
    // daher bewusst nicht.
    const consumeRe = /\.netUsedInWindowCents\b/;

    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walk(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        // Tests und Wartungs-Skripte sind keine produktiven Reader.
        if (rel.startsWith("tests/")) continue;
        if (rel.startsWith("server/scripts/")) continue;

        // Kommentare strippen — eine bloße Doku-Erwähnung von
        // `computeCapSlot.netUsedInWindowCents` ist kein Reader.
        const content = readFileSync(file, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (!consumeRe.test(content)) continue;
        hits.add(rel);
      }
    }

    const unexpected = [...hits].filter((f) => !ALLOWLIST.has(f)).sort();
    const stale = [...ALLOWLIST].filter((f) => !hits.has(f)).sort();

    if (unexpected.length > 0) {
      expect.fail(
        `Folgende Dateien leiten Budget-Verfügbarkeit aus ` +
          `\`.netUsedInWindowCents\` ab, sind aber kein sanktionierter Reader:\n` +
          unexpected.map((f) => `  ${f}`).join("\n") +
          `\n\nKontext: Es darf nur EINEN Verfügbarkeits-Reader geben ` +
          `(\`readUnifiedBudgetAvailability\`, Task #874 I1). Lies Verfügbarkeit ` +
          `über den unified Reader statt einen eigenen aus \`netUsedInWindowCents\` ` +
          `zu bauen. Ist die Datei ein bewusst neuer Reader, dokumentiere ihn hier ` +
          `und in docs/architecture/budget.md.`,
      );
    }
    if (stale.length > 0) {
      expect.fail(
        `Folgende Dateien stehen in der Single-Reader-Allowlist, lesen aber ` +
          `kein \`.netUsedInWindowCents\` mehr:\n` +
          stale.map((f) => `  ${f}`).join("\n") +
          `\n\nEntferne den veralteten Eintrag aus \`ALLOWLIST\`.`,
      );
    }
  });

  // Task #1348 — EINE §45b-Verfügbarkeits-Funktion.
  //
  // Hintergrund: §45b hat (anders als die Cap-Töpfe) keinen `netUsedInWindowCents`-
  // Reader, sondern eine eigene Jahres-Verfügbarkeits-Mathematik
  // (`max(0, allocated − holds − consumedNet)`, inkl. #1306/#1340-Exklusion und
  // Reader-Toren). Diese ist in `netAvailable45bAt` konsolidiert (Task #1348). Damit
  // keine Parallel-§45b-Reader entstehen, ist der PRODUKTIVE Aufruf von
  // `netAvailable45bAt` auf eine Allowlist beschränkt — der unified-reader delegiert,
  // alle anderen Verfügbarkeits-Anzeigen laufen über ihn.
  const ALLOWLIST_45B = new Set<string>([
    "server/storage/budget/net-available-45b.ts", // Definition (die §45b-SSoT).
    "server/storage/budget/unified-reader.ts", // DER eine Reader (delegiert §45b).
  ]);

  it("§45b-Verfügbarkeit nur über die SSoT `netAvailable45bAt` (Task #1348)", () => {
    const scanRoots = ["server", "shared"].map((p) => join(ROOT, p));
    const hits = new Set<string>();

    // Aufruf/Definition der §45b-Verfügbarkeits-SSoT (Name gefolgt von `(`).
    // Der reine Import (`{ netAvailable45bAt }`) hat kein `(` und triggert nicht.
    const callRe = /netAvailable45bAt\s*\(/;

    for (const root of scanRoots) {
      try {
        statSync(root);
      } catch {
        continue;
      }
      for (const file of walk(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        // Tests und read-only Diff-/Wartungs-Skripte sind keine produktiven Reader.
        if (rel.startsWith("tests/")) continue;
        if (rel.startsWith("server/scripts/")) continue;

        const content = readFileSync(file, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (!callRe.test(content)) continue;
        hits.add(rel);
      }
    }

    const unexpected = [...hits].filter((f) => !ALLOWLIST_45B.has(f)).sort();
    const stale = [...ALLOWLIST_45B].filter((f) => !hits.has(f)).sort();

    if (unexpected.length > 0) {
      expect.fail(
        `Folgende Dateien berechnen §45b-Verfügbarkeit über \`netAvailable45bAt\`, ` +
          `sind aber kein sanktionierter Reader:\n` +
          unexpected.map((f) => `  ${f}`).join("\n") +
          `\n\nKontext: §45b-Verfügbarkeit gibt es nur EINMAL (\`netAvailable45bAt\`, ` +
          `Task #1348). Lies sie über \`readUnifiedBudgetAvailability\` statt einen ` +
          `eigenen §45b-Reader zu bauen. Ist die Datei ein bewusst neuer Reader, ` +
          `dokumentiere ihn hier UND in docs/architecture/budget.md.`,
      );
    }
    if (stale.length > 0) {
      expect.fail(
        `Folgende Dateien stehen in der §45b-Single-Source-Allowlist, rufen aber ` +
          `\`netAvailable45bAt\` nicht mehr auf:\n` +
          stale.map((f) => `  ${f}`).join("\n") +
          `\n\nEntferne den veralteten Eintrag aus \`ALLOWLIST_45B\`.`,
      );
    }
  });

  // Task #1348 — KEINE hand-gerollte §45b-"allocated − consumed"-Mathe außerhalb der
  // SSoT. Die reine Schluss-Arithmetik (Floor + Holds-Kontext +
  // `max(0, allocated − holds − consumedNet)`) ist in `computeNetAvailable45b`
  // (`shared/domain/budget/net-available-45b.ts`) konsolidiert. Zusammen mit dem
  // calculations-in-shared-Test (#427: `compute*45b` MUSS in `shared/domain/` wohnen)
  // verhindert dieser Guard, dass irgendwo erneut eine eigene §45b-Verfügbarkeits-
  // Mathe entsteht: jede Verwendung MUSS die pure SSoT aufrufen, und der Aufruf ist
  // auf Definition + den EINEN DB-Reader beschränkt.
  const ALLOWLIST_COMPUTE_45B = new Set<string>([
    "shared/domain/budget/net-available-45b.ts", // Definition (die pure §45b-Mathe-SSoT).
    "server/storage/budget/net-available-45b.ts", // einziger DB-Reader, der sie füttert.
  ]);

  // Aufruf der pure §45b-Mathe (Name gefolgt von `(`). Der reine Import
  // (`{ computeNetAvailable45b }`) hat kein `(` und triggert nicht.
  const computeCallRe = /computeNetAvailable45b\s*\(/;

  it("§45b-Schluss-Arithmetik nur über die pure SSoT `computeNetAvailable45b` (Task #1348)", () => {
    const hits = collectProductionCallSites(computeCallRe);
    const unexpected = [...hits].filter((f) => !ALLOWLIST_COMPUTE_45B.has(f)).sort();
    const stale = [...ALLOWLIST_COMPUTE_45B].filter((f) => !hits.has(f)).sort();

    if (unexpected.length > 0) {
      expect.fail(
        `Folgende Dateien rollen §45b-Verfügbarkeits-Mathe über ` +
          `\`computeNetAvailable45b\` selbst aus, sind aber kein sanktionierter ` +
          `Aufrufer:\n` +
          unexpected.map((f) => `  ${f}`).join("\n") +
          `\n\nKontext: Die §45b-Schluss-Arithmetik (Floor + Holds-Kontext) gibt es ` +
          `nur EINMAL. Lies Verfügbarkeit über \`netAvailable45bAt\` / ` +
          `\`readUnifiedBudgetAvailability\` statt \`allocated − consumed\` neu zu ` +
          `rechnen. Ist die Datei ein bewusst neuer Aufrufer, dokumentiere sie hier ` +
          `UND in docs/architecture/budget.md.`,
      );
    }
    if (stale.length > 0) {
      expect.fail(
        `Folgende Dateien stehen in der §45b-Mathe-Allowlist, rufen aber ` +
          `\`computeNetAvailable45b\` nicht mehr auf:\n` +
          stale.map((f) => `  ${f}`).join("\n") +
          `\n\nEntferne den veralteten Eintrag aus \`ALLOWLIST_COMPUTE_45B\`.`,
      );
    }
  });

  it("Detektoren matchen Aufrufe (positiv) und ignorieren Importe/Fremd-Pötte (negativ)", () => {
    // Positiv: ein echter Aufruf der §45b-SSoT-Mathe / des Readers wird erkannt.
    expect(computeCallRe.test("const r = computeNetAvailable45b({ allocatedCents: a });")).toBe(true);
    expect(/netAvailable45bAt\s*\(/.test("await netAvailable45bAt(id, d, { holds: 'ignore' });")).toBe(true);

    // Negativ: reiner Import zählt NICHT (kein `(`).
    expect(computeCallRe.test("import { computeNetAvailable45b } from '@shared/domain/budget/net-available-45b';")).toBe(false);
    // Negativ: andere Töpfe (§45a/§39) sind eigene Mathe und dürfen NICHT matchen.
    expect(computeCallRe.test("const r = computeNetAvailable45a({ allocatedCents: a });")).toBe(false);
    expect(/netAvailable45bAt\s*\(/.test("computeCapSlot(input).netUsedInWindowCents;")).toBe(false);
  });
});
