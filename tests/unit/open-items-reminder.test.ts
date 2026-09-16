import { describe, it, expect } from "vitest";
import {
  previousMonthOf,
  OPEN_ITEMS_REMINDER_DAY,
} from "../../server/services/open-items-reminder";

/**
 * Reine Einheiten der MA-Erinnerung (Ticket 6hVwwxG9cxWGphfp) — ohne DB.
 *
 * Der Stichtag und die Vormonats-Ableitung sind die beiden Stellen, an
 * denen ein Off-by-one den ganzen Versand verschiebt: einen Tag daneben
 * und das Batch feuert nie (es läuft täglich und prüft auf Gleichheit),
 * einen Monat daneben und es erinnert an den falschen Zeitraum.
 */
describe("MA-Erinnerung — Vormonats-Ableitung", () => {
  it("rechnet innerhalb des Jahres einen Monat zurück", () => {
    expect(previousMonthOf("2026-09-15")).toEqual({ year: 2026, month: 8 });
    expect(previousMonthOf("2026-03-15")).toEqual({ year: 2026, month: 2 });
  });

  it("trägt den Jahreswechsel korrekt (Januar → Dezember des Vorjahres)", () => {
    // Der Fall, der bei einer naiven `month - 1`-Rechnung Monat 0 ergäbe.
    expect(previousMonthOf("2026-01-15")).toEqual({ year: 2025, month: 12 });
  });

  it("hängt nicht am Tag im Monat", () => {
    for (const tag of ["01", "15", "28", "31"]) {
      expect(previousMonthOf(`2026-07-${tag}`)).toEqual({ year: 2026, month: 6 });
    }
  });

  it("liefert für JEDEN Monat eines Jahres einen gültigen Vormonat", () => {
    const kaputt: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const iso = `2026-${String(m).padStart(2, "0")}-15`;
      const p = previousMonthOf(iso);
      if (p.month < 1 || p.month > 12) kaputt.push(`${iso} -> Monat ${p.month}`);
      if (p.year !== (m === 1 ? 2025 : 2026)) kaputt.push(`${iso} -> Jahr ${p.year}`);
    }
    expect(kaputt).toEqual([]);
  });

  it("der Stichtag ist der 15. — Abrechnungsschluss 8. plus 7 Tage Nachfrist", () => {
    // Als Test und nicht nur als Konstante, weil die Zahl aus einer
    // fachlichen Rechnung stammt: verschiebt sich der Abrechnungsschluss,
    // muss sie mitwandern.
    expect(OPEN_ITEMS_REMINDER_DAY).toBe(15);
  });
});
