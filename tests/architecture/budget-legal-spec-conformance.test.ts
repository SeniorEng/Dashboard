/**
 * Task #1390 — Spec-Conformance: Die Budget-Code-Konstanten in
 * `shared/domain/budgets.ts` MÜSSEN exakt den in `docs/budget-legal-spec.md`
 * dokumentierten gesetzlichen Beträgen (Stand 2026) entsprechen.
 *
 * Hintergrund: `docs/budget-legal-spec.md` ist die maßgebliche Rechts-Spezifikation
 * der vier Budget-Regeln (R-45B, R-45A, R-39, R-SZ). Damit die Code-Konstanten
 * nicht still von der dokumentierten Rechtslage abdriften, spiegelt dieser Test
 * die Spec-Beträge als Literale wider und vergleicht sie mit den importierten
 * Konstanten. Ändert sich eine Konstante, ohne dass die Spec (und dieser Test)
 * angepasst wird, bricht das Gate.
 *
 * Reiner Logik-Test: kein Server, keine DB (läuft im `unit`-Vitest-Project).
 */
import { describe, it, expect } from "vitest";
import {
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  get45aMaxForPflegegrad,
} from "@shared/domain/budgets";

// ---------------------------------------------------------------------------
// Spec-Beträge (Stand 2026) — Quelle: docs/budget-legal-spec.md
// Alle Beträge in Integer-Cents (keine Floats/Euro-Strings).
// ---------------------------------------------------------------------------

// R-45B — §45b Entlastungsbetrag: 131 €/Monat.
const SPEC_45B_MAX_MONTHLY_CENTS = 13100;

// R-45A — §45a Umwandlungsanspruch: 40 % der §36-Sachleistung je Pflegegrad.
const SPEC_45A_MAX_BY_PFLEGEGRAD: Record<number, number> = {
  1: 0, // PG1: kein Anspruch
  2: 31840, // PG2: 318,40 €
  3: 59880, // PG3: 598,80 €
  4: 74360, // PG4: 743,60 €
  5: 91960, // PG5: 919,60 €
};

// R-39 — §39/§42a gemeinsamer Jahresbetrag: 3.539 €/Jahr (seit 01.07.2025).
const SPEC_39_42A_MAX_YEARLY_CENTS = 353900;

describe("Spec-Conformance — Budget-Konstanten == docs/budget-legal-spec.md (Task #1390)", () => {
  it("R-45B: §45b-Monats-Cap entspricht der Spec", () => {
    expect(BUDGET_45B_MAX_MONTHLY_CENTS).toBe(SPEC_45B_MAX_MONTHLY_CENTS);
  });

  it("R-45A: §45a-Cap je Pflegegrad entspricht der Spec", () => {
    expect(BUDGET_45A_MAX_BY_PFLEGEGRAD).toEqual(SPEC_45A_MAX_BY_PFLEGEGRAD);
    // Der Reader liefert dieselben Beträge wie die Konstanten-Tabelle.
    for (const pg of [1, 2, 3, 4, 5]) {
      expect(get45aMaxForPflegegrad(pg)).toBe(SPEC_45A_MAX_BY_PFLEGEGRAD[pg]);
    }
    // PG ohne Anspruch / unbekannt liefern 0.
    expect(get45aMaxForPflegegrad(null)).toBe(0);
    expect(get45aMaxForPflegegrad(0)).toBe(0);
  });

  it("R-39: §39/§42a-Jahres-Cap entspricht der Spec", () => {
    expect(BUDGET_39_42A_MAX_YEARLY_CENTS).toBe(SPEC_39_42A_MAX_YEARLY_CENTS);
  });

  it("Alle Cap-Beträge sind nicht-negative Integer-Cents", () => {
    const all = [
      BUDGET_45B_MAX_MONTHLY_CENTS,
      BUDGET_39_42A_MAX_YEARLY_CENTS,
      ...Object.values(BUDGET_45A_MAX_BY_PFLEGEGRAD),
    ];
    for (const cents of all) {
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThanOrEqual(0);
    }
  });
});
