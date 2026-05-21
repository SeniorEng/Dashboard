/**
 * Task #561 — Drift-Detektor: Anzeige (Menge) vs. Buchung (Summe) auf
 * Rechnungs-Line-Items.
 *
 * Hintergrund: Rechnung RE-2026-0003 zeigte den Kunden Mengen wie "3 km"
 * mit Satz 0,35 €/km, summiert aber zu 0,95 € — Menge × Satz != Summe.
 * Wurzel: km-Float wurde unabhängig für Anzeige (auf 1 NK ganzzahlig) und
 * für Berechnung (ungerundet) verwendet.
 *
 * Dieser Test sichert die Konvention aus `shared/domain/invoice-line-items.ts`:
 *   Math.round(quantizeKm(km) * unitPriceCents) === computeKmLineTotalCents(km, unitPriceCents)
 * — d.h. derselbe quantisierte Wert geht in Display und Total. Drift wäre
 * ein Re-Auftritt von Bug #561.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeKmLineTotalCents,
  formatKmQuantityDisplay,
  quantizeKm,
} from "@shared/domain/invoice-line-items";

describe("invoice-line-item arithmetic (Task #561)", () => {
  it("property: Math.round(quantizeKm(km) * rate) === computeKmLineTotalCents(km, rate)", () => {
    fc.assert(
      fc.property(
        // 0–500 km mit Float-Präzision (Routing-/GPS-Werte).
        fc.double({ min: 0, max: 500, noNaN: true }),
        // 0–100 ct/km — 0 deckt Task #563 (kostenlose Kunden-km) ab.
        fc.integer({ min: 0, max: 100 }),
        (km, rate) => {
          const q = quantizeKm(km);
          const total = computeKmLineTotalCents(km, rate);
          // Anzeige × Satz = Summe — auf Cent exakt.
          expect(Math.round(q * rate)).toBe(total);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("quantizeKm: zwei Nachkommastellen, kaufmännische Rundung", () => {
    expect(quantizeKm(2.714)).toBe(2.71);
    expect(quantizeKm(2.715)).toBe(2.72); // .5 → auf
    expect(quantizeKm(8.0)).toBe(8);
    expect(quantizeKm(12)).toBe(12);
    expect(quantizeKm(0)).toBe(0);
  });

  it("formatKmQuantityDisplay: deutsches Locale, 2 NK, Komma", () => {
    expect(formatKmQuantityDisplay(2.714)).toBe("2,71 km");
    expect(formatKmQuantityDisplay(8)).toBe("8,00 km");
    expect(formatKmQuantityDisplay(12)).toBe("12,00 km");
  });

  /**
   * RE-2026-0003 — die drei realen Werte aus der Analyse. Mit dem alten
   * Code zeigten Zeile 1+2 Menge "3 km"/"8 km" bei Satz 0,35 €/km, summierten
   * aber zu 0,95 €/2,63 € (= km × 0,35 ungerundet). Nach Fix muss
   * quantize × rate == total gelten.
   */
  it.each([
    // [km, ratePerKmCents, erwartetTotalCents, erwarteteAnzeige]
    [2.714, 35, 95, "2,71 km"], // 2,71 × 35 = 94,85 → 95 ct
    [7.514, 35, 263, "7,51 km"], // 7,51 × 35 = 262,85 → 263 ct
    [12.0, 35, 420, "12,00 km"], // 12 × 35 = 420 ct
    // Task #563: Stückpreis 0 ct/km (kundenspezifisch "gratis") → Summe 0 ct,
    // Anzeige bleibt aussagekräftig (Menge × 0,00 €/km).
    [2.714, 0, 0, "2,71 km"],
    [12.0, 0, 0, "12,00 km"],
    [0, 0, 0, "0,00 km"],
  ])(
    "RE-2026-0003 Bezug: %f km × %i ct = %i ct, Anzeige %s",
    (km, rate, expectedTotal, expectedDisplay) => {
      expect(computeKmLineTotalCents(km, rate)).toBe(expectedTotal);
      expect(formatKmQuantityDisplay(km)).toBe(expectedDisplay);
      // Konsistenz: Anzeige-Menge × Satz === gespeicherte Summe.
      const q = quantizeKm(km);
      expect(Math.round(q * rate)).toBe(expectedTotal);
    },
  );
});
