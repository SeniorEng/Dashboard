import { describe, it, expect } from "vitest";
import {
  isPflegekasseCustomer,
  needsVorerkrankungenData,
  needsBudgetData,
  getVisibleTabs,
  getEffectiveTab,
  displayPriceCents,
  netFromInputCents,
  CUSTOMER_DETAIL_TABS,
  SELBSTZAHLER_HIDDEN_TABS,
  type BillingType,
} from "@shared/domain/customers";

describe("Selbstzahler UI-Logik", () => {

  describe("Tab-Filterung (getVisibleTabs)", () => {
    it("zeigt alle Tabs für pflegekasse_gesetzlich", () => {
      const tabs = getVisibleTabs("pflegekasse_gesetzlich");
      expect(tabs).toEqual(CUSTOMER_DETAIL_TABS);
      expect(tabs).toContain("budgets");
      expect(tabs).toContain("insurance");
    });

    it("zeigt alle Tabs für pflegekasse_privat", () => {
      const tabs = getVisibleTabs("pflegekasse_privat");
      expect(tabs).toEqual(CUSTOMER_DETAIL_TABS);
      expect(tabs).toContain("budgets");
      expect(tabs).toContain("insurance");
    });

    it("blendet Budgets und Versicherung für Selbstzahler aus", () => {
      const tabs = getVisibleTabs("selbstzahler");
      expect(tabs).not.toContain("budgets");
      expect(tabs).not.toContain("insurance");
    });

    it("behält alle anderen Tabs für Selbstzahler", () => {
      const tabs = getVisibleTabs("selbstzahler");
      expect(tabs).toContain("overview");
      expect(tabs).toContain("vertrag");
      expect(tabs).toContain("documents");
      expect(tabs).toContain("contacts");
      expect(tabs).toContain("timeline");
    });

    it("zeigt alle Tabs wenn billingType null oder undefined ist", () => {
      expect(getVisibleTabs(null)).toEqual(CUSTOMER_DETAIL_TABS);
      expect(getVisibleTabs(undefined)).toEqual(CUSTOMER_DETAIL_TABS);
    });

    it("SELBSTZAHLER_HIDDEN_TABS enthält genau budgets und insurance", () => {
      expect(SELBSTZAHLER_HIDDEN_TABS).toEqual(["budgets", "insurance"]);
    });
  });

  describe("Effektiver Tab (getEffectiveTab)", () => {
    it("leitet von budgets auf overview um für Selbstzahler", () => {
      expect(getEffectiveTab("budgets", "selbstzahler")).toBe("overview");
    });

    it("leitet von insurance auf overview um für Selbstzahler", () => {
      expect(getEffectiveTab("insurance", "selbstzahler")).toBe("overview");
    });

    it("behält overview für Selbstzahler", () => {
      expect(getEffectiveTab("overview", "selbstzahler")).toBe("overview");
    });

    it("behält contacts für Selbstzahler", () => {
      expect(getEffectiveTab("contacts", "selbstzahler")).toBe("contacts");
    });

    it("behält timeline für Selbstzahler", () => {
      expect(getEffectiveTab("timeline", "selbstzahler")).toBe("timeline");
    });

    it("erlaubt budgets für Pflegekasse-Kunden", () => {
      expect(getEffectiveTab("budgets", "pflegekasse_gesetzlich")).toBe("budgets");
      expect(getEffectiveTab("budgets", "pflegekasse_privat")).toBe("budgets");
    });

    it("erlaubt insurance für Pflegekasse-Kunden", () => {
      expect(getEffectiveTab("insurance", "pflegekasse_gesetzlich")).toBe("insurance");
      expect(getEffectiveTab("insurance", "pflegekasse_privat")).toBe("insurance");
    });

    it("erlaubt alle Tabs wenn billingType null/undefined", () => {
      expect(getEffectiveTab("budgets", null)).toBe("budgets");
      expect(getEffectiveTab("insurance", undefined)).toBe("insurance");
    });
  });

  describe("Pflegegrad-Anzeige (isPflegekasseCustomer)", () => {
    it("gibt true für pflegekasse_gesetzlich", () => {
      expect(isPflegekasseCustomer("pflegekasse_gesetzlich")).toBe(true);
    });

    it("gibt true für pflegekasse_privat", () => {
      expect(isPflegekasseCustomer("pflegekasse_privat")).toBe(true);
    });

    it("gibt false für selbstzahler (Pflegegrad-Badge wird ausgeblendet)", () => {
      expect(isPflegekasseCustomer("selbstzahler")).toBe(false);
    });

    it("gibt false für leeren String", () => {
      expect(isPflegekasseCustomer("")).toBe(false);
    });
  });

  describe("Brutto-Preisanzeige (displayPriceCents)", () => {
    it("wendet 1.19x Multiplikator für Selbstzahler an", () => {
      expect(displayPriceCents(1000, "selbstzahler")).toBe(1190);
    });

    it("rundet korrekt bei nicht-glatten Beträgen", () => {
      expect(displayPriceCents(3333, "selbstzahler")).toBe(Math.round(3333 * 1.19));
      expect(displayPriceCents(3333, "selbstzahler")).toBe(3966);
    });

    it("gibt Netto-Preis unverändert für Pflegekasse zurück", () => {
      expect(displayPriceCents(1000, "pflegekasse_gesetzlich")).toBe(1000);
      expect(displayPriceCents(1000, "pflegekasse_privat")).toBe(1000);
    });

    it("gibt Netto-Preis unverändert für null/undefined zurück", () => {
      expect(displayPriceCents(1000, null)).toBe(1000);
      expect(displayPriceCents(1000, undefined)).toBe(1000);
    });

    it("behandelt Null-Cent korrekt", () => {
      expect(displayPriceCents(0, "selbstzahler")).toBe(0);
      expect(displayPriceCents(0, "pflegekasse_gesetzlich")).toBe(0);
    });

    it("behandelt typische Stundensätze korrekt", () => {
      expect(displayPriceCents(3500, "selbstzahler")).toBe(4165);
      expect(displayPriceCents(3500, "pflegekasse_gesetzlich")).toBe(3500);
    });
  });

  describe("Netto-Rückrechnung (netFromInputCents)", () => {
    it("rechnet Brutto-Eingabe für Selbstzahler in Netto um", () => {
      expect(netFromInputCents(1190, "selbstzahler")).toBe(1000);
    });

    it("rundet korrekt bei Rückrechnung", () => {
      expect(netFromInputCents(3966, "selbstzahler")).toBe(Math.round(3966 / 1.19));
    });

    it("gibt Eingabe unverändert für Pflegekasse zurück", () => {
      expect(netFromInputCents(1000, "pflegekasse_gesetzlich")).toBe(1000);
      expect(netFromInputCents(1000, "pflegekasse_privat")).toBe(1000);
    });

    it("Roundtrip: displayPrice → netFromInput ergibt Originalwert", () => {
      const original = 2750;
      const brutto = displayPriceCents(original, "selbstzahler");
      const back = netFromInputCents(brutto, "selbstzahler");
      expect(back).toBe(original);
    });

    it("Roundtrip für Pflegekasse ist identisch", () => {
      const original = 2750;
      const display = displayPriceCents(original, "pflegekasse_gesetzlich");
      const back = netFromInputCents(display, "pflegekasse_gesetzlich");
      expect(back).toBe(original);
    });
  });

  describe("Vorerkrankungen im Wizard (needsVorerkrankungenData)", () => {
    it("gibt true für Selbstzahler", () => {
      expect(needsVorerkrankungenData("selbstzahler")).toBe(true);
    });

    it("gibt true für pflegekasse_gesetzlich", () => {
      expect(needsVorerkrankungenData("pflegekasse_gesetzlich")).toBe(true);
    });

    it("gibt true für pflegekasse_privat", () => {
      expect(needsVorerkrankungenData("pflegekasse_privat")).toBe(true);
    });

    it("gibt false für leeren String", () => {
      expect(needsVorerkrankungenData("")).toBe(false);
    });
  });

  describe("Budget-Daten (needsBudgetData)", () => {
    it("gibt false für Selbstzahler", () => {
      expect(needsBudgetData("selbstzahler")).toBe(false);
    });

    it("gibt true für pflegekasse_gesetzlich", () => {
      expect(needsBudgetData("pflegekasse_gesetzlich")).toBe(true);
    });

    it("gibt true für pflegekasse_privat", () => {
      expect(needsBudgetData("pflegekasse_privat")).toBe(true);
    });
  });

  describe("Konsistenz zwischen Tab-Filterung und Budget-Daten", () => {
    const billingTypes: BillingType[] = ["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"];

    it("budgets-Tab ist genau dann sichtbar, wenn Budget-Daten benötigt werden", () => {
      for (const bt of billingTypes) {
        const tabs = getVisibleTabs(bt);
        const hasBudgetTab = tabs.includes("budgets");
        const needsBudget = needsBudgetData(bt);
        expect(hasBudgetTab).toBe(needsBudget);
      }
    });

    it("insurance-Tab ist genau dann sichtbar, wenn Pflegekasse aktiv", () => {
      for (const bt of billingTypes) {
        const tabs = getVisibleTabs(bt);
        const hasInsuranceTab = tabs.includes("insurance");
        const isPflegekasse = isPflegekasseCustomer(bt);
        expect(hasInsuranceTab).toBe(isPflegekasse);
      }
    });
  });
});
