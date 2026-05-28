/**
 * Task #759 — Drift-Detektor: Σ Pot-Anteile = Σ Line-Item-Beträge.
 *
 * Garantie aus `shared/domain/budget-invoice-split.ts`: für JEDEN Termin
 * und für die Gesamtsumme aller Line-Items gilt nach `splitLineItemsAcrossPots`:
 *   Σ shares.totalCents = Σ lineItem.totalCents
 * (kein Cent-Drift durch Largest-Remainder-Rundung).
 *
 * Dieser Test stellt sicher, dass eine Cascade-Rechnung (Σ aller Pot-
 * Rechnungen + Selbstzahler) NIE vom Σ der ursprünglichen Termin-Beträge
 * abweicht — die Wurzel-Invariante des Variant-C-Splits.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  splitLineItemsAcrossPots,
  sumSharesByPot,
  POT_ORDER,
  type BudgetSplitForAppointment,
  type InvoicePotKey,
  type SplitInputItem,
} from "@shared/domain/budget-invoice-split";

describe("invoice per-pot arithmetic (Task #759)", () => {
  it("property: Σ shares.totalCents === Σ item.totalCents", () => {
    fc.assert(
      fc.property(
        // 1–8 Termine pro Lauf.
        fc.array(
          fc.record({
            appointmentId: fc.integer({ min: 1, max: 10_000 }),
            totalCents: fc.integer({ min: 1, max: 50_000 }),
            // Pot-Gewichte (positiv-Integer-Cents aus den consumption-tx).
            kasse45b: fc.integer({ min: 0, max: 30_000 }),
            kasse45a: fc.integer({ min: 0, max: 30_000 }),
            kasse39:  fc.integer({ min: 0, max: 30_000 }),
            priv:     fc.integer({ min: 0, max: 30_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rows) => {
          // Eindeutige IDs erzwingen.
          const items: SplitInputItem[] = rows.map((r, idx) => ({
            appointmentId: r.appointmentId * 100 + idx,
            totalCents: r.totalCents,
          }));
          const splitMap = new Map<number, BudgetSplitForAppointment>();
          rows.forEach((r, idx) => {
            const cents: Partial<Record<InvoicePotKey, number>> = {};
            if (r.kasse45b > 0) cents["entlastungsbetrag_45b"] = r.kasse45b;
            if (r.kasse45a > 0) cents["umwandlung_45a"] = r.kasse45a;
            if (r.kasse39  > 0) cents["ersatzpflege_39_42a"] = r.kasse39;
            if (r.priv     > 0) cents["private"] = r.priv;
            splitMap.set(items[idx].appointmentId, { cents });
          });

          const shares = splitLineItemsAcrossPots(items, splitMap);
          const totalIn = items.reduce((s, i) => s + i.totalCents, 0);
          const totalOut = shares.reduce((s, sh) => s + sh.totalCents, 0);
          expect(totalOut).toBe(totalIn);

          // Pro Termin: Σ shares = item.totalCents
          for (const item of items) {
            const perAppt = shares
              .filter((sh) => sh.item.appointmentId === item.appointmentId)
              .reduce((s, sh) => s + sh.totalCents, 0);
            expect(perAppt).toBe(item.totalCents);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Items ohne Pot-Konsumption landen vollständig im Fallback-Pot", () => {
    const items: SplitInputItem[] = [
      { appointmentId: 1, totalCents: 12345 },
      { appointmentId: 2, totalCents: 6789 },
    ];
    const shares = splitLineItemsAcrossPots(items, new Map());
    expect(shares).toHaveLength(2);
    expect(shares.every((s) => s.potKey === "private")).toBe(true);
    expect(sumSharesByPot(shares)).toEqual({ private: 12345 + 6789 });
  });

  it("Storno (negative Cents): Σ shares = negative Σ items, Vorzeichen erhalten", () => {
    const items: SplitInputItem[] = [
      { appointmentId: 1, totalCents: -10_000 },
    ];
    const split = new Map<number, BudgetSplitForAppointment>([
      [1, { cents: { entlastungsbetrag_45b: 3000, private: 7000 } }],
    ]);
    const shares = splitLineItemsAcrossPots(items, split);
    const total = shares.reduce((s, sh) => s + sh.totalCents, 0);
    expect(total).toBe(-10_000);
    // Beide Pots negativ.
    for (const sh of shares) expect(sh.totalCents).toBeLessThan(0);
  });

  it("POT_ORDER ist deterministisch und enthält 'private' als letzten Eintrag", () => {
    expect(POT_ORDER[POT_ORDER.length - 1]).toBe("private");
    expect(POT_ORDER.length).toBe(4);
  });
});
