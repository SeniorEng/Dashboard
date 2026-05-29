/**
 * Task #814 — Direkte Unit-Tests für die bundeseinheitliche Feiertags-
 * Klassifikation. `getNationalHolidayDates(year)` wurde aus dem Monats-
 * abschluss-Cutoff in `shared/utils/holidays.ts` ausgelagert (Task #809)
 * und ist bisher nur transitiv über die Cutoff-Tests abgedeckt. Diese
 * Tests fixieren die Easter-abgeleitete Bewegungsfeiertags-Mathematik
 * (Karfreitag/Ostermontag/Christi Himmelfahrt/Pfingstmontag) und die
 * festen bundesweiten Feiertage, damit eine künftige Änderung an der
 * Feiertagslogik nicht still driften kann.
 */
import { describe, it, expect } from "vitest";
import { getNationalHolidayDates } from "@shared/utils/holidays";

describe("getNationalHolidayDates", () => {
  it("liefert die exakte bundeseinheitliche Feiertagsmenge für 2025 (Ostern = 20.04.2025)", () => {
    const dates = getNationalHolidayDates(2025);
    expect([...dates].sort()).toEqual([
      "2025-01-01", // Neujahr (fix)
      "2025-04-18", // Karfreitag (Ostern -2)
      "2025-04-21", // Ostermontag (Ostern +1)
      "2025-05-01", // Tag der Arbeit (fix)
      "2025-05-29", // Christi Himmelfahrt (Ostern +39)
      "2025-06-09", // Pfingstmontag (Ostern +50)
      "2025-10-03", // Tag der Deutschen Einheit (fix)
      "2025-12-25", // 1. Weihnachtsfeiertag (fix)
      "2025-12-26", // 2. Weihnachtsfeiertag (fix)
    ]);
  });

  it("liefert die exakte bundeseinheitliche Feiertagsmenge für 2026 (Ostern = 05.04.2026)", () => {
    const dates = getNationalHolidayDates(2026);
    expect([...dates].sort()).toEqual([
      "2026-01-01", // Neujahr (fix)
      "2026-04-03", // Karfreitag (Ostern -2)
      "2026-04-06", // Ostermontag (Ostern +1)
      "2026-05-01", // Tag der Arbeit (fix)
      "2026-05-14", // Christi Himmelfahrt (Ostern +39)
      "2026-05-25", // Pfingstmontag (Ostern +50)
      "2026-10-03", // Tag der Deutschen Einheit (fix)
      "2026-12-25", // 1. Weihnachtsfeiertag (fix)
      "2026-12-26", // 2. Weihnachtsfeiertag (fix)
    ]);
  });

  it("schließt landesspezifische Feiertage (Reformationstag, Buß- und Bettag) aus", () => {
    const dates = getNationalHolidayDates(2025);
    // Reformationstag 31.10. ist nur in einigen Bundesländern gesetzlich.
    expect(dates.has("2025-10-31")).toBe(false);
    // Buß- und Bettag 2025 = 19.11. — nur in Sachsen gesetzlich.
    expect(dates.has("2025-11-19")).toBe(false);
    // Heilige Drei Könige 06.01. — nur in einigen Bundesländern.
    expect(dates.has("2025-01-06")).toBe(false);
  });

  it("enthält genau 9 bundeseinheitliche Feiertage pro Jahr", () => {
    expect(getNationalHolidayDates(2025).size).toBe(9);
    expect(getNationalHolidayDates(2026).size).toBe(9);
  });
});
