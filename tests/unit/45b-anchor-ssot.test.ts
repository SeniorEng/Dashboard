import { describe, it, expect } from "vitest";
import {
  resolve45bAnchor,
  initialBalanceMonthKeys,
  effective45bSettingsWindow,
  shiftStartToSettings,
  clampEndToSettings,
} from "@shared/domain/budget/anchor-45b";

/**
 * Task #1907 — die §45b-Anker-SSoT selbst.
 *
 * Diese Datei existiert, weil die Extraktion aus `calculateAllocated45b`
 * (`server/storage/budget/allocation-storage.ts`) sonst KEINE direkte
 * Absicherung hätte: die vorhandenen Tests der Halbjahres-Werkzeuge unter
 * `server/scripts/` prüfen das Werkzeug, nicht die extrahierten Symbole — und
 * jene Dateien werden nach der One-off-Disziplin (CLAUDE.md) wieder gelöscht.
 * Mit ihnen verschwände die einzige Ausübung dieser fünf Funktionen.
 *
 * Geprüft werden die Eigenschaften, an denen die Extraktion hätte kippen
 * können: Reihenfolge der Anker-Kette, das Eligibility-Gate, die
 * Fenster-Aggregation über MEHRERE Phasen-Zeilen und die Grenzverschiebung.
 * Es sind bewusst Verhaltens-Tests, keine Nachzeichnung der Implementierung.
 */

const noFloor = (iso: string) => iso;

function anchorInput(over: Partial<Parameters<typeof resolve45bAnchor>[0]> = {}) {
  return {
    pgStartIso: null,
    s45bEnabled: false,
    activeAllocations: [],
    deletedInitialBalanceValidFroms: [],
    fallbackYear: 2026,
    floorPgAnchor: noFloor,
    ...over,
  };
}

describe("resolve45bAnchor — Reihenfolge der Kette", () => {
  it("Stufe 1: Pflegegrad gewinnt, aber NUR mit aktiviertem §45b (Task #724)", () => {
    expect(
      resolve45bAnchor(anchorInput({ pgStartIso: "2024-03-01", s45bEnabled: true })),
    ).toEqual({ kind: "anchor", anchorIso: "2024-03-01", via: "pflegegrad" });

    // Ohne §45b-Einrichtung darf der Pflegegrad KEINEN Topf aufmachen —
    // sonst entsteht der Phantom-Topf aus #724.
    expect(
      resolve45bAnchor(anchorInput({ pgStartIso: "2024-03-01", s45bEnabled: false })),
    ).toEqual({ kind: "ineligible" });
  });

  it("Stufe 2 vor Stufe 3: initial_balance schlägt carryover", () => {
    const r = resolve45bAnchor(anchorInput({
      activeAllocations: [
        { source: "carryover", validFrom: "2023-01-01" },
        { source: "initial_balance", validFrom: "2025-06-01" },
      ],
    }));
    // Trotz FRÜHEREM carryover-Datum: die Stufe entscheidet, nicht das Datum.
    expect(r).toEqual({ kind: "anchor", anchorIso: "2025-06-01", via: "initial_balance" });
  });

  it("innerhalb einer Stufe gewinnt das FRÜHESTE validFrom", () => {
    const r = resolve45bAnchor(anchorInput({
      activeAllocations: [
        { source: "carryover", validFrom: "2025-05-01" },
        { source: "carryover", validFrom: "2024-02-01" },
        { source: "carryover", validFrom: null },
      ],
    }));
    expect(r).toEqual({ kind: "anchor", anchorIso: "2024-02-01", via: "carryover" });
  });

  it("Stufen 2–4 ankern UNABHÄNGIG vom Eligibility-Gate", () => {
    // Echte persistierte Mittel belegen den Anspruch für sich — auch ohne
    // aktivierte §45b-Zeile.
    const r = resolve45bAnchor(anchorInput({
      s45bEnabled: false,
      activeAllocations: [{ source: "initial_balance", validFrom: "2025-01-01" }],
    }));
    expect(r).toEqual({ kind: "anchor", anchorIso: "2025-01-01", via: "initial_balance" });
  });

  it("Stufe 4: soft-gelöschter Startwert hält den Anker (Task #1262)", () => {
    // Ohne diese Stufe verlöre die Allocation nach dem Soft-Delete ihren Anker
    // und die Monatsaufstockung wäre DAUERHAFT blockiert.
    const r = resolve45bAnchor(anchorInput({
      s45bEnabled: false,
      deletedInitialBalanceValidFroms: ["2025-09-01", "2024-11-01"],
    }));
    expect(r).toEqual({
      kind: "anchor",
      anchorIso: "2024-11-01",
      via: "deleted_initial_balance",
    });
  });

  it("Stufe 5: ohne alles → ineligible, mit aktiviertem §45b → Jahresanfang", () => {
    expect(resolve45bAnchor(anchorInput())).toEqual({ kind: "ineligible" });
    expect(resolve45bAnchor(anchorInput({ s45bEnabled: true }))).toEqual({
      kind: "anchor",
      anchorIso: "2026-01-01",
      via: "jahresanfang",
    });
  });

  it("floorPgAnchor wird angewandt (Produktionspfad bodet auf das laufende Jahr)", () => {
    const r = resolve45bAnchor(anchorInput({
      pgStartIso: "2019-04-01",
      s45bEnabled: true,
      floorPgAnchor: () => "2026-01-01",
    }));
    expect(r).toEqual({ kind: "anchor", anchorIso: "2026-01-01", via: "pflegegrad" });
  });

  it("liest KEINE Uhr — gleiche Eingabe, gleiches Ergebnis", () => {
    // Die `todayISO()`-vs-`asOf`-Falle (CLAUDE.md) kann hier nicht entstehen:
    // Stichtag und Fallback-Jahr sind Parameter.
    const input = anchorInput({ s45bEnabled: true, fallbackYear: 2019 });
    expect(resolve45bAnchor(input)).toEqual(resolve45bAnchor(input));
    expect(resolve45bAnchor(input)).toEqual({
      kind: "anchor",
      anchorIso: "2019-01-01",
      via: "jahresanfang",
    });
  });
});

describe("initialBalanceMonthKeys — Skip-Set der Monatsaufstockung", () => {
  it("nimmt nur monats-gebundene initial_balance-Zeilen auf", () => {
    const keys = initialBalanceMonthKeys([
      { source: "initial_balance", year: 2026, month: 3 },
      { source: "initial_balance", year: 2026, month: null }, // Jahres-Zeile
      { source: "carryover", year: 2026, month: 4 },
      { source: "monthly", year: 2026, month: 5 },
    ]);
    expect([...keys]).toEqual(["2026-3"]);
  });
});

describe("effective45bSettingsWindow — über ALLE Phasen, nicht nur die aktive", () => {
  it("validFrom = die FRÜHESTE über alle Zeilen", () => {
    // Der Repro-Fall: die zuletzt wirksame Zeile beginnt im Mai; nähme man sie,
    // fielen Jan–Apr aus der Iteration.
    const w = effective45bSettingsWindow([
      { validFrom: "2026-05-01", validTo: null },
      { validFrom: "2026-01-01", validTo: "2026-04-30" },
    ]);
    expect(w.validFrom).toBe("2026-01-01");
  });

  it("eine offene Zeile hebt JEDE Begrenzung auf", () => {
    const w = effective45bSettingsWindow([
      { validFrom: "2026-01-01", validTo: "2026-06-30" },
      { validFrom: "2026-07-01", validTo: null },
    ]);
    expect(w.validTo).toBeNull();
  });

  it("ohne offene Zeile: validTo = das SPÄTESTE", () => {
    const w = effective45bSettingsWindow([
      { validFrom: "2026-01-01", validTo: "2026-06-30" },
      { validFrom: "2026-07-01", validTo: "2026-09-30" },
    ]);
    expect(w).toEqual({ validFrom: "2026-01-01", validTo: "2026-09-30" });
  });

  it("leere Zeilenmenge fällt auf das Bestandsverhalten zurück", () => {
    expect(effective45bSettingsWindow([], { validFrom: "2025-02-01", validTo: null }))
      .toEqual({ validFrom: "2025-02-01", validTo: null });
    expect(effective45bSettingsWindow([], null))
      .toEqual({ validFrom: null, validTo: null });
  });

  it("Zeilen ohne validFrom ziehen das Fenster nicht auf null", () => {
    const w = effective45bSettingsWindow([
      { validFrom: null, validTo: "2026-12-31" },
      { validFrom: "2026-03-01", validTo: "2026-12-31" },
    ]);
    expect(w.validFrom).toBe("2026-03-01");
  });
});

describe("shiftStartToSettings / clampEndToSettings — Grenzverschiebung", () => {
  it("Start wandert nach hinten, nie nach vorn", () => {
    expect(shiftStartToSettings({ year: 2026, month: 1 }, "2026-05-01"))
      .toEqual({ year: 2026, month: 5 });
    // Frühere Einrichtung darf den Start NICHT vorziehen.
    expect(shiftStartToSettings({ year: 2026, month: 5 }, "2026-01-01"))
      .toEqual({ year: 2026, month: 5 });
    expect(shiftStartToSettings({ year: 2026, month: 5 }, null))
      .toEqual({ year: 2026, month: 5 });
  });

  it("Ende wandert nach vorn, nie nach hinten", () => {
    expect(clampEndToSettings({ year: 2026, month: 12 }, "2026-08-31"))
      .toEqual({ year: 2026, month: 8 });
    expect(clampEndToSettings({ year: 2026, month: 6 }, "2026-12-31"))
      .toEqual({ year: 2026, month: 6 });
    expect(clampEndToSettings({ year: 2026, month: 6 }, null))
      .toEqual({ year: 2026, month: 6 });
  });

  it("Jahresgrenze wird korrekt verglichen (nicht nur der Monat)", () => {
    expect(shiftStartToSettings({ year: 2026, month: 11 }, "2027-02-01"))
      .toEqual({ year: 2027, month: 2 });
    expect(clampEndToSettings({ year: 2027, month: 2 }, "2026-11-30"))
      .toEqual({ year: 2026, month: 11 });
  });
});
