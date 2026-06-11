import { describe, it, expect } from "vitest";
import { defaultStatutoryPotEnabled } from "@shared/domain/budget-selbstzahler-validator";

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
