import { describe, expect, it } from "vitest";

import {
  billingReferenceDate,
  billingReferenceMonth,
  countPastWeekdaysInMonth,
  pastWeekdayInBillingMonth,
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

/**
 * Dieselbe Kalender-Unabhängigkeit für den Termin-Slot selbst. Die duplizierten
 * `weekdayInCurrentMonth()`-Kopien lieferten am Wochenend-Monatsanfang entweder
 * einen Fehler oder — schlimmer — ein ZUKUNFTSDATUM, das die as-of-Leser nicht
 * zählen. Beides ist hier ausgeschlossen.
 */
describe("pastWeekdayInBillingMonth — nie leer, nie in der Zukunft", () => {
  it("liefert an jedem Tag von 2026 einen vergangenen Werktag im Anker-Monat", () => {
    const bad: string[] = [];
    for (let month = 0; month < 12; month++) {
      const lastDay = new Date(2026, month + 1, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        const now = new Date(2026, month, day, 9, 0, 0);
        const iso = pastWeekdayInBillingMonth(now);
        const d = new Date(`${iso}T00:00:00`);
        const ref = billingReferenceDate(now);

        const dow = d.getDay();
        if (dow === 0 || dow === 6) bad.push(`${iso} (aus ${now.toDateString()}) ist ein Wochenende`);
        // Nie in der Zukunft — das war der eigentliche Defekt der Kopien.
        if (d.getTime() > now.getTime()) bad.push(`${iso} (aus ${now.toDateString()}) liegt in der ZUKUNFT`);
        // Und immer im Abrechnungs-Monat des Ankertags.
        if (d.getMonth() !== ref.getMonth() || d.getFullYear() !== ref.getFullYear()) {
          bad.push(`${iso} (aus ${now.toDateString()}) liegt nicht im Anker-Monat`);
        }
      }
    }
    expect(bad, `Fehlerhafte Tage:\n${bad.join("\n")}`).toEqual([]);
  });

  it("kippt NICHT am Wochenend-Monatsanfang (So, 02.08.2026 — der reale Auslöser)", () => {
    const now = new Date(2026, 7, 2, 9, 0, 0);
    // Die alten Kopien lieferten hier 2026-08-03 (Montag, ZUKUNFT) oder warfen.
    expect(pastWeekdayInBillingMonth(now)).toBe("2026-07-31");
  });

  it("bleibt im laufenden Monat, sobald dieser genug Werktage hat (Di, 18.08.2026)", () => {
    const now = new Date(2026, 7, 18, 9, 0, 0);
    expect(pastWeekdayInBillingMonth(now)).toBe("2026-08-18");
  });

  it("liegt im selben Monat wie `billingReferenceMonth` (Termin und Abrechnung driften nicht)", () => {
    for (const now of [new Date(2026, 7, 2, 9), new Date(2026, 0, 1, 9), new Date(2026, 2, 17, 9)]) {
      const { year, month } = billingReferenceMonth(now);
      const iso = pastWeekdayInBillingMonth(now);
      expect(iso.slice(0, 7)).toBe(`${year}-${String(month).padStart(2, "0")}`);
    }
  });
});
