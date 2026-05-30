/**
 * Task #840 — Architektur-Test: jeder Startup-Step in `runStartupTasks` ist
 * einzeln fault-isoliert (eigener try/catch), nicht nur vom äußeren try/catch
 * umschlossen.
 *
 * Hintergrund: `runStartupTasks` (`server/index.ts`) reiht ~50 sequentielle
 * Migrations-/Seed-Schritte aneinander. Liegt ein Schritt-Aufruf NUR im
 * äußeren try/catch, bricht eine einzige Exception die GANZE Restkette ab —
 * der Server bootet trotzdem und bedient gegen ein halb-migriertes Schema.
 * Vier Schritte waren historisch nicht einzeln gewrappt:
 *   - serviceCatalogStorage.ensureSystemServices()
 *   - documentStorage.ensureCustomerDocumentTypes()
 *   - dropAppointmentsServiceTypeColumn()
 *   - importPflegekassen()
 *
 * Dieser Test scannt den Quellcode und verlangt, dass jeder dieser Aufrufe
 * direkt von einem `try {` eröffnet wird (erste Anweisung im try-Block, kein
 * dazwischenliegender Klammer-Block). Schlägt fehl, sobald jemand einen der
 * Aufrufe wieder "schnell mal" aus seinem try/catch zieht.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const INDEX_TS = join(process.cwd(), "server", "index.ts");

/** Schritt-Aufrufe, die einzeln (eigener try/catch) abgesichert sein MÜSSEN. */
const GUARDED_STEP_CALLS = [
  "await serviceCatalogStorage.ensureSystemServices()",
  "await documentStorage.ensureCustomerDocumentTypes()",
  "await dropAppointmentsServiceTypeColumn()",
  "await importPflegekassen()",
] as const;

function extractRunStartupTasksBody(src: string): string {
  const marker = "async function runStartupTasks()";
  const start = src.indexOf(marker);
  expect(start, `${marker} nicht in server/index.ts gefunden`).toBeGreaterThanOrEqual(0);
  const braceOpen = src.indexOf("{", start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(braceOpen + 1, i);
    }
  }
  throw new Error("Konnte den Funktionskörper von runStartupTasks nicht abgrenzen");
}

describe("Architektur: Startup-Steps einzeln fault-isoliert (Task #840)", () => {
  const body = extractRunStartupTasksBody(readFileSync(INDEX_TS, "utf8"));

  for (const call of GUARDED_STEP_CALLS) {
    it(`\`${call}\` liegt direkt in einem eigenen try-Block`, () => {
      const idx = body.indexOf(call);
      expect(idx, `Aufruf \`${call}\` nicht mehr in runStartupTasks gefunden`).toBeGreaterThanOrEqual(0);
      const before = body.slice(0, idx);
      // Direkt vor dem Aufruf muss ein `try {` stehen (nur Whitespace dazwischen),
      // d.h. der Aufruf ist die erste Anweisung im try-Block.
      expect(
        /\btry\s*\{\s*$/.test(before),
        `\`${call}\` ist NICHT von einem eigenen \`try {\` eröffnet — ` +
          "ein Fehler in diesem Schritt würde die restliche Startup-Kette abbrechen. " +
          "Bitte den Aufruf wie die übrigen Schritte in try/catch (log + continue) wrappen.",
      ).toBe(true);

      // Und der Block muss mit einem `catch` abgeschlossen sein.
      const after = body.slice(idx + call.length);
      expect(
        /^\s*;?\s*\}\s*catch\b/.test(after),
        `\`${call}\` hat keinen unmittelbaren \`} catch\`-Abschluss — ` +
          "der Fehler würde nicht lokal behandelt.",
      ).toBe(true);
    });
  }
});
