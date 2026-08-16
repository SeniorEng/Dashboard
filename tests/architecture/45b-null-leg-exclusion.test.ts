/**
 * Task #1927 — Rückfall-Wächter: die §45b-Exklusion darf nicht wieder rein
 * ID-basiert werden.
 *
 * Der Defekt, den dieser Wächter offenhält: `getExcluded45bConsumption` schloss
 * Verbrauch ausschließlich über `inArray(allocationId, excludedIds)` aus. Diese
 * Bedingung trifft `allocation_id IS NULL` per SQL-Semantik NIE — und genau
 * diese NULL-Zeile ist das Monatsaufstockungs-Leg der FIFO-Buchung
 * (`consumption-engine.ts`: was nach den Spezial-Allocations übrig bleibt, wird
 * als EINE Zeile ohne `allocation_id` gebucht).
 *
 * Wandert der Verfalls-Boden (jeden 01.07., jeden Jahreswechsel), fallen die
 * Aufstockungen der darunter liegenden Monate aus `Allocated`; ihr Verbrauch
 * blieb ohne das NULL-Glied dauerhaft abgezogen.
 *
 * Der fachliche Nachweis liegt in `tests/budget/45b-null-pfad-verfall.test.ts`
 * (gegen `main` gemessen rot: 87900 statt 91700). Dieser Wächter hier ist die
 * schnelle, DB-freie Zweitsicherung: er benennt die Regel an der Stelle, an der
 * sie steht, damit ein Umbau nicht erst im Integrationstest auffällt.
 *
 * Failure-Modus: bricht mit der verletzten Zusage. Behebung ist nie „Wächter
 * lockern", sondern das NULL-Glied wiederherstellen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const DATEI = join(process.cwd(), "server", "storage", "budget", "allocation-storage.ts");

/** Körper von `getExcluded45bConsumption` — bis zur nächsten Top-Level-Funktion. */
function exklusionsFunktion(): string {
  const quelle = readFileSync(DATEI, "utf8");
  const start = quelle.indexOf("export async function getExcluded45bConsumption");
  expect(start, "getExcluded45bConsumption nicht mehr gefunden — Wächter ins Leere gelaufen").toBeGreaterThan(-1);
  const rest = quelle.slice(start);
  const ende = rest.indexOf("\nfunction ", 1);
  return ende > 0 ? rest.slice(0, ende) : rest;
}

describe("§45b-Exklusion — das NULL-Leg bleibt abgedeckt", () => {
  it("prüft `allocation_id IS NULL` gegen einen Datums-Boden, nicht nur IDs", () => {
    const fn = exklusionsFunktion();

    expect(
      /isNull\(\s*budgetTransactions\.allocationId\s*\)/.test(fn),
      "Die Exklusion enthält keine `isNull(budgetTransactions.allocationId)`-Bedingung mehr. " +
        "Damit ist der Verbrauch gegen die virtuelle Monatsaufstockung wieder " +
        "ungreifbar: `inArray(allocationId, …)` trifft NULL nicht, und der " +
        "Verbrauch abgelaufener Monate belastet den laufenden Topf dauerhaft.",
    ).toBe(true);

    expect(
      fn.includes("accrualFloorDate"),
      "Der Aufstockungs-Boden (`accrualFloorDate`) wird nicht mehr benutzt. Er ist " +
        "die SSoT-Grenze aus `calculateAllocated45b`; ohne ihn müsste die Exklusion " +
        "sie neu ableiten — genau der Zweitbegriff, den die SSoT-Regel verbietet.",
    ).toBe(true);
  });

  it("leitet den Boden NICHT neu ab, sondern bezieht ihn aus calculateAllocated45b", () => {
    const fn = exklusionsFunktion();

    expect(
      /const\s*\{[^}]*accrualFloorDate[^}]*\}\s*=\s*await\s+calculateAllocated45b/s.test(fn),
      "`accrualFloorDate` kommt nicht mehr aus `calculateAllocated45b`. Die Grenze, " +
        "die `Allocated` bestimmt, und die Grenze, die den Verbrauch ausschließt, " +
        "müssen dieselbe sein — sonst driften Zuteilung und Abzug auseinander.",
    ).toBe(true);

    // Eine eigene Halbjahres-/Anker-Rechnung hier wäre der Rückfall in zwei
    // Wahrheiten. Die Frist gehört in `shared/domain/budget/expiry-45b.ts`.
    expect(
      /horizonMonth\s*<=\s*6|<=\s*6\s*\?/.test(fn),
      "In der Exklusion steht wieder eine eigene Halbjahres-Rechnung. Die Frist " +
        "hat genau eine Quelle: `expiry45bFloorYearFor` in " +
        "`shared/domain/budget/expiry-45b.ts`.",
    ).toBe(false);
  });
});

describe("§45b-Verfallsfrist — genau eine Quelle", () => {
  it("kodiert den 30.06. nicht mehr als Literal außerhalb der Frist-SSoT", () => {
    const treffer: string[] = [];
    for (const rel of [
      join("server", "storage", "budget", "allocation-storage.ts"),
      join("shared", "domain", "budget-carryover-dedup.ts"),
    ]) {
      const inhalt = readFileSync(join(process.cwd(), rel), "utf8");
      // Nur echte Code-Literale, keine Kommentare/Doku.
      for (const zeile of inhalt.split("\n")) {
        const ohneKommentar = zeile.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (/-06-30`|-06-30"|-06-30'/.test(ohneKommentar)) treffer.push(`${rel}: ${zeile.trim()}`);
      }
    }
    expect(
      treffer,
      "Die 30.06.-Frist steht wieder als Literal im Code. Sie gehört ausschließlich " +
        `in \`shared/domain/budget/expiry-45b.ts\`. Gefunden: ${treffer.join(" | ")}`,
    ).toEqual([]);
  });
});
