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
