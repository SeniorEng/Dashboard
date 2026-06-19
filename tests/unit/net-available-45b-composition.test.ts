/**
 * Task #1348 — Property-based Tests (fast-check) für die pure §45b-Verfügbarkeits-
 * Mathe `computeNetAvailable45b` (SSoT-Kern, DB-frei).
 *
 * Prüft die Invarianten des Alrik-Gates über zufällige Cent-Eingaben:
 *  - Floor: `availableCents` ist in BEIDEN Holds-Modi nie negativ.
 *  - Fehlbetrag-Sichtbarkeit: ein Über-Verbrauch floored `availableCents` auf 0,
 *    bleibt aber als negativer `allocated − consumedNet`-Saldo sichtbar (#95).
 *  - Holds-Kontext: `ignore` ≥ `subtract`; die Differenz liegt in `[0, holdsCents]`;
 *    bei `holdsCents == 0` sind beide Modi deckungsgleich.
 *  - `consumedNet == max(0, raw − excluded)` (nie negativ), monoton in `excluded`.
 *  - Roh-Durchreichung: `allocated/holds/raw/excluded` kommen unverändert zurück.
 *
 * Die DB-/Datums-Tore (validFrom/validTo, projectFuture, getBudgetSummary-Parität)
 * sind in der Integrationssuite `tests/budget/net-available-45b.test.ts` abgedeckt.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeNetAvailable45b,
  type Holds45bMode,
} from "@shared/domain/budget/net-available-45b";

/** Cent-Betrag in einem realistischen, aber großzügigen Bereich. */
const cents = fc.integer({ min: 0, max: 10_000_000 });
const holdsMode = fc.constantFrom<Holds45bMode>("subtract", "ignore");

describe("Task #1348 — computeNetAvailable45b (Property-based)", () => {
  it("availableCents ist in beiden Holds-Modi nie negativ (Floor)", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, holdsMode, (a, h, raw, ex, holds) => {
        const r = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
          holds,
        });
        expect(r.availableCents).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("consumedNet == max(0, raw − excluded) und nie negativ", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (a, h, raw, ex) => {
        const r = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        });
        expect(r.consumedNetCents).toBe(Math.max(0, raw - ex));
        expect(r.consumedNetCents).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("Fehlbetrag: Über-Verbrauch floored availableCents auf 0, Saldo bleibt negativ sichtbar (#95)", () => {
    fc.assert(
      fc.property(cents, cents, holdsMode, (a, extra, holds) => {
        // Verbrauch garantiert über der Allocation (extra >= 1).
        const raw = a + extra + 1;
        const r = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: 0,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: 0,
          holds,
        });
        // availableCents ist gefloored ...
        expect(r.availableCents).toBe(0);
        // ... aber der echte Fehlbetrag ist NICHT aus availableCents abgeleitet,
        // sondern aus den roh durchgereichten Größen rekonstruierbar (negativ).
        expect(r.allocatedCents - r.consumedNetCents).toBeLessThan(0);
      }),
    );
  });

  it("Holds-Kontext: ignore ≥ subtract, Differenz in [0, holdsCents]", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (a, h, raw, ex) => {
        const base = {
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        };
        const subtract = computeNetAvailable45b({ ...base, holds: "subtract" });
        const ignore = computeNetAvailable45b({ ...base, holds: "ignore" });
        expect(ignore.availableCents).toBeGreaterThanOrEqual(subtract.availableCents);
        const delta = ignore.availableCents - subtract.availableCents;
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(delta).toBeLessThanOrEqual(h);
        // holdsCents bleibt in BEIDEN Ergebnissen transparent (nur availableCents differiert).
        expect(ignore.holdsCents).toBe(h);
        expect(subtract.holdsCents).toBe(h);
      }),
    );
  });

  it("holdsCents == 0 ⇒ subtract und ignore sind deckungsgleich", () => {
    fc.assert(
      fc.property(cents, cents, cents, (a, raw, ex) => {
        const base = {
          allocatedCents: a,
          holdsCents: 0,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
        };
        const subtract = computeNetAvailable45b({ ...base, holds: "subtract" });
        const ignore = computeNetAvailable45b({ ...base, holds: "ignore" });
        expect(subtract.availableCents).toBe(ignore.availableCents);
      }),
    );
  });

  it("availableCents ist monoton steigend in excluded (mehr Exklusion ⇒ mehr frei)", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (a, h, raw, exDelta) => {
        const low = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: 0,
          holds: "subtract",
        });
        const high = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: exDelta,
          holds: "subtract",
        });
        expect(high.availableCents).toBeGreaterThanOrEqual(low.availableCents);
      }),
    );
  });

  it("reicht allocated/holds/raw/excluded unverändert durch", () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, holdsMode, (a, h, raw, ex, holds) => {
        const r = computeNetAvailable45b({
          allocatedCents: a,
          holdsCents: h,
          rawConsumedNetCents: raw,
          excludedConsumedNetCents: ex,
          holds,
        });
        expect(r.allocatedCents).toBe(a);
        expect(r.holdsCents).toBe(h);
        expect(r.rawConsumedNetCents).toBe(raw);
        expect(r.excludedConsumedNetCents).toBe(ex);
      }),
    );
  });
});
