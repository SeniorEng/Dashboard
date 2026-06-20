/**
 * Task #1366 — Property-based Tests (fast-check, DB-frei) für die §45b-Forecast-
 * Wiring auf die SSoT `netAvailable45bAt` / `computeNetAvailable45b`.
 *
 * Beide §45b-Forecast-Schleifen in `server/storage/budget/summary-queries.ts`
 * leiten ihre vorzeichenbehaftete Verfügbarkeit pro projiziertem Monatsende jetzt
 * aus dem SSoT-Ergebnis ab:
 *
 *     signedAvailable = net.allocatedCents − net.consumedNetCents
 *
 * (NICHT aus dem auf 0 gefloorten `net.availableCents` — Alrik-Gate #95) und mit
 * `holds: "ignore"` (der Forecast zählt die geplanten Kosten selbst). Diese Tests
 * pinnen DB-frei, dass dieser Ausdruck:
 *
 *  1. exakt die alte #1340-Mathe `allocAtEnd − (netUsed − excluded)` reproduziert,
 *     solange die Exklusion ⊆ Verbrauch ist (`excluded ≤ raw`) und es keine
 *     manual_adjustments gibt (= der reale Forecast-Fall),
 *  2. bei „Über-Exklusion" (`excluded > raw`, defensiv) auf den laufenden Topf
 *     gefloored bleibt und damit KONSERVATIVER ist als die alte Mathe (kein
 *     künstliches Über-Budget),
 *  3. vollständig holds-unabhängig ist (Holds wirken im Forecast bewusst nicht),
 *  4. eine echte Über-Planung als negativen Saldo sichtbar lässt (der Fehlbetrag
 *     darf NICHT im 0-Floor verschwinden).
 *
 * Die DB-/Datums-Tore (projectFuture, getBudgetSummary-Parität, Carryover-
 * Verfalls-Symmetrie über die Juli-Grenze) sind in der Integrationssuite
 * `tests/budget/45b-forecast-carryover-symmetry.test.ts` abgedeckt.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeNetAvailable45b,
  type Holds45bMode,
} from "@shared/domain/budget/net-available-45b";

const cents = fc.integer({ min: 0, max: 10_000_000 });
const holdsMode = fc.constantFrom<Holds45bMode>("subtract", "ignore");

/** Die im Forecast verwendete vorzeichenbehaftete Verfügbarkeit (roh, nicht gefloored). */
function forecastSignedAvailable(input: {
  allocatedCents: number;
  holdsCents: number;
  rawConsumedNetCents: number;
  excludedConsumedNetCents: number;
}): number {
  const net = computeNetAvailable45b({ ...input, holds: "ignore" });
  return net.allocatedCents - net.consumedNetCents;
}

describe("Task #1366 — §45b-Forecast signed-available (Property-based)", () => {
  it("reproduziert die alte #1340-Mathe `alloc − (used − excluded)` für excluded ≤ used", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (a, h, raw, exDelta) => {
        // Realer Forecast-Fall: die Exklusion ist eine Teilmenge des Verbrauchs.
        const ex = raw === 0 ? 0 : exDelta % (raw + 1); // 0 ≤ ex ≤ raw
        const signed = forecastSignedAvailable({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        });
        // Alte Schleife (Forecast #1/#2): netUsed = raw (nur consumption, keine
        // manual_adjustments), Fehlbetrag = allocAtEnd − (netUsed − excluded).
        expect(signed).toBe(a - (raw - ex));
      }),
    );
  });

  it("ist bei Über-Exklusion (excluded > used) konservativer als die alte Mathe (Floor statt Über-Budget)", () => {
    fc.assert(
      fc.property(cents, cents, cents, (a, raw, over) => {
        const ex = raw + over + 1; // garantiert excluded > raw
        const signed = forecastSignedAvailable({
          allocatedCents: a,
          holdsCents: 0,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        });
        // consumedNet wird auf 0 gefloored ⇒ signed == allocated.
        expect(signed).toBe(a);
        // Die alte Mathe hätte `a − (raw − ex) = a + (ex − raw) > a` ergeben —
        // also künstliches Über-Budget. Neu ist nie größer (konservativ).
        expect(signed).toBeLessThanOrEqual(a - (raw - ex));
      }),
    );
  });

  it("ist vollständig holds-unabhängig (Holds wirken im Forecast nicht)", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (a, h, raw, ex) => {
        const withHolds = forecastSignedAvailable({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        });
        const withoutHolds = forecastSignedAvailable({
          allocatedCents: a,
          holdsCents: 0,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        });
        expect(withHolds).toBe(withoutHolds);
      }),
    );
  });

  it("signed-available ist identisch, egal welcher Holds-Modus an die SSoT geht", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, holdsMode, (a, h, raw, ex, holds) => {
        const net = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
          holds,
        });
        // Der Forecast liest allocated − consumedNet; beide sind holds-invariant.
        expect(net.allocatedCents - net.consumedNetCents).toBe(a - Math.max(0, raw - ex));
      }),
    );
  });

  it("eine echte Über-Planung bleibt als negativer Saldo sichtbar (#95, Floor verschluckt sie nicht)", () => {
    fc.assert(
      fc.property(cents, cents, (a, extra) => {
        // Verbrauch garantiert über der Allocation, keine Exklusion.
        const raw = a + extra + 1;
        const signed = forecastSignedAvailable({
          allocatedCents: a,
          holdsCents: 0,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: 0,
        });
        expect(signed).toBeLessThan(0);
      }),
    );
  });
});
