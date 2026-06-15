/**
 * Task #1289 (Phase 3.1) — Anker-/Fenster-/Clamp-Verhalten der Budget-Domäne
 * OHNE die gelöschten Allocation-Quellen (`monthly_auto`/`yearly_auto`/
 * `statutory_monthly`).
 *
 * Hintergrund: Die monatliche/jährliche Aufstockung wird rein rechnerisch zur
 * Laufzeit ermittelt (siehe `calculateAllocated45b`/`…45a`/`…39_42a`), NICHT
 * mehr als Allocation-Zeilen materialisiert. Die Anker-Reihenfolge stützt sich
 * deshalb ausschließlich auf die puren Domänen-Helfer dieser Datei
 * (Pflegegrad-Anker → Startwert → Carryover → Default). Diese Property-/
 * Regressions-Tests verankern deren mathematische Invarianten, damit der
 * Wegfall der Altlast-Quellen das Anker-Verhalten nicht verschiebt.
 *
 * Alle Tests sind PUR (keine DB, kein Server) → laufen im `unit`-Project.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  floorAutoAnchor45bToCurrentYear,
  clampToStatutoryMax,
  resolve45aMonthlyLimitCents,
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
} from "@shared/domain/budgets";
import { carryoverWindowFor } from "@shared/domain/budget-carryover-dedup";

/** ISO-Datum (YYYY-MM-DD) als Arbitrary (Tag ≤ 28 ⇒ immer gültig). */
const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

describe("floorAutoAnchor45bToCurrentYear — §45b-Auto-Anker (Task #1289)", () => {
  it("Property: Ergebnis liegt nie vor dem 1.1. des laufenden Jahres", () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 2000, max: 2100 }), (derived, curYear) => {
        const floor = `${curYear}-01-01`;
        expect(floorAutoAnchor45bToCurrentYear(derived, curYear) >= floor).toBe(true);
      }),
    );
  });

  it("Property: Datum am/nach Jahresanfang bleibt unverändert, davor wird gebodet", () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 2000, max: 2100 }), (derived, curYear) => {
        const floor = `${curYear}-01-01`;
        const out = floorAutoAnchor45bToCurrentYear(derived, curYear);
        if (derived < floor) {
          expect(out).toBe(floor);
        } else {
          expect(out).toBe(derived);
        }
      }),
    );
  });

  it("Property: idempotent (Boden eines bereits gebodeten Datums ändert nichts)", () => {
    fc.assert(
      fc.property(isoDateArb, fc.integer({ min: 2000, max: 2100 }), (derived, curYear) => {
        const once = floorAutoAnchor45bToCurrentYear(derived, curYear);
        const twice = floorAutoAnchor45bToCurrentYear(once, curYear);
        expect(twice).toBe(once);
      }),
    );
  });

  it("Property: monoton in der Pflegegrad-Historie (späterer Anker ⇒ ≥ Anker)", () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, fc.integer({ min: 2000, max: 2100 }), (a, b, curYear) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const flo = floorAutoAnchor45bToCurrentYear(lo, curYear);
        const fhi = floorAutoAnchor45bToCurrentYear(hi, curYear);
        expect(flo <= fhi).toBe(true);
      }),
    );
  });

  it("Regression: Pflegegrad-Wechsel im Vorjahr ⇒ Anker = 1.1. laufendes Jahr", () => {
    expect(floorAutoAnchor45bToCurrentYear("2024-03-15", 2026)).toBe("2026-01-01");
  });

  it("Regression: Pflegegrad-Wechsel im laufenden Jahr (z. B. März) bleibt erhalten", () => {
    expect(floorAutoAnchor45bToCurrentYear("2026-03-01", 2026)).toBe("2026-03-01");
  });
});

describe("carryoverWindowFor — §45b-Übertragsfenster bis 30.06 (Task #1289)", () => {
  it("Property: Zieljahr = Quelljahr + 1, Fenster 01.01–30.06", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (sourceYear) => {
        const w = carryoverWindowFor(sourceYear);
        expect(w.targetYear).toBe(sourceYear + 1);
        expect(w.validFrom).toBe(`${sourceYear + 1}-01-01`);
        expect(w.expiresAt).toBe(`${sourceYear + 1}-06-30`);
        expect(w.validFrom < w.expiresAt).toBe(true);
      }),
    );
  });

  it("Regression: 2024 → Fenster 2025-01-01 … 2025-06-30", () => {
    expect(carryoverWindowFor(2024)).toEqual({
      targetYear: 2025,
      validFrom: "2025-01-01",
      expiresAt: "2025-06-30",
    });
  });
});

describe("clampToStatutoryMax — gesetzliche Obergrenzen (Task #1289)", () => {
  it("Property §45b: monthly wird nie über 131 € gehoben, negativ ⇒ 0, null ⇒ null", () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: -1000, max: 50000 }), { nil: null }), (v) => {
        const { monthlyLimitCents } = clampToStatutoryMax({
          budgetType: "entlastungsbetrag_45b",
          monthlyLimitCents: v,
          yearlyLimitCents: null,
          pflegegrad: 3,
        });
        if (v == null) expect(monthlyLimitCents).toBeNull();
        else if (v < 0) expect(monthlyLimitCents).toBe(0);
        else expect(monthlyLimitCents).toBe(Math.min(v, BUDGET_45B_MAX_MONTHLY_CENTS));
      }),
    );
  });

  it("Property §45a: monthly gegen Pflegegrad-Cap (PG < 2 ⇒ Cap 0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200000 }),
        fc.integer({ min: 1, max: 5 }),
        (v, pg) => {
          const cap = pg >= 2 ? (BUDGET_45A_MAX_BY_PFLEGEGRAD[pg] ?? 0) : 0;
          const { monthlyLimitCents } = clampToStatutoryMax({
            budgetType: "umwandlung_45a",
            monthlyLimitCents: v,
            yearlyLimitCents: null,
            pflegegrad: pg,
          });
          expect(monthlyLimitCents).toBe(Math.min(v, cap));
        },
      ),
    );
  });

  it("Property §39/§42a: yearly gegen 3.539 €/Jahr geklemmt", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000000 }), (v) => {
        const { yearlyLimitCents } = clampToStatutoryMax({
          budgetType: "ersatzpflege_39_42a",
          monthlyLimitCents: null,
          yearlyLimitCents: v,
          pflegegrad: 4,
        });
        expect(yearlyLimitCents).toBe(Math.min(v, BUDGET_39_42A_MAX_YEARLY_CENTS));
      }),
    );
  });

  it("Property: idempotent über alle Töpfe", () => {
    const budgetTypeArb = fc.constantFrom(
      "entlastungsbetrag_45b",
      "umwandlung_45a",
      "ersatzpflege_39_42a",
    );
    fc.assert(
      fc.property(
        budgetTypeArb,
        fc.option(fc.integer({ min: -1000, max: 500000 }), { nil: null }),
        fc.option(fc.integer({ min: -1000, max: 500000 }), { nil: null }),
        fc.integer({ min: 1, max: 5 }),
        (budgetType, m, y, pg) => {
          const once = clampToStatutoryMax({
            budgetType,
            monthlyLimitCents: m,
            yearlyLimitCents: y,
            pflegegrad: pg,
          });
          const twice = clampToStatutoryMax({
            budgetType,
            monthlyLimitCents: once.monthlyLimitCents,
            yearlyLimitCents: once.yearlyLimitCents,
            pflegegrad: pg,
          });
          expect(twice).toEqual(once);
        },
      ),
    );
  });
});

describe("resolve45aMonthlyLimitCents — §45a Default-Limit (Task #1289)", () => {
  it("Property: expliziter Wert (inkl. 0) gewinnt immer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200000 }),
        fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
        (explicit, pg) => {
          expect(resolve45aMonthlyLimitCents(explicit, pg)).toBe(explicit);
        },
      ),
    );
  });

  it("Property: ohne expliziten Wert ⇒ statutorischer Cap bzw. null (PG < 2)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (pg) => {
        const out = resolve45aMonthlyLimitCents(null, pg);
        const statutory = pg >= 2 ? (BUDGET_45A_MAX_BY_PFLEGEGRAD[pg] ?? 0) : 0;
        if (statutory > 0) expect(out).toBe(statutory);
        else expect(out).toBeNull();
      }),
    );
  });
});
