/**
 * VERTRAGSTEST — die reine Funktion gegen die bekannten Antworten.
 *
 * Der Vertrag (`server/scripts/lib/__fixtures__/45b-halfyear-cases.ts`) ist an
 * der Naht formuliert, an der die Fehler tatsächlich entstanden: roher
 * Datenzustand rein, fachlich korrekte Antwort raus. Die frühere
 * Golden-Case-Datei reichte der Arithmetik bereits bereinigte Zahlen hinein und
 * konnte deshalb keinen der gemessenen Blocker fangen.
 *
 * Jeder Fall nennt in `guards`, welchen Blocker er verriegelt.
 *
 * Uhr eingefroren auf den Stichtag des Vertrags — ohne das wandern die
 * Zieljahres-Erwartungen mit dem Kalender.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { freezeTime } from "../helpers/frozen-clock";
import {
  HALFYEAR_CASES, SPLIT_CASES, AS_OF,
} from "../../server/scripts/lib/__fixtures__/45b-halfyear-cases";
import {
  evaluate45bHalfYear, splitShortfall, netConsumptionFromRows,
} from "../../server/scripts/lib/45b-halfyear-math";

beforeEach(() => {
  // `thawTime()` erledigt der globale afterEach in `tests/setup.ts`.
  freezeTime(`${AS_OF}T12:00:00`);
});

describe("§45b-Halbjahres-Vertrag — reine Funktion gegen bekannte Antworten", () => {
  for (const c of HALFYEAR_CASES) {
    it(`${c.id} — ${c.guards}`, () => {
      const r = evaluate45bHalfYear({
        asOfIso: c.input.asOfIso,
        sourceYear: c.input.sourceYear,
        pgStartIso: c.input.pgStartIso,
        settings: c.input.settings,
        allocations: c.input.allocations,
        transactions: c.input.transactions,
      });

      if (c.expected.notEvaluable) {
        expect(r.notEvaluable, `${c.id}: darf nicht bewertet werden`).toBe(true);
      }
      if (c.expected.ineligible) {
        expect(r.ineligible, `${c.id}: Eligibility-Gate muss greifen`).toBe(true);
      }
      expect({ id: c.id, wert: r.sourceYearEntitlementCents })
        .toEqual({ id: c.id, wert: c.expected.sourceYearEntitlementCents });
      expect({ id: c.id, wert: r.carryoverOutSollCents })
        .toEqual({ id: c.id, wert: c.expected.carryoverOutSollCents });
      expect({ id: c.id, wert: r.phantomCents })
        .toEqual({ id: c.id, wert: c.expected.phantomCents });
      expect({ id: c.id, wert: r.shortfallCents })
        .toEqual({ id: c.id, wert: c.expected.shortfallCents });
    });
  }

  it("deckt alle Vertragsfälle ab (Selbsttest gegen stilles Schrumpfen)", () => {
    // Reihenfolge-unabhaengig: der Test soll stilles SCHRUMPFEN fangen, nicht
    // die Deklarationsreihenfolge festschreiben.
    expect([...HALFYEAR_CASES.map(c => c.id)].sort())
      .toEqual(["C1", "C11", "C12", "C13", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);
  });
});

describe("§45b-Split-Vertrag — gestellt vs. Entwurf", () => {
  for (const c of SPLIT_CASES) {
    it(`${c.id} — ${c.guards}`, () => {
      const r = splitShortfall(c.rows, c.shortfallCents, new Set(c.issuedAppointmentIds), c.cutoffIso);
      expect({ id: c.id, ...r }).toEqual({ id: c.id, ...c.expected });
    });
  }
});

describe("netConsumptionFromRows — die Naht, an der B2/B3 saßen", () => {
  const rows = [
    { date: "2025-03-01", type: "consumption" as const, amountCents: -50000 },
    { date: "2025-07-01", type: "write_off" as const, amountCents: -20000 },
    { date: "2025-09-01", type: "consumption" as const, amountCents: -30000 },
    { date: "2025-09-02", type: "reversal" as const, amountCents: 10000 },
  ];

  it("write_off zählt NICHT mit", () => {
    // Ohne den Filter wären es 70000 — genau die Aufblähung, die 25 % zu viel
    // Storno erzeugte.
    expect(netConsumptionFromRows(rows, "2025-01-01", "2025-12-31")).toBe(70000);
    expect(netConsumptionFromRows(rows, "2025-01-01", "2025-12-31")).not.toBe(90000);
  });

  it("reversal wird abgezogen", () => {
    expect(netConsumptionFromRows(rows, "2025-09-01", "2025-12-31")).toBe(20000);
  });

  it("Fenstergrenzen sind inklusiv", () => {
    expect(netConsumptionFromRows(rows, "2025-03-01", "2025-03-01")).toBe(50000);
    expect(netConsumptionFromRows(rows, "2025-03-02", "2025-08-31")).toBe(0);
  });

  it("wird nie negativ", () => {
    expect(netConsumptionFromRows(
      [{ date: "2025-01-01", type: "reversal", amountCents: 5000 }], "2025-01-01", "2025-12-31",
    )).toBe(0);
  });
});
