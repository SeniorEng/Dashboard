/**
 * Task #872 — Unit-Tests für die reine §45b-Monatsaufzählung (SSoT).
 *
 * `enumerate45bStatutoryMonths` ersetzt die historische Monat-für-Monat-Schleife
 * in `calculateAllocated45b`. Diese Tests pinnen das exakte Verhalten fest
 * (allocStart→end inklusive, Startwert-Monate übersprungen, historisierter
 * Monatsbetrag pro Monat, Jahreswechsel-Rollover) — die Gleichheits-Garantie
 * gegen den Alt-Pfad hängt daran.
 */
import { describe, it, expect } from "vitest";
import {
  enumerate45bStatutoryMonths,
  sum45bStatutoryMonths,
  type Statutory45bMonth,
} from "@shared/domain/budget/statutory-45b";

const flat = (amount: number) => () => amount;

describe("enumerate45bStatutoryMonths", () => {
  it("zählt einen einzelnen Monat auf (start == end)", () => {
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2026,
      allocStartMonth: 3,
      endYear: 2026,
      endMonth: 3,
      initialBalanceMonthKeys: new Set(),
      monthlyAmountFor: flat(13100),
    });
    expect(months).toEqual<Statutory45bMonth[]>([
      { year: 2026, month: 3, amountCents: 13100 },
    ]);
    expect(sum45bStatutoryMonths(months)).toBe(13100);
  });

  it("zählt inklusive von start bis end im selben Jahr", () => {
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2026,
      allocStartMonth: 1,
      endYear: 2026,
      endMonth: 5,
      initialBalanceMonthKeys: new Set(),
      monthlyAmountFor: flat(13100),
    });
    expect(months.map(m => m.month)).toEqual([1, 2, 3, 4, 5]);
    expect(sum45bStatutoryMonths(months)).toBe(5 * 13100);
  });

  it("rollt über den Jahreswechsel (Dez → Jan)", () => {
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2025,
      allocStartMonth: 11,
      endYear: 2026,
      endMonth: 2,
      initialBalanceMonthKeys: new Set(),
      monthlyAmountFor: flat(10000),
    });
    expect(months).toEqual<Statutory45bMonth[]>([
      { year: 2025, month: 11, amountCents: 10000 },
      { year: 2025, month: 12, amountCents: 10000 },
      { year: 2026, month: 1, amountCents: 10000 },
      { year: 2026, month: 2, amountCents: 10000 },
    ]);
  });

  it("überspringt durch Startwert belegte Monate (Schlüssel ohne Padding)", () => {
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2026,
      allocStartMonth: 1,
      endYear: 2026,
      endMonth: 4,
      // NICHT-aufgefüllter Monat, exakt wie der Legacy-initialBalanceSet
      initialBalanceMonthKeys: new Set(["2026-2", "2026-3"]),
      monthlyAmountFor: flat(13100),
    });
    expect(months.map(m => m.month)).toEqual([1, 4]);
    expect(sum45bStatutoryMonths(months)).toBe(2 * 13100);
  });

  it("verwendet den pro Monat historisierten Betrag", () => {
    const amountByMonth: Record<number, number> = { 1: 10000, 2: 12000, 3: 13100 };
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2026,
      allocStartMonth: 1,
      endYear: 2026,
      endMonth: 3,
      initialBalanceMonthKeys: new Set(),
      monthlyAmountFor: (_y, m) => amountByMonth[m],
    });
    expect(months.map(m => m.amountCents)).toEqual([10000, 12000, 13100]);
    expect(sum45bStatutoryMonths(months)).toBe(35100);
  });

  it("liefert eine leere Liste, wenn end vor start liegt", () => {
    const months = enumerate45bStatutoryMonths({
      allocStartYear: 2026,
      allocStartMonth: 6,
      endYear: 2026,
      endMonth: 3,
      initialBalanceMonthKeys: new Set(),
      monthlyAmountFor: flat(13100),
    });
    expect(months).toEqual([]);
    expect(sum45bStatutoryMonths(months)).toBe(0);
  });
});
