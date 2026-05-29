import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseGermanDecimal } from "@shared/utils/parse-german-decimal";

describe("parseGermanDecimal (Task #819)", () => {
  it("liefert echte JS-Zahlen unverändert", () => {
    expect(parseGermanDecimal(10.9)).toBe(10.9);
    expect(parseGermanDecimal(0)).toBe(0);
    expect(parseGermanDecimal(-5.25)).toBe(-5.25);
    expect(parseGermanDecimal(1234)).toBe(1234);
  });

  it("parst deutsches Dezimal-Komma", () => {
    expect(parseGermanDecimal("10,9")).toBe(10.9);
    expect(parseGermanDecimal("0,5")).toBe(0.5);
    expect(parseGermanDecimal("12,75")).toBe(12.75);
  });

  it("parst deutsches Format mit Tausenderpunkt", () => {
    expect(parseGermanDecimal("1.234,5")).toBe(1234.5);
    expect(parseGermanDecimal("1.234.567,89")).toBe(1234567.89);
  });

  it("parst englisches Dezimal-Format", () => {
    expect(parseGermanDecimal("10.9")).toBe(10.9);
    expect(parseGermanDecimal("1,234.5")).toBe(1234.5);
  });

  it("behandelt mehrfache Separatoren als Tausendertrenner (kein Dezimalteil)", () => {
    expect(parseGermanDecimal("1.234.567")).toBe(1234567);
    expect(parseGermanDecimal("1,234,567")).toBe(1234567);
  });

  it("interpretiert einen einzelnen Punkt als Dezimalpunkt (km/Stunden-Domäne)", () => {
    // In der Import-Domäne (km, Stunden) ist ein einzelner Punkt mit drei
    // Nachkommastellen praktisch immer ein Dezimalwert (1.234), nicht der
    // deutsche Tausenderpunkt für 1234 — km-/Stundenwerte erreichen keine
    // Tausenderbeträge. Wir folgen daher der nativen JS-Number-Semantik.
    expect(parseGermanDecimal("1.234")).toBe(1.234);
    expect(parseGermanDecimal("12.5")).toBe(12.5);
  });

  it("ignoriert Einheiten und Whitespace", () => {
    expect(parseGermanDecimal(" 12,5 km ")).toBe(12.5);
    expect(parseGermanDecimal("10,9 Std")).toBe(10.9);
    expect(parseGermanDecimal("\u00a05,0\u00a0")).toBe(5);
  });

  it("behandelt Vorzeichen", () => {
    expect(parseGermanDecimal("-10,9")).toBe(-10.9);
    expect(parseGermanDecimal("+3,5")).toBe(3.5);
  });

  it("liefert 0 für leere / nicht parsebare / null-Werte", () => {
    expect(parseGermanDecimal("")).toBe(0);
    expect(parseGermanDecimal("   ")).toBe(0);
    expect(parseGermanDecimal(null)).toBe(0);
    expect(parseGermanDecimal(undefined)).toBe(0);
    expect(parseGermanDecimal("abc")).toBe(0);
    expect(parseGermanDecimal(true)).toBe(0);
    expect(parseGermanDecimal({})).toBe(0);
    expect(parseGermanDecimal(NaN)).toBe(0);
    expect(parseGermanDecimal(Infinity)).toBe(0);
  });

  it("Property: deutsches Komma-Format == numerischer Wert (2 NK)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999 }),
        fc.integer({ min: 0, max: 99 }),
        (intPart, fracPart) => {
          const frac = String(fracPart).padStart(2, "0");
          const german = `${intPart},${frac}`;
          const expected = Number(`${intPart}.${frac}`);
          expect(parseGermanDecimal(german)).toBeCloseTo(expected, 6);
        },
      ),
    );
  });

  it("Property: endliche Zahl-Eingaben bleiben identisch", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (n) => {
          expect(parseGermanDecimal(n)).toBe(n);
        },
      ),
    );
  });
});
