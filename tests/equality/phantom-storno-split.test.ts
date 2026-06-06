/**
 * Task #1012 — Drift-Detektor: ein Budget-Topf, dessen Konsumption
 * ausschließlich aus stornierten/reversierten Buchungen besteht, darf nicht
 * mehr im Rechnungs-Split auftauchen (und erzeugt damit keine überflüssige
 * eigene Folge-Rechnung).
 *
 * Reproduziert den Egon-Uhlig-Fall: ein Termin verbraucht §45b (lebend) UND
 * §45a, wobei der §45a-Anteil nur durch eine stornierte Buchung ("Phantom-
 * §45a-Aufteilung") entstanden ist. Vorher tauchte §45a weiterhin im Split auf
 * → 2 Pots → 2 Rechnungen. Jetzt: §45a fällt raus → 1 Pot → 1 Rechnung.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildBudgetSplitFromLedger,
  splitLineItemsAcrossPots,
  sumSharesByPot,
  type SplitConsumptionRow,
  type SplitReversalRow,
  type SplitInputItem,
} from "@shared/domain/budget-invoice-split";

describe("phantom-storno split exclusion (Task #1012)", () => {
  it("verknüpftes Storno (§45a) → nur lebender §45b-Pot bleibt", () => {
    const consumptions: SplitConsumptionRow[] = [
      { id: 1, appointmentId: 100, budgetType: "entlastungsbetrag_45b", amountCents: -3000 },
      { id: 2, appointmentId: 100, budgetType: "umwandlung_45a", amountCents: -2000 },
    ];
    const reversals: SplitReversalRow[] = [
      { reversedTransactionId: 2, notes: "Storno von Transaktion #2" },
    ];

    const split = buildBudgetSplitFromLedger(consumptions, reversals);
    expect(split.get(100)?.cents).toEqual({ entlastungsbetrag_45b: 3000 });

    // Single-Pot → kein Mehrtopf-Split.
    const items: SplitInputItem[] = [{ appointmentId: 100, totalCents: 3000 }];
    const shares = splitLineItemsAcrossPots(items, split);
    expect(sumSharesByPot(shares)).toEqual({ entlastungsbetrag_45b: 3000 });
  });

  it("NOTE-basierte Waisen-Storno-Zeile (reversedTransactionId NULL) wird als Storno gewertet", () => {
    const consumptions: SplitConsumptionRow[] = [
      { id: 10, appointmentId: 200, budgetType: "entlastungsbetrag_45b", amountCents: -4000 },
      { id: 11, appointmentId: 200, budgetType: "umwandlung_45a", amountCents: -1500 },
    ];
    const reversals: SplitReversalRow[] = [
      { reversedTransactionId: null, notes: "Storno (Reconcile #42) von Transaktion #11" },
    ];

    const split = buildBudgetSplitFromLedger(consumptions, reversals);
    expect(split.get(200)?.cents).toEqual({ entlastungsbetrag_45b: 4000 });
  });

  it("Termin mit ausschließlich stornierter Konsumption fällt komplett aus dem Split (→ Fallback private)", () => {
    const consumptions: SplitConsumptionRow[] = [
      { id: 20, appointmentId: 300, budgetType: "umwandlung_45a", amountCents: -2500 },
    ];
    const reversals: SplitReversalRow[] = [
      { reversedTransactionId: 20, notes: "Storno von Transaktion #20" },
    ];

    const split = buildBudgetSplitFromLedger(consumptions, reversals);
    expect(split.has(300)).toBe(false);

    // Line-Item fällt in den Fallback-Pot (Selbstzahler), statt eine eigene
    // §45a-Rechnung zu erzeugen.
    const items: SplitInputItem[] = [{ appointmentId: 300, totalCents: 2500 }];
    const shares = splitLineItemsAcrossPots(items, split);
    expect(sumSharesByPot(shares)).toEqual({ private: 2500 });
  });

  it("ohne Storno bleibt der Mehrtopf-Split unverändert (kein Regress)", () => {
    const consumptions: SplitConsumptionRow[] = [
      { id: 30, appointmentId: 400, budgetType: "entlastungsbetrag_45b", amountCents: -3000 },
      { id: 31, appointmentId: 400, budgetType: "umwandlung_45a", amountCents: -2000 },
    ];
    const split = buildBudgetSplitFromLedger(consumptions, []);
    expect(split.get(400)?.cents).toEqual({
      entlastungsbetrag_45b: 3000,
      umwandlung_45a: 2000,
    });
  });

  it("property: jeder Pot im Split hat ≥1 lebende (nicht-stornierte) Konsumption", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 100_000 }),
            appointmentId: fc.integer({ min: 1, max: 50 }),
            budgetType: fc.constantFrom(
              "entlastungsbetrag_45b",
              "umwandlung_45a",
              "ersatzpflege_39_42a",
              "private",
            ),
            amountCents: fc.integer({ min: 1, max: 20_000 }).map((c) => -c),
            reversed: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (rawRows) => {
          // Eindeutige IDs erzwingen.
          const rows = rawRows.map((r, idx) => ({ ...r, id: r.id * 100 + idx }));
          const consumptions: SplitConsumptionRow[] = rows.map((r) => ({
            id: r.id,
            appointmentId: r.appointmentId,
            budgetType: r.budgetType,
            amountCents: r.amountCents,
          }));
          const reversals: SplitReversalRow[] = rows
            .filter((r) => r.reversed)
            .map((r) => ({
              reversedTransactionId: r.id,
              notes: `Storno von Transaktion #${r.id}`,
            }));
          const reversedIds = new Set(reversals.map((r) => r.reversedTransactionId));

          const split = buildBudgetSplitFromLedger(consumptions, reversals);

          // Re-derive erwartete Pot-Summen aus den lebenden Zeilen.
          const expected = new Map<number, Map<string, number>>();
          for (const r of rows) {
            if (reversedIds.has(r.id)) continue;
            const m = expected.get(r.appointmentId) ?? new Map<string, number>();
            m.set(r.budgetType, (m.get(r.budgetType) ?? 0) + Math.abs(r.amountCents));
            expected.set(r.appointmentId, m);
          }

          // Jeder Pot im Output muss positive lebende Konsumption haben.
          for (const [apptId, entry] of split) {
            for (const [pot, cents] of Object.entries(entry.cents)) {
              expect(cents).toBeGreaterThan(0);
              expect(expected.get(apptId)?.get(pot)).toBe(cents);
            }
          }
          // Kein erwarteter Pot fehlt.
          for (const [apptId, m] of expected) {
            for (const [pot, cents] of m) {
              const actual = (split.get(apptId)?.cents as Record<string, number> | undefined)?.[pot] ?? 0;
              expect(actual).toBe(cents);
            }
          }
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });
});
