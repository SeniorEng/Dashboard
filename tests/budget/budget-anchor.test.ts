/**
 * Task #1192 — Unit-Tests für die SSoT-Funktion `resolveBudgetAnchor`.
 *
 * Reine Logik, kein Server/DB — läuft im `unit`-Project.
 */
import { describe, expect, it } from "vitest";
import { resolveBudgetAnchor } from "@shared/domain/budget/budget-anchor";

const TODAY = "2026-06-11";
const JAN1 = "2026-01-01";

describe("resolveBudgetAnchor (R1–R3)", () => {
  it("R3: leere Historie → null", () => {
    expect(resolveBudgetAnchor([], TODAY)).toBeNull();
  });

  it("R3: nur Zeilen ohne validFrom → null", () => {
    expect(resolveBudgetAnchor([{ validFrom: null }, { validFrom: undefined }], TODAY)).toBeNull();
  });

  it("R1: Pflegegrad-Beginn im laufenden Jahr → exakt dieser Beginn", () => {
    expect(resolveBudgetAnchor([{ validFrom: "2026-03-01" }], TODAY)).toBe("2026-03-01");
  });

  it("R1: Pflegegrad-Beginn am 01.01. lfd. Jahr → 01.01.", () => {
    expect(resolveBudgetAnchor([{ validFrom: JAN1 }], TODAY)).toBe(JAN1);
  });

  it("R1: Pflegegrad-Beginn im Vorjahr → auf 01.01. lfd. Jahr gekappt", () => {
    expect(resolveBudgetAnchor([{ validFrom: "2025-04-01" }], TODAY)).toBe(JAN1);
  });

  it("R1: Pflegegrad-Beginn vor mehreren Jahren → auf 01.01. lfd. Jahr gekappt", () => {
    expect(resolveBudgetAnchor([{ validFrom: "2019-12-31" }], TODAY)).toBe(JAN1);
  });

  it("R2: mehrere Phasen → frühester Beginn gewinnt (PG-Wechsel verschiebt nicht)", () => {
    const history = [
      { validFrom: "2026-09-01" },
      { validFrom: "2026-02-01" },
      { validFrom: "2026-05-01" },
    ];
    expect(resolveBudgetAnchor(history, TODAY)).toBe("2026-02-01");
  });

  it("R2: frühester Beginn im Vorjahr, spätere Phase im lfd. Jahr → 01.01. lfd. Jahr", () => {
    const history = [
      { validFrom: "2025-06-01" },
      { validFrom: "2026-03-01" },
    ];
    expect(resolveBudgetAnchor(history, TODAY)).toBe(JAN1);
  });

  it("reihenfolge-unabhängig (auf-/absteigend identisch)", () => {
    const asc = [{ validFrom: "2026-02-01" }, { validFrom: "2026-08-01" }];
    const desc = [{ validFrom: "2026-08-01" }, { validFrom: "2026-02-01" }];
    expect(resolveBudgetAnchor(asc, TODAY)).toBe(resolveBudgetAnchor(desc, TODAY));
  });

  it("Floor nutzt das Jahr aus `today`, nicht die Systemuhr", () => {
    expect(resolveBudgetAnchor([{ validFrom: "2024-01-01" }], "2027-06-11")).toBe("2027-01-01");
  });
});
