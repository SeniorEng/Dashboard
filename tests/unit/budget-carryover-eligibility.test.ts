/**
 * Task #937 — Direkte Unit-Tests für die in Task #928 ausgelagerte reine
 * §45b-Übertrag-Obergrenze (`shared/domain/budget/carryover-eligibility.ts`).
 *
 * Bei der Kundenanlage darf der Vorjahres-Übertrag höchstens so viele
 * Monatsaufstockungen umfassen, wie der Kunde im Vorjahr pflegegrad-berechtigt
 * war. Diese Tests pinnen die Monats-Ableitung aus `pflegegradSeit` relativ
 * zum laufenden Jahr (kein Datum, dieses Jahr, Vorjahr Jahresmitte, vor dem
 * Vorjahr) und die Cent-Umrechnung.
 */
import { describe, it, expect } from "vitest";
import {
  eligible45bCarryoverMonths,
  max45bCarryoverCents,
  max45bStartValueCents,
  validate45bInitialBalanceNotPriorYear,
  PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE,
} from "@shared/domain/budget/carryover-eligibility";
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";

describe("eligible45bCarryoverMonths", () => {
  it("gibt 12 zurück, wenn kein Datum übergeben wird (null)", () => {
    expect(eligible45bCarryoverMonths(null, 2026)).toBe(12);
  });

  it("gibt 12 zurück bei undefined", () => {
    expect(eligible45bCarryoverMonths(undefined, 2026)).toBe(12);
  });

  it("gibt 12 zurück bei nicht parsebarem Datum", () => {
    expect(eligible45bCarryoverMonths("kein-datum", 2026)).toBe(12);
  });

  it("gibt 0 zurück, wenn der Pflegegrad erst im laufenden Jahr begann", () => {
    expect(eligible45bCarryoverMonths("2026-03-01", 2026)).toBe(0);
  });

  it("rechnet ab dem Startmonat anteilig, wenn der Pflegegrad im Vorjahr begann", () => {
    // März des Vorjahres → 12 - (3 - 1) = 10 berechtigte Monate
    expect(eligible45bCarryoverMonths("2025-03-15", 2026)).toBe(10);
  });

  it("gibt 12 zurück, wenn der Pflegegrad im Januar des Vorjahres begann", () => {
    expect(eligible45bCarryoverMonths("2025-01-01", 2026)).toBe(12);
  });

  it("gibt 1 zurück, wenn der Pflegegrad im Dezember des Vorjahres begann", () => {
    expect(eligible45bCarryoverMonths("2025-12-10", 2026)).toBe(1);
  });

  it("gibt 12 zurück, wenn der Pflegegrad vor dem Vorjahr begann", () => {
    expect(eligible45bCarryoverMonths("2020-06-01", 2026)).toBe(12);
  });
});

describe("max45bCarryoverCents", () => {
  it("gibt 0 zurück bei 0 berechtigten Monaten", () => {
    expect(max45bCarryoverCents(0)).toBe(0);
  });

  it("multipliziert die Monatsaufstockung mit der Monatszahl", () => {
    expect(max45bCarryoverCents(10)).toBe(BUDGET_45B_MAX_MONTHLY_CENTS * 10);
  });

  it("liefert den vollen Jahresbetrag bei 12 Monaten", () => {
    expect(max45bCarryoverCents(12)).toBe(BUDGET_45B_MAX_MONTHLY_CENTS * 12);
  });
});

describe("max45bStartValueCents (Task #959)", () => {
  it("kappt auf 1 Monat, wenn Anker = Startmonat (Onboarding im selben Monat)", () => {
    expect(max45bStartValueCents("2026-03-01", "2026-03-15")).toBe(
      BUDGET_45B_MAX_MONTHLY_CENTS,
    );
  });

  it("erlaubt akkumulierte Monate, wenn der Anker früher im Jahr liegt", () => {
    // Pflegegrad seit Januar, Startwert für Mai → Jan..Mai = 5 Monate
    expect(max45bStartValueCents("2026-01-10", "2026-05-15")).toBe(
      BUDGET_45B_MAX_MONTHLY_CENTS * 5,
    );
  });

  it("rechnet ab Januar, wenn der Anker in einem Vorjahr liegt", () => {
    // Anker 2023, Startwert für April 2026 → Jan..Apr 2026 = 4 Monate
    expect(max45bStartValueCents("2023-08-01", "2026-04-01")).toBe(
      BUDGET_45B_MAX_MONTHLY_CENTS * 4,
    );
  });

  it("gibt 0 zurück, wenn der Anker erst NACH dem Startmonat im Startjahr beginnt", () => {
    expect(max45bStartValueCents("2026-06-01", "2026-03-01")).toBe(0);
  });

  it("gibt 0 zurück, wenn der Anker in einem späteren Jahr liegt", () => {
    expect(max45bStartValueCents("2027-01-01", "2026-05-01")).toBe(0);
  });

  it("rechnet ab Januar (großzügig), wenn kein Anker übergeben wird", () => {
    expect(max45bStartValueCents(null, "2026-04-15")).toBe(
      BUDGET_45B_MAX_MONTHLY_CENTS * 4,
    );
  });

  it("fällt bei unparsebarem Startmonat auf eine Monatsaufstockung zurück", () => {
    expect(max45bStartValueCents("2026-01-01", "kein-datum")).toBe(
      BUDGET_45B_MAX_MONTHLY_CENTS,
    );
  });
});

describe("validate45bInitialBalanceNotPriorYear (Task #964)", () => {
  it("lehnt einen Stichmonat aus dem Vorjahr ab und verweist auf den Übertrag", () => {
    const err = validate45bInitialBalanceNotPriorYear("2025-11", 2026);
    expect(err).toBe(PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE);
    expect(err).toContain("Übertrag aus Vorjahr");
  });

  it("lehnt auch ein weit zurückliegendes Jahr ab", () => {
    expect(validate45bInitialBalanceNotPriorYear("2020-01-01", 2026)).toBe(
      PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE,
    );
  });

  it("erlaubt einen Stichmonat im laufenden Jahr", () => {
    expect(validate45bInitialBalanceNotPriorYear("2026-01", 2026)).toBeNull();
    expect(validate45bInitialBalanceNotPriorYear("2026-12-01", 2026)).toBeNull();
  });

  it("erlaubt einen Stichmonat in einem späteren Jahr (kein Vorjahr)", () => {
    expect(validate45bInitialBalanceNotPriorYear("2027-03", 2026)).toBeNull();
  });

  it("akzeptiert sowohl YYYY-MM als auch YYYY-MM-DD", () => {
    expect(validate45bInitialBalanceNotPriorYear("2025-06", 2026)).toBe(
      PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE,
    );
    expect(validate45bInitialBalanceNotPriorYear("2025-06-15", 2026)).toBe(
      PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE,
    );
  });

  it("gibt null zurück bei leerer/unparsebarer Eingabe (Schema greift separat)", () => {
    expect(validate45bInitialBalanceNotPriorYear("", 2026)).toBeNull();
    expect(validate45bInitialBalanceNotPriorYear("kein-datum", 2026)).toBeNull();
  });
});
