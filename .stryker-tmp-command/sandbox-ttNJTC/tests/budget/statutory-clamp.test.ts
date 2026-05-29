/**
 * Pure-Unit-Tests für die statutorischen Cap-/Validierungs-Helper in
 * `shared/domain/budgets.ts` (Task #791 — Mutation-Testing-Erweiterung).
 *
 * Diese Tests laufen OHNE DB/Server und sind Teil der Stryker-Mutation-
 * Suite. Abgedeckt:
 *   - validate45bAmount / validate45aAmount / validate39_42aAmount
 *   - get45aMaxForPflegegrad
 *   - clampToStatutoryMax (alle drei Topf-Zweige + Default)
 *
 * Schwerpunkt liegt auf den Grenzwerten (genau am Cap, ein Cent darüber,
 * negative Werte, null/undefined), damit Mutationen an den Vergleichs-
 * Operatoren (`>` → `>=`, `<` → `<=`) und den Clamp-Konstanten gefangen
 * werden.
 */
// @ts-nocheck

import { describe, it, expect } from "vitest";
import {
  validate45bAmount,
  validate45aAmount,
  validate39_42aAmount,
  get45aMaxForPflegegrad,
  clampToStatutoryMax,
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
} from "@shared/domain/budgets";

describe("validate45bAmount", () => {
  it("akzeptiert 0 und genau den Maximalwert", () => {
    expect(validate45bAmount(0)).toBeNull();
    expect(validate45bAmount(BUDGET_45B_MAX_MONTHLY_CENTS)).toBeNull();
  });

  it("lehnt einen Cent über dem Maximum ab", () => {
    expect(validate45bAmount(BUDGET_45B_MAX_MONTHLY_CENTS + 1)).toMatch(/maximal/);
  });

  it("lehnt negative Beträge ab", () => {
    expect(validate45bAmount(-1)).toBe("Betrag darf nicht negativ sein");
  });
});

describe("validate45aAmount", () => {
  it("erlaubt 0 ohne Pflegegrad, lehnt aber positiven Betrag ab", () => {
    expect(validate45aAmount(0, null)).toBeNull();
    expect(validate45aAmount(0, 1)).toBeNull();
    expect(validate45aAmount(1, null)).toMatch(/ab Pflegegrad 2/);
    expect(validate45aAmount(1, 1)).toMatch(/ab Pflegegrad 2/);
  });

  it("lehnt negative Beträge unabhängig vom Pflegegrad ab", () => {
    expect(validate45aAmount(-1, 3)).toBe("Betrag darf nicht negativ sein");
    expect(validate45aAmount(-1, null)).toBe("Betrag darf nicht negativ sein");
  });

  it("akzeptiert genau den Pflegegrad-Cap und lehnt einen Cent darüber ab", () => {
    const pg3 = BUDGET_45A_MAX_BY_PFLEGEGRAD[3];
    expect(validate45aAmount(pg3, 3)).toBeNull();
    expect(validate45aAmount(pg3 + 1, 3)).toMatch(/maximal/);
  });

  it("nutzt pflegegrad-spezifische Caps (PG2 < PG5)", () => {
    // Ein Betrag, der bei PG5 erlaubt, bei PG2 aber zu hoch ist.
    const overPg2 = BUDGET_45A_MAX_BY_PFLEGEGRAD[2] + 1;
    expect(validate45aAmount(overPg2, 2)).toMatch(/maximal/);
    expect(validate45aAmount(overPg2, 5)).toBeNull();
  });
});

describe("validate39_42aAmount", () => {
  it("akzeptiert 0 und genau das Jahresmaximum", () => {
    expect(validate39_42aAmount(0)).toBeNull();
    expect(validate39_42aAmount(BUDGET_39_42A_MAX_YEARLY_CENTS)).toBeNull();
  });

  it("lehnt einen Cent über dem Jahresmaximum ab", () => {
    expect(validate39_42aAmount(BUDGET_39_42A_MAX_YEARLY_CENTS + 1)).toMatch(/maximal/);
  });

  it("lehnt negative Beträge ab", () => {
    expect(validate39_42aAmount(-1)).toBe("Betrag darf nicht negativ sein");
  });
});

describe("get45aMaxForPflegegrad", () => {
  it("liefert 0 für null/PG1 und den Tabellenwert ab PG2", () => {
    expect(get45aMaxForPflegegrad(null)).toBe(0);
    expect(get45aMaxForPflegegrad(1)).toBe(0);
    expect(get45aMaxForPflegegrad(2)).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
    expect(get45aMaxForPflegegrad(5)).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[5]);
  });

  it("liefert 0 für einen unbekannten (zu hohen) Pflegegrad", () => {
    expect(get45aMaxForPflegegrad(6)).toBe(0);
  });
});

describe("clampToStatutoryMax — §45b", () => {
  it("klemmt monthlyLimit auf das gesetzliche Maximum, lässt yearlyLimit unangetastet", () => {
    const out = clampToStatutoryMax({
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: BUDGET_45B_MAX_MONTHLY_CENTS + 5000,
      yearlyLimitCents: 99999,
      pflegegrad: 3,
    });
    expect(out.monthlyLimitCents).toBe(BUDGET_45B_MAX_MONTHLY_CENTS);
    expect(out.yearlyLimitCents).toBe(99999);
  });

  it("lässt einen Wert unter dem Cap unverändert", () => {
    const out = clampToStatutoryMax({
      budgetType: "entlastungsbetrag_45b",
      monthlyLimitCents: 5000,
      yearlyLimitCents: null,
      pflegegrad: 3,
    });
    expect(out.monthlyLimitCents).toBe(5000);
    expect(out.yearlyLimitCents).toBeNull();
  });

  it("klemmt negative Werte auf 0 und null bleibt null", () => {
    expect(
      clampToStatutoryMax({
        budgetType: "entlastungsbetrag_45b",
        monthlyLimitCents: -100,
        yearlyLimitCents: undefined,
        pflegegrad: 3,
      }),
    ).toEqual({ monthlyLimitCents: 0, yearlyLimitCents: null });
    expect(
      clampToStatutoryMax({
        budgetType: "entlastungsbetrag_45b",
        monthlyLimitCents: null,
        yearlyLimitCents: null,
        pflegegrad: 3,
      }).monthlyLimitCents,
    ).toBeNull();
  });
});

describe("clampToStatutoryMax — §45a", () => {
  it("klemmt monthlyLimit gegen den Pflegegrad-Cap", () => {
    const pg3 = BUDGET_45A_MAX_BY_PFLEGEGRAD[3];
    const out = clampToStatutoryMax({
      budgetType: "umwandlung_45a",
      monthlyLimitCents: pg3 + 10000,
      yearlyLimitCents: null,
      pflegegrad: 3,
    });
    expect(out.monthlyLimitCents).toBe(pg3);
  });

  it("klemmt ohne Pflegegrad ≥ 2 auf 0", () => {
    expect(
      clampToStatutoryMax({
        budgetType: "umwandlung_45a",
        monthlyLimitCents: 50000,
        yearlyLimitCents: null,
        pflegegrad: 1,
      }).monthlyLimitCents,
    ).toBe(0);
    expect(
      clampToStatutoryMax({
        budgetType: "umwandlung_45a",
        monthlyLimitCents: 50000,
        yearlyLimitCents: null,
        pflegegrad: null,
      }).monthlyLimitCents,
    ).toBe(0);
  });

  it("erlaubt Werte unterhalb des Pflegegrad-Caps", () => {
    const out = clampToStatutoryMax({
      budgetType: "umwandlung_45a",
      monthlyLimitCents: 1000,
      yearlyLimitCents: null,
      pflegegrad: 5,
    });
    expect(out.monthlyLimitCents).toBe(1000);
  });
});

describe("clampToStatutoryMax — §39/§42a", () => {
  it("klemmt yearlyLimit auf das gesetzliche Jahresmaximum, monthlyLimit unangetastet", () => {
    const out = clampToStatutoryMax({
      budgetType: "ersatzpflege_39_42a",
      monthlyLimitCents: 42000,
      yearlyLimitCents: BUDGET_39_42A_MAX_YEARLY_CENTS + 50000,
      pflegegrad: null,
    });
    expect(out.yearlyLimitCents).toBe(BUDGET_39_42A_MAX_YEARLY_CENTS);
    expect(out.monthlyLimitCents).toBe(42000);
  });

  it("lässt yearlyLimit unter dem Cap unverändert und klemmt negative auf 0", () => {
    expect(
      clampToStatutoryMax({
        budgetType: "ersatzpflege_39_42a",
        monthlyLimitCents: null,
        yearlyLimitCents: 1000,
        pflegegrad: null,
      }).yearlyLimitCents,
    ).toBe(1000);
    expect(
      clampToStatutoryMax({
        budgetType: "ersatzpflege_39_42a",
        monthlyLimitCents: null,
        yearlyLimitCents: -5,
        pflegegrad: null,
      }).yearlyLimitCents,
    ).toBe(0);
  });
});

describe("clampToStatutoryMax — unbekannter Topf", () => {
  it("reicht beide Limits unverändert durch, normalisiert undefined zu null", () => {
    const out = clampToStatutoryMax({
      budgetType: "irgendein_anderer_topf",
      monthlyLimitCents: 12345,
      yearlyLimitCents: undefined,
      pflegegrad: 3,
    });
    expect(out).toEqual({ monthlyLimitCents: 12345, yearlyLimitCents: null });
  });
});
