/**
 * Task #819 — Architektur-Test: KEINE `appointmentId: null` in Reversal-/
 * Consumption-Buchungen.
 *
 * Hintergrund: Mehrere Rebook-/Reconcile-Pfade haben Storno-Zeilen mit
 * `appointmentId: null` eingefügt und die Original-Consumption zusätzlich vom
 * Termin abgekoppelt. Das erzeugte budget_transactions-Waisen ohne Termin-
 * Bezug (GoBD-Lückenlosigkeit verletzt) und kollidiert mit der CHECK-Constraint
 * `transaction_type IN ('manual_adjustment','expiration','write_off') OR
 *  appointment_id IS NOT NULL`. Reversal-/Consumption-Inserts MÜSSEN die
 * `appointmentId` der Original-Buchung behalten.
 *
 * Dieser Test scannt `server/`-Objekt-Literale, die `transactionType:
 * "reversal"` (bzw. "consumption") setzen, und failt, wenn dieselbe Literal-
 * Form `appointmentId: null` enthält.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { parseSource, walkTsFiles, relPath } from "./ast-grep-helpers";
import { join } from "path";

const SERVER_DIR = join(process.cwd(), "server");

describe("Architektur: kein appointmentId:null in Reversal/Consumption (Task #819)", () => {
  it("findet keine appointmentId:null-Reversal/Consumption-Inserts", () => {
    const offenders: string[] = [];

    for (const file of walkTsFiles(SERVER_DIR)) {
      const src = readFileSync(file, "utf8");
      const root = parseSource(src, false);

      for (const obj of root.findAll({ rule: { kind: "object" } })) {
        const text = obj.text();
        const isReversalOrConsumption =
          /transactionType\s*:\s*["'](reversal|consumption)["']/.test(text);
        if (!isReversalOrConsumption) continue;
        if (/appointmentId\s*:\s*null\b/.test(text)) {
          offenders.push(
            `${relPath(file)}:${obj.range().start.line + 1} — ` +
              `Reversal/Consumption mit appointmentId: null`,
          );
        }
      }
    }

    expect(
      offenders,
      `appointmentId:null in Reversal/Consumption gefunden:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
