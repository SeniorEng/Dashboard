import { describe, expect, it } from "vitest";

import {
  billingReferenceDate,
  billingReferenceMonth,
  countPastWeekdaysInMonth,
} from "./billing-month";

/**
 * Nagelt die Invariante fest, wegen der es diesen Helfer gibt: An JEDEM
 * Kalendertag muss der Ankertag auf einen Monat zeigen, der genug vergangene
 * Werktage für die Fixtures hat. Der Test läuft ohne DB und ohne Server.
 */
describe("billingReferenceDate — kalender-unabhängig", () => {
  const MIN = 5;

  it("liefert an jedem Tag von 2026 einen Monat mit >= 5 vergangenen Werktagen", () => {
    const bad: string[] = [];
    for (let month = 0; month < 12; month++) {
      const lastDay = new Date(2026, month + 1, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        // 09:00 lokal: die Fixtures vergleichen gegen Mitternachts-Daten.
        const now = new Date(2026, month, day, 9, 0, 0);
        const ref = billingReferenceDate(now);
        if (countPastWeekdaysInMonth(ref) < MIN) {
          bad.push(`${now.toDateString()} -> ${ref.toDateString()}`);
        }
      }
    }
    expect(bad, `Tage ohne brauchbaren Anker:\n${bad.join("\n")}`).toEqual([]);
  });

  it("bleibt im laufenden Monat, sobald dieser genug Werktage hergibt", () => {
    // Di, 18.08.2026 — der August hat bis dahin reichlich Werktage.
    const now = new Date(2026, 7, 18, 9, 0, 0);
    const { year, month, reference } = billingReferenceMonth(now);
    expect(reference.getTime()).toBe(now.getTime());
    expect({ year, month }).toEqual({ year: 2026, month: 8 });
  });

  it("weicht am Monatsanfang auf den Vormonat aus — der Fall, der die Suite kippte", () => {
    // So, 02.08.2026: im August gibt es NULL vergangene Werktage.
    const now = new Date(2026, 7, 2, 9, 0, 0);
    expect(countPastWeekdaysInMonth(now)).toBe(0);

    const { year, month, reference } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2026, month: 7 });
    expect(reference.getDate()).toBe(31);
    expect(countPastWeekdaysInMonth(reference)).toBeGreaterThanOrEqual(MIN);
  });

  it("ist am Monatsletzten stabil (simulierter 31.07.2026, Freitag)", () => {
    const now = new Date(2026, 6, 31, 9, 0, 0);
    const { year, month, reference } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2026, month: 7 });
    expect(reference.getTime()).toBe(now.getTime());
  });

  it("überschreitet die Jahresgrenze korrekt (01.01. -> Dezember des Vorjahres)", () => {
    const now = new Date(2026, 0, 1, 9, 0, 0);
    const { year, month } = billingReferenceMonth(now);
    expect({ year, month }).toEqual({ year: 2025, month: 12 });
  });
});
