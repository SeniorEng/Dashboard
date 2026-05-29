/**
 * Task #819 — Architektur-Test: KEINE rohe `Number(...)`-Konvertierung von
 * Excel-Zellwerten im Import-Pfad.
 *
 * Hintergrund: `Number("10,9")` ergibt `NaN` (→ via `|| 0` still `0`), weil das
 * deutsche Dezimal-Komma kein gültiger JS-Number-Separator ist. Wenn ExcelJS
 * eine Zelle als Text (statt als echte Zahl) liefert, rundete der alte Import
 * dadurch ALLE Nachkommastellen still auf 0 — eine GoBD-widrige stille
 * Datenverfälschung. Dezimal-Spalten (km + Stunden) MÜSSEN über
 * `parseGermanDecimal` (`@shared/utils/parse-german-decimal`) laufen.
 *
 * Dieser Test scannt `server/services/appointment-import.ts` per AST nach
 * `Number(...)`-Aufrufen, deren Argument einen Zell-Subscript (`row[...]`)
 * referenziert, und failt mit klarer Meldung.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSource } from "./ast-grep-helpers";

const IMPORT_FILE = join(process.cwd(), "server/services/appointment-import.ts");

describe("Architektur: kein rohes Number(cell) im Import-Pfad (Task #819)", () => {
  it("findet keine Number(row[...])-Konvertierungen", () => {
    const src = readFileSync(IMPORT_FILE, "utf8");
    const root = parseSource(src, false);

    const offenders: string[] = [];
    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
      const fn = call.field("function");
      if (!fn || fn.text() !== "Number") continue;
      const args = call.field("arguments");
      if (!args) continue;
      const argText = args.text();
      // Nur Zell-Konvertierungen sind verboten — `Number(someScalar)` mit einem
      // bereits geparsten Wert ist erlaubt. Heuristik: Argument referenziert
      // einen Spalten-Subscript der Excel-Zeile.
      if (/row\s*\[/.test(argText) || /\bcell\b/.test(argText)) {
        offenders.push(
          `Zeile ${call.range().start.line + 1}: Number(${argText}) — ` +
            `bitte parseGermanDecimal(...) verwenden`,
        );
      }
    }

    expect(
      offenders,
      `Rohe Number()-Zellkonvertierung im Import-Pfad gefunden:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
