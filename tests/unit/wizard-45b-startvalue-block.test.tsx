// @vitest-environment jsdom
/**
 * Task #982 — Sicherstellen, dass die §45b-Startwert-(Restguthaben-)Grenze in
 * der Kundenanlage Nutzer auch wirklich stoppt.
 *
 * Task #979 hat die Cap-Meldung + das Block-Verhalten in den Wizard gebracht.
 * Die reinen Meldungs-Builder sind über `tests/unit/budget-carryover-
 * eligibility.test.ts` abgesichert; hier pinnen wir
 *  1. das UI-Verhalten von `BudgetsStep` (roter Cap-Hinweis +
 *     Überschreitungs-Fehler + separater Negativ-Fehler), und
 *  2. das tatsächliche "Weiter"-Blockieren über `budgetsStepErrors`
 *     (die SSoT hinter `getStepErrors("budgets")` in `use-customer-wizard.ts`).
 *
 * Ohne diese Tests könnte ein künftiger Umbau das Block-Verhalten still
 * brechen, sodass zu hohe Startguthaben doch angelegt werden.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BudgetsStep } from "@/features/customers/components/wizard/budgets-contract-step";
import { budgetsStepErrors } from "@/features/customers/components/wizard/budgets-step-validation";
import type { CustomerFormData } from "@/features/customers/components/wizard/customer-types";
import { BUDGET_TYPES } from "@shared/domain/budgets";
import { max45bStartValueExceededMessage } from "@shared/domain/budget/carryover-eligibility";

// §45b-Startwert-Cap ist date-unabhängig: er ergibt sich rein aus
// pflegegradSeit (Accrual-Anker) und Stichmonat. Anker = Stichmonat = März
// 2026 → genau 1 Monatsaufstockung = 131 € möglich.
const ANCHOR = "2026-03-01";
const STICHMONAT = "2026-03";
const CURRENT_YEAR = 2026;
const TODAY = "2026-03-15";

function makeFormData(overrides: Partial<CustomerFormData> = {}): CustomerFormData {
  return {
    billingType: "pflegekasse_gesetzlich",
    vorname: "",
    nachname: "",
    geburtsdatum: "",
    email: "",
    telefon: "",
    festnetz: "",
    strasse: "",
    nr: "",
    plz: "",
    stadt: "",
    pflegegrad: "3",
    pflegegradSeit: ANCHOR,
    primaryEmployeeId: "",
    backupEmployeeId: "",
    backupEmployeeId2: "",
    vorerkrankungen: "",
    haustierVorhanden: false,
    haustierDetails: "",
    personenbefoerderungGewuenscht: false,
    insuranceProviderId: "",
    versichertennummer: "",
    beihilfeBerechtigt: false,
    contacts: [],
    budgetTypeSettings: BUDGET_TYPES.map((bt) => ({
      budgetType: bt,
      enabled: bt === "entlastungsbetrag_45b",
      monthlyLimitCents: "",
      yearlyLimitCents: "",
    })),
    entlastungsbetrag45b: "131",
    verhinderungspflege39: "3539",
    pflegesachleistungen36: "0",
    contractDate: ANCHOR,
    contractStart: ANCHOR,
    vereinbarteLeistungen: "",
    contractHours: "0",
    contractPeriod: "weekly",
    documentDeliveryMethod: "email",
    receivesMonthlyInvoice: false,
    acceptsPrivatePayment: false,
    rechnungAnKunde: false,
    uebertrag45b: "0",
    restguthaben45bOverrideEnabled: true,
    restguthaben45bStichmonat: STICHMONAT,
    restguthaben45b: "0",
    ...overrides,
  };
}

function renderStep(formData: CustomerFormData) {
  return render(
    React.createElement(BudgetsStep, {
      formData,
      onChange: vi.fn(),
      onBudgetTypeToggle: vi.fn(),
      onBudgetTypeLimitChange: vi.fn(),
      pflegegrad: Number(formData.pflegegrad),
    }),
  );
}

afterEach(cleanup);

describe("BudgetsStep — §45b-Startwert-Cap UI (Task #982)", () => {
  it("zeigt bei Überschreitung den roten Cap-Hinweis UND den Überschreitungs-Fehler", () => {
    renderStep(makeFormData({ restguthaben45b: "200" }));

    const hint = screen.getByTestId("text-max-restguthaben-45b");
    // Roter Hinweis (text-red-600) signalisiert die Überschreitung.
    expect(hint.className).toContain("text-red-600");

    const error = screen.getByTestId("error-exceeds-cap-restguthaben-45b");
    expect(error).toBeTruthy();
    expect(error.textContent).toContain("höchstens");
  });

  it("zeigt bei gültigem Startwert KEINEN roten Hinweis und KEINEN Fehler", () => {
    renderStep(makeFormData({ restguthaben45b: "100" }));

    const hint = screen.getByTestId("text-max-restguthaben-45b");
    expect(hint.className).not.toContain("text-red-600");
    expect(screen.queryByTestId("error-exceeds-cap-restguthaben-45b")).toBeNull();
  });

  it("zeigt bei negativem Startwert den Negativ-Fehler, NICHT den Cap-Fehler", () => {
    renderStep(makeFormData({ restguthaben45b: "-5" }));

    expect(screen.getByText("Restguthaben darf nicht negativ sein")).toBeTruthy();
    expect(screen.queryByTestId("error-exceeds-cap-restguthaben-45b")).toBeNull();
  });
});

describe("budgetsStepErrors — 'Weiter' blockiert (Task #982)", () => {
  it("blockiert mit Cap-Fehlermeldung, wenn der §45b-Startwert die Grenze überschreitet", () => {
    const errors = budgetsStepErrors(
      makeFormData({ restguthaben45b: "200" }),
      CURRENT_YEAR,
      TODAY,
    );
    // 131 € Cap (1 Monat) → der zentrale Cap-Fehler MUSS das Weitergehen stoppen.
    expect(errors).toContain(max45bStartValueExceededMessage(13100));
  });

  it("blockiert NICHT, wenn der §45b-Startwert genau am Cap liegt", () => {
    const errors = budgetsStepErrors(
      makeFormData({ restguthaben45b: "131" }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors).toHaveLength(0);
  });

  it("blockiert mit Negativ-Fehler (separat vom Cap-Fehler) bei negativem Startwert", () => {
    const errors = budgetsStepErrors(
      makeFormData({ restguthaben45b: "-5" }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors).toContain("Restguthaben darf nicht negativ sein");
    expect(errors).not.toContain(max45bStartValueExceededMessage(13100));
  });

  it("validiert den §45b-Startwert nicht für Selbstzahler (kein Pflegekasse-Schritt)", () => {
    const errors = budgetsStepErrors(
      makeFormData({ billingType: "selbstzahler", restguthaben45b: "999999" }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors).toHaveLength(0);
  });
});

// Task #1168 — Der Wizard blockt §45a-/§39-§42a-Eingaben mit derselben
// Quelle wie der Server (`validate45aAmount`/`validate39_42aAmount`), aber NUR
// wenn der jeweilige Topf wirklich aktiviert ist. So darf der §39/§42a-Default
// (3.539 €) einen PG-1-Kunden nicht fälschlich am "Weiter" hindern.
function withBudgetTypes(
  enabled: Partial<Record<(typeof BUDGET_TYPES)[number], boolean>>,
) {
  return BUDGET_TYPES.map((bt) => ({
    budgetType: bt,
    enabled: enabled[bt] ?? bt === "entlastungsbetrag_45b",
    monthlyLimitCents: "",
    yearlyLimitCents: "",
  }));
}

describe("budgetsStepErrors — §45a/§39-§42a-Voraussetzungen (Task #1168)", () => {
  it("blockiert §45a über dem Pflegegrad-Maximum (PG2 → 318,40 €), wenn §45a aktiviert ist", () => {
    const errors = budgetsStepErrors(
      makeFormData({
        pflegegrad: "2",
        pflegesachleistungen36: "400",
        budgetTypeSettings: withBudgetTypes({ umwandlung_45a: true }),
      }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors.some((e) => /§45a/.test(e) && /Pflegegrad\s*2/.test(e))).toBe(true);
  });

  it("blockiert §45a NICHT, wenn der Topf deaktiviert ist (selbst bei Über-Limit-Wert)", () => {
    const errors = budgetsStepErrors(
      makeFormData({
        pflegegrad: "2",
        pflegesachleistungen36: "400",
        budgetTypeSettings: withBudgetTypes({ umwandlung_45a: false }),
      }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors.some((e) => /§45a/.test(e))).toBe(false);
  });

  it("blockiert §39/§42a bei Pflegegrad 1, wenn der Topf aktiviert ist", () => {
    const errors = budgetsStepErrors(
      makeFormData({
        pflegegrad: "1",
        verhinderungspflege39: "3539",
        budgetTypeSettings: withBudgetTypes({ ersatzpflege_39_42a: true }),
      }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors.some((e) => /§39\/§42a/.test(e) && /Pflegegrad\s*2/.test(e))).toBe(true);
  });

  it("blockiert §39/§42a über dem Jahresmaximum (3.539 €) bei PG≥2", () => {
    const errors = budgetsStepErrors(
      makeFormData({
        pflegegrad: "3",
        verhinderungspflege39: "5000",
        budgetTypeSettings: withBudgetTypes({ ersatzpflege_39_42a: true }),
      }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors.some((e) => /§39\/§42a/.test(e) && /3\.539/.test(e))).toBe(true);
  });

  it("blockiert NICHT durch den §39/§42a-Default (3.539 €) bei PG1, solange der Topf deaktiviert ist", () => {
    const errors = budgetsStepErrors(
      makeFormData({
        pflegegrad: "1",
        verhinderungspflege39: "3539",
        budgetTypeSettings: withBudgetTypes({ ersatzpflege_39_42a: false }),
      }),
      CURRENT_YEAR,
      TODAY,
    );
    expect(errors.some((e) => /§39\/§42a/.test(e))).toBe(false);
  });
});
