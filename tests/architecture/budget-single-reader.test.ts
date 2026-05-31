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
});
