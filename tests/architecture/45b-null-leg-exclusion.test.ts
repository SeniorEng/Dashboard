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
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { ssotGuardAllowlist } from "@shared/ssot-registry";

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

/**
 * Gate-2-Fund S1/S4 — die erste Fassung dieses Wächters scannte ZWEI hart
 * verdrahtete Dateien und hieß trotzdem „genau eine Quelle". Der Review fand
 * daraufhin drei weitere Kopien, zwei davon in Produktions-Services. Ein
 * Wächter, der Vollständigkeit im Titel behauptet und eine Handvoll Dateien
 * prüft, ist schlimmer als keiner: er zertifiziert etwas, das er nicht misst.
 *
 * Jetzt scannt er `server/**` + `shared/**` vollständig; die legitimen
 * Ausnahmen kommen aus der SSoT-Registry (`budget-45b-expiry`), damit sie dort
 * gepflegt werden statt hier.
 */
const FRIST_ERLAUBT = new Set<string>([
  ...ssotGuardAllowlist("budget-45b-expiry", "FRIST_LITERAL_ERLAUBT"),
  join("shared", "domain", "budget", "expiry-45b.ts"),
]);

function* durchlaufe(dir: string): Generator<string> {
  let eintraege: string[];
  try {
    eintraege = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of eintraege) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const voll = join(dir, e);
    if (statSync(voll).isDirectory()) yield* durchlaufe(voll);
    else if (/\.ts$/.test(voll)) yield voll;
  }
}

describe("§45b-Verfallsfrist — genau eine Quelle", () => {
  it("kodiert die Frist nirgends in server/** oder shared/** als Literal", () => {
    const treffer: string[] = [];
    for (const baum of ["server", "shared"]) {
      for (const datei of durchlaufe(join(process.cwd(), baum))) {
        const rel = relative(process.cwd(), datei);
        if (FRIST_ERLAUBT.has(rel)) continue;
        for (const zeile of readFileSync(datei, "utf8").split("\n")) {
          // Nur echte Code-Literale, keine Kommentare/Doku.
          const ohneKommentar = zeile.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (/-06-30`|-06-30"|-06-30'/.test(ohneKommentar)) treffer.push(`${rel}: ${zeile.trim()}`);
        }
      }
    }
    expect(
      treffer,
      "Die 30.06.-Frist steht wieder als Literal im Code. Sie gehört ausschließlich " +
        "in `shared/domain/budget/expiry-45b.ts` (`carryoverExpiresAtFor`). Legitime " +
        "Ausnahmen gehören in die SSoT-Registry unter `budget-45b-expiry`, nicht " +
        `hierher. Gefunden: ${treffer.join(" | ")}`,
    ).toEqual([]);
  });

  it("kodiert die Halbjahres-Grenze nirgends als nackte 6", () => {
    const treffer: string[] = [];
    for (const baum of ["server", "shared"]) {
      for (const datei of durchlaufe(join(process.cwd(), baum))) {
        const rel = relative(process.cwd(), datei);
        if (FRIST_ERLAUBT.has(rel)) continue;
        for (const zeile of readFileSync(datei, "utf8").split("\n")) {
          const ohneKommentar = zeile.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (/(?:cur|horizon|as[Oo]f)Month\s*<=\s*6\b/.test(ohneKommentar)) {
            treffer.push(`${rel}: ${zeile.trim()}`);
          }
        }
      }
    }
    expect(
      treffer,
      "Die Halbjahres-Grenze ist wieder als nackte `6` kodiert. Sie kommt aus " +
        `\`expiry45bFloorYearFor\` bzw. \`CARRYOVER_45B_EXPIRY_MONTH\`. Gefunden: ${treffer.join(" | ")}`,
    ).toEqual([]);
  });
});
