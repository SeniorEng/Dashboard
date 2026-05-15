/**
 * Task #441 — Unit-Tests für den zentralen Money-Helper.
 */
import { describe, it, expect } from "vitest";
import { centsToEuroNumber, formatEuroDE, parseEuroDE } from "@shared/utils/money";

describe("shared/utils/money", () => {
  describe("centsToEuroNumber", () => {
    it("konvertiert Cents zu Euro-Number", () => {
      expect(centsToEuroNumber(12550)).toBe(125.5);
      expect(centsToEuroNumber(0)).toBe(0);
      expect(centsToEuroNumber(-500)).toBe(-5);
    });
  });

  describe("formatEuroDE", () => {
    it("formatiert positive Beträge im deutschen Format", () => {
      expect(formatEuroDE(12550)).toMatch(/^125,50\s?€$/);
      expect(formatEuroDE(100)).toMatch(/^1,00\s?€$/);
      expect(formatEuroDE(0)).toMatch(/^0,00\s?€$/);
    });

    it("formatiert negative Beträge mit Vorzeichen", () => {
      expect(formatEuroDE(-500)).toMatch(/^-5,00\s?€$/);
    });

    it("formatiert mit explizitem Plus-Zeichen", () => {
      expect(formatEuroDE(12550, { showSign: true })).toMatch(/^\+125,50\s?€$/);
      expect(formatEuroDE(-500, { showSign: true })).toMatch(/^-5,00\s?€$/);
      expect(formatEuroDE(0, { showSign: true })).toMatch(/^0,00\s?€$/);
    });

    it("formatiert ohne Währungssymbol", () => {
      expect(formatEuroDE(12550, { withCurrency: false })).toBe("125,50");
      expect(formatEuroDE(-500, { withCurrency: false })).toBe("-5,00");
    });
  });

  describe("parseEuroDE", () => {
    it("parst deutsches Format", () => {
      expect(parseEuroDE("125,50")).toBe(12550);
      expect(parseEuroDE("0,00")).toBe(0);
      expect(parseEuroDE("1.234,56")).toBe(123456);
    });

    it("parst englisches Format", () => {
      expect(parseEuroDE("125.50")).toBe(12550);
      expect(parseEuroDE("125")).toBe(12500);
    });

    it("tolerant gegenüber Euro-Zeichen und Whitespace", () => {
      expect(parseEuroDE("  125,50 €  ")).toBe(12550);
      expect(parseEuroDE("125 €")).toBe(12500);
    });

    it("liefert null für leere/ungültige Eingaben", () => {
      expect(parseEuroDE("")).toBeNull();
      expect(parseEuroDE("   ")).toBeNull();
      expect(parseEuroDE(null)).toBeNull();
      expect(parseEuroDE(undefined)).toBeNull();
      expect(parseEuroDE("abc")).toBeNull();
    });

    it("Round-Trip: format → parse erhält den Betrag", () => {
      for (const cents of [0, 1, 99, 100, 12550, 13100, 353900, -500]) {
        const formatted = formatEuroDE(cents);
        expect(parseEuroDE(formatted)).toBe(cents);
      }
    });
  });
});
