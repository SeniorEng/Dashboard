import { describe, it, expect } from "vitest";
import { defaultStatutoryPotEnabled } from "@shared/domain/budget-selbstzahler-validator";
import { effectiveDefaultPots } from "@shared/domain/budgets";

// BUG-19-Rest — Pure SSoT für den Lese-Default eines gesetzlichen Topfes, wenn
// KEINE persistierte type-settings-Zeile existiert. §45b ist grundsätzlich
// default-aktiv, ABER nur für anspruchsberechtigte Kunden. Selbstzahler haben
// keinen Anspruch (gleicher Gate wie auf allen Schreibpfaden,
// `validateSelbstzahlerBudget`). §45a/§39+§42a sind grundsätzlich
// default-deaktiviert.

const POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

describe("BUG-19-Rest — defaultStatutoryPotEnabled (Lese-Default SSoT)", () => {
  it("Selbstzahler: ALLE gesetzlichen Töpfe default-deaktiviert", () => {
    for (const pot of POTS) {
      expect(defaultStatutoryPotEnabled(pot, "selbstzahler")).toBe(false);
    }
  });

  it("Pflegekasse (gesetzlich): nur §45b default-aktiv, §45a/§39 deaktiviert", () => {
    expect(
      defaultStatutoryPotEnabled("entlastungsbetrag_45b", "pflegekasse_gesetzlich"),
    ).toBe(true);
    expect(
      defaultStatutoryPotEnabled("umwandlung_45a", "pflegekasse_gesetzlich"),
    ).toBe(false);
    expect(
      defaultStatutoryPotEnabled("ersatzpflege_39_42a", "pflegekasse_gesetzlich"),
    ).toBe(false);
  });

  it("Pflegekasse (privat): identisch zu gesetzlich (nur §45b aktiv)", () => {
    expect(
      defaultStatutoryPotEnabled("entlastungsbetrag_45b", "pflegekasse_privat"),
    ).toBe(true);
    expect(
      defaultStatutoryPotEnabled("umwandlung_45a", "pflegekasse_privat"),
    ).toBe(false);
    expect(
      defaultStatutoryPotEnabled("ersatzpflege_39_42a", "pflegekasse_privat"),
    ).toBe(false);
  });

  it("Fehlende/unbekannte billingType: anspruchsberechtigt (kein stiller Regress) — §45b aktiv", () => {
    for (const bt of [undefined, null, ""] as const) {
      expect(defaultStatutoryPotEnabled("entlastungsbetrag_45b", bt)).toBe(true);
    }
  });

  it("Nicht-gesetzlicher / unbekannter Topf: immer deaktiviert", () => {
    expect(
      defaultStatutoryPotEnabled("irgendein_topf", "pflegekasse_gesetzlich"),
    ).toBe(false);
    expect(defaultStatutoryPotEnabled("irgendein_topf", "selbstzahler")).toBe(
      false,
    );
  });
});

// BUG-19 (Facette A) — `effectiveDefaultPots(customer)` ist der einzige
// Einstieg für den effektiven Default eines Kunden (ersetzt die modul-private
// `DEFAULT_BUDGET_POT_ORDER`). Reihenfolge (priority) ist kunden-unabhängig;
// der `enabled`-Zustand läuft über denselben Anspruchs-Gate wie
// `defaultStatutoryPotEnabled` — KEINE zweite Prüf-Kopie.
describe("BUG-19 (Facette A) — effectiveDefaultPots (SSoT Default-Töpfe)", () => {
  it("liefert immer die drei gesetzlichen Töpfe in fester Cascade-Reihenfolge (priority 1→3)", () => {
    const pots = effectiveDefaultPots({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
    expect(pots.map((p) => p.budgetType)).toEqual([
      "entlastungsbetrag_45b",
      "umwandlung_45a",
      "ersatzpflege_39_42a",
    ]);
    expect(pots.map((p) => p.priority)).toEqual([1, 2, 3]);
  });

  it("Pflegekasse (gesetzlich): nur §45b default-aktiv, §45a/§39 deaktiviert", () => {
    const pots = effectiveDefaultPots({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
    expect(pots.find((p) => p.budgetType === "entlastungsbetrag_45b")?.enabled).toBe(true);
    expect(pots.find((p) => p.budgetType === "umwandlung_45a")?.enabled).toBe(false);
    expect(pots.find((p) => p.budgetType === "ersatzpflege_39_42a")?.enabled).toBe(false);
  });

  it("Pflegekasse (privat): identisch zu gesetzlich (nur §45b aktiv)", () => {
    const pots = effectiveDefaultPots({ billingType: "pflegekasse_privat", pflegegrad: 4 });
    expect(pots.find((p) => p.budgetType === "entlastungsbetrag_45b")?.enabled).toBe(true);
    expect(pots.find((p) => p.budgetType === "umwandlung_45a")?.enabled).toBe(false);
    expect(pots.find((p) => p.budgetType === "ersatzpflege_39_42a")?.enabled).toBe(false);
  });

  it("Selbstzahler: ALLE gesetzlichen Töpfe default-deaktiviert (kein Anspruch)", () => {
    const pots = effectiveDefaultPots({ billingType: "selbstzahler", pflegegrad: 3 });
    for (const p of pots) expect(p.enabled).toBe(false);
  });

  it("§45a/§39 bleiben auch für PG<2 default-deaktiviert (nie still aktiv)", () => {
    for (const pg of [null, undefined, 0, 1] as const) {
      const pots = effectiveDefaultPots({ billingType: "pflegekasse_gesetzlich", pflegegrad: pg });
      expect(pots.find((p) => p.budgetType === "umwandlung_45a")?.enabled).toBe(false);
      expect(pots.find((p) => p.budgetType === "ersatzpflege_39_42a")?.enabled).toBe(false);
    }
  });

  it("Fehlende/unbekannte billingType: §45b default-aktiv (kein stiller Regress)", () => {
    for (const bt of [undefined, null, ""] as const) {
      const pots = effectiveDefaultPots({ billingType: bt, pflegegrad: 3 });
      expect(pots.find((p) => p.budgetType === "entlastungsbetrag_45b")?.enabled).toBe(true);
    }
  });

  it("delegiert pro Topf an denselben Gate wie defaultStatutoryPotEnabled (keine Zweitprüfung)", () => {
    for (const billingType of ["selbstzahler", "pflegekasse_gesetzlich", "pflegekasse_privat", undefined] as const) {
      const pots = effectiveDefaultPots({ billingType, pflegegrad: 3 });
      for (const p of pots) {
        expect(p.enabled).toBe(defaultStatutoryPotEnabled(p.budgetType, billingType));
      }
    }
  });
});
