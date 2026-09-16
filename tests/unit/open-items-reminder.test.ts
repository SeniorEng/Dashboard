import { describe, it, expect } from "vitest";
import {
  previousMonthOf,
  OPEN_ITEMS_REMINDER_DAY,
} from "../../server/services/open-items-reminder";

/**
 * Reine Einheiten der Nach-Cutoff-Erinnerung (6hVwwxG9cxWGphfp) — ohne DB.
 *
 * Die Vormonats-Ableitung ist die Stelle, an der ein Off-by-one den
 * ganzen Versand verschiebt: einen Monat daneben und die Erinnerung
 * nennt den falschen Zeitraum.
 */
describe("Nach-Cutoff-Erinnerung — Vormonats-Ableitung", () => {
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

  it("der Stichtag ist der 15. — ein fester fachlicher Tag, keine Ableitung", () => {
    // Bewusst NICHT als „Abrechnungsschluss + 7" begruendet: der
    // Abrechnungsschluss ist nicht immer der 8., `computeMonthCloseCutoff`
    // rollt ihn auf Wochenende/Feiertag zurueck. Faellt der 8. auf einen
    // Sonntag, waere „+7" der 13. — der Dienst feuert trotzdem am 15.
    // Eine zweite, hartkodierte Fassung eines Datums, das schon eine
    // kanonische Funktion hat, waere genau der Zweitbegriff, den dieser
    // Dienst an anderer Stelle gerade beseitigt hat.
    expect(OPEN_ITEMS_REMINDER_DAY).toBe(15);
  });
});
