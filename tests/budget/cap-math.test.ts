/**
 * Pure-Unit-Tests für `computeCapRemaining` (`shared/domain/budget/cap-math.ts`).
 *
 * Diese Tests laufen OHNE DB/Server und sind daher Teil der Stryker-
 * Mutation-Testing-Suite (Task #770). Sie decken alle drei Topf-Zweige
 * (§45b Jahrestopf, §45a Monats-Cap inkl. Carryover + Pflegegrad-Clamp,
 * §39/§42a Jahres-Cap) sowie die Statutory-Clamp-Grenzen ab.
 */
import { describe, it, expect } from "vitest";
import { computeCapRemaining } from "@shared/domain/budget/cap-math";
import {
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
} from "@shared/domain/budgets";

describe("computeCapRemaining — §45b (akkumulierender Jahrestopf, KEIN Fenster-Cap)", () => {
  // §45b hat NIE einen Fenster-Cap. Das per-Kunde konfigurierte Monatslimit
  // ("Unser Anteil") wirkt allein als akkumulierende Aufstockungsrate in der
  // Allocation (allocation-storage `monthlyAmountFor` → `enumerate45bStatutoryMonths`),
  // NICHT als Buchungs-Cap. Der frühere zweite Fenster-Cap (Task #1171/BUG-21)
  // legte dasselbe Limit ein zweites Mal als per-Kalendermonat-Reset-Cap an
  // (Doppel-Anwendung) und war die Wurzel des wiederkehrenden §45b-Hard-Blocks
  // beim Dokumentieren (vgl. Datenfix Task #423). Er ist entfernt: §45b liefert
  // immer POSITIVE_INFINITY, unabhängig vom Monatslimit.
  it("ohne Monatslimit (null) → POSITIVE_INFINITY", () => {
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 5000,
      netUsedInWindowCents: 9999,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("monthlyLimitCents=0 (Sentinel „keine monatliche Aufstockung“) → POSITIVE_INFINITY", () => {
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 0,
      yearlyLimitCents: null,
      carryoverCents: 5000,
      netUsedInWindowCents: 9999,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("mit gesetztem Monatslimit (>0) bleibt §45b ungekappt → POSITIVE_INFINITY (kein Fenster-Cap mehr)", () => {
    // Das Limit ist die Aufstockungsrate, NICHT ein per-Monat-Buchungs-Cap.
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 13100,
      yearlyLimitCents: null,
      carryoverCents: 5000,
      netUsedInWindowCents: 9999,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("auch bei hohem Vorverbrauch im Fenster bleibt §45b ungekappt → POSITIVE_INFINITY (nie 0)", () => {
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 13100,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 20000,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });

  it("clampedMonthlyLimitCents spiegelt weiterhin den gesetzlichen Maximalwert, capRemaining bleibt POSITIVE_INFINITY", () => {
    // Der Statutory-Clamp läuft weiter (informativ / für die Aufstockungsrate),
    // erzeugt aber KEINEN Fenster-Cap mehr.
    const out = computeCapRemaining({
      budgetType: "entlastungsbetrag_45b",
      pflegegrad: 3,
      monthlyLimitCents: 20000, // über 131€
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(BUDGET_45B_MAX_MONTHLY_CENTS);
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeCapRemaining — §39/§42a (Jahres-Cap)", () => {
  it("rechnet yearlyLimit − netUsed", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: 100000,
      carryoverCents: 0,
      netUsedInWindowCents: 30000,
    });
    expect(out.capRemainingCents).toBe(70000);
  });

  it("clamped auf gesetzlichen Jahres-Höchstwert und nie negativ", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: 9_999_999, // über gesetzlichem Max
      carryoverCents: 0,
      netUsedInWindowCents: BUDGET_39_42A_MAX_YEARLY_CENTS + 50000,
    });
    expect(out.clampedYearlyLimitCents).toBe(BUDGET_39_42A_MAX_YEARLY_CENTS);
    expect(out.capRemainingCents).toBe(0);
  });

  it("liefert POSITIVE_INFINITY wenn kein Jahreslimit gesetzt ist", () => {
    const out = computeCapRemaining({
      budgetType: "ersatzpflege_39_42a",
      pflegegrad: null,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 12345,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeCapRemaining — §45a (Monats-Cap + Carryover + Pflegegrad)", () => {
  it("rechnet (monthlyLimit + carryover) − netUsed", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 5,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      carryoverCents: 2000,
      netUsedInWindowCents: 3000,
    });
    expect(out.capRemainingCents).toBe(9000);
  });

  it("klemmt das Monatslimit auf den Pflegegrad-Höchstwert", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 2,
      monthlyLimitCents: 999_999, // über PG2-Max
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
    expect(out.capRemainingCents).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[2]);
  });

  it("Pflegegrad 1 ist nicht anspruchsberechtigt → Cap 0", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 1,
      monthlyLimitCents: 50000,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.clampedMonthlyLimitCents).toBe(0);
    expect(out.capRemainingCents).toBe(0);
  });

  it("capRemaining wird bei Überverbrauch auf 0 geklemmt (nie negativ)", () => {
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 4,
      monthlyLimitCents: 10000,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 50000,
    });
    expect(out.capRemainingCents).toBe(0);
  });

  it("ohne Monatslimit greift bei PG≥2 der gesetzliche Default-Cap (kein Infinity)", () => {
    // Task #954/#973 — PG≥2 + §45a aktiv + kein expliziter Kunden-Wert ⇒ der
    // gesetzliche §45a-Default nach Pflegegrad greift (Anspruchsberechtigte sehen
    // UND buchen den gesetzlichen Monats-Cap). KEIN Infinity.
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 5,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.capRemainingCents).toBe(BUDGET_45A_MAX_BY_PFLEGEGRAD[5]);
  });

  it("ohne Monatslimit UND ohne Anspruch (PG<2) liefert POSITIVE_INFINITY (kein Cap-Beitrag)", () => {
    // PG<2 hat keinen gesetzlichen §45a-Default ⇒ resolve45aMonthlyLimitCents
    // liefert null ⇒ kein Fenster-Cap (Topf bleibt für Nicht-Anspruchsberechtigte
    // unverändert). PG<2-§45a-Aktivierung wird ohnehin an der API abgelehnt (400),
    // dieser Zweig ist also nur als reiner Resolver-Pfad erreichbar.
    const out = computeCapRemaining({
      budgetType: "umwandlung_45a",
      pflegegrad: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      carryoverCents: 0,
      netUsedInWindowCents: 0,
    });
    expect(out.capRemainingCents).toBe(Number.POSITIVE_INFINITY);
  });
});
