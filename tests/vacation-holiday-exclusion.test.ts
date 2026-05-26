import { describe, it, expect } from "vitest";
import {
  collectVacationRangeBreakdown,
  collectVacationWorkdays,
  collectWeekdayDates,
} from "../server/storage/time-tracking/entries";
import { getVacationHolidayDates, getVacationHolidayName } from "@shared/utils/holidays";

describe("Task #602 — Feiertags-Exklusion bei Urlaubsbuchungen", () => {
  describe("getVacationHolidayDates (Sachsen)", () => {
    it("enthält Reformationstag (31.10.) und Buß- und Bettag (Mittwoch vor Volkstrauertag)", () => {
      const h2026 = getVacationHolidayDates(2026);
      expect(h2026.has("2026-10-31")).toBe(true);
      expect(h2026.has("2026-11-18")).toBe(true);
    });

    it("enthält bundesweite Feiertage (Neujahr, Tag der Deutschen Einheit)", () => {
      const h2026 = getVacationHolidayDates(2026);
      expect(h2026.has("2026-01-01")).toBe(true);
      expect(h2026.has("2026-10-03")).toBe(true);
    });

    it("Ostermontag 2026 = 06.04.2026", () => {
      const h2026 = getVacationHolidayDates(2026);
      expect(h2026.has("2026-04-06")).toBe(true);
    });
  });

  describe("collectVacationRangeBreakdown", () => {
    it("filtert Wochenenden und Feiertage aus Mehrtages-Urlaub", () => {
      // 30.10.2026 (Fr) - 02.11.2026 (Mo)
      // 30.10 Fr Werktag | 31.10 Sa = Wochenende & Reformationstag (zählt als WE) | 01.11 So WE | 02.11 Mo Werktag
      const result = collectVacationRangeBreakdown("2026-10-30", "2026-11-02");
      expect(result.workdays).toEqual(["2026-10-30", "2026-11-02"]);
      expect(result.weekendDates).toEqual(["2026-10-31", "2026-11-01"]);
    });

    it("erkennt Feiertag auf Werktag (Tag der Deutschen Einheit 03.10.2025 fällt auf Freitag)", () => {
      const result = collectVacationRangeBreakdown("2025-10-01", "2025-10-06");
      expect(result.workdays).toEqual(["2025-10-01", "2025-10-02", "2025-10-06"]);
      expect(result.holidays.map((h) => h.date)).toEqual(["2025-10-03"]);
      expect(result.holidays[0].name).toContain("Deutschen Einheit");
    });

    it("Buß- und Bettag (Mi) wird übersprungen", () => {
      // 16.11.2026 (Mo) - 20.11.2026 (Fr), 18.11.2026 = Buß- und Bettag
      const result = collectVacationRangeBreakdown("2026-11-16", "2026-11-20");
      expect(result.workdays).toEqual([
        "2026-11-16",
        "2026-11-17",
        "2026-11-19",
        "2026-11-20",
      ]);
      expect(result.holidays.map((h) => h.date)).toEqual(["2026-11-18"]);
    });

    it("Range über Jahreswechsel hinweg", () => {
      // 30.12.2025 (Di) - 02.01.2026 (Fr), Neujahr 01.01.2026 = Feiertag (Do)
      const result = collectVacationRangeBreakdown("2025-12-30", "2026-01-02");
      expect(result.workdays).toEqual(["2025-12-30", "2025-12-31", "2026-01-02"]);
      expect(result.holidays.map((h) => h.date)).toEqual(["2026-01-01"]);
    });

    it("Single-Day Feiertag (Buß- und Bettag, Mi) liefert 0 Werktage", () => {
      const result = collectVacationRangeBreakdown("2026-11-18", "2026-11-18");
      expect(result.workdays).toEqual([]);
      expect(result.holidays.map((h) => h.date)).toEqual(["2026-11-18"]);
    });
  });

  describe("collectVacationWorkdays vs. collectWeekdayDates", () => {
    it("collectWeekdayDates ignoriert Feiertage (Verhalten für Krankheit unverändert)", () => {
      // 02.10.2026 (Fr) - 05.10.2026 (Mo): Sa+So Wochenende, 03.10 = Feiertag aber Sa
      const days = collectWeekdayDates("2025-10-01", "2025-10-06");
      expect(days).toEqual(["2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06"]);
    });

    it("collectVacationWorkdays filtert Feiertage zusätzlich raus", () => {
      const days = collectVacationWorkdays("2025-10-01", "2025-10-06");
      expect(days).toEqual(["2025-10-01", "2025-10-02", "2025-10-06"]);
    });
  });

  describe("getVacationHolidayName", () => {
    it("liefert Namen für Feiertage", () => {
      expect(getVacationHolidayName("2026-10-03")).toContain("Deutschen Einheit");
      expect(getVacationHolidayName("2026-10-31")).toContain("Reformation");
    });

    it("liefert undefined für reguläre Werktage", () => {
      expect(getVacationHolidayName("2026-10-05")).toBeUndefined();
    });
  });
});
