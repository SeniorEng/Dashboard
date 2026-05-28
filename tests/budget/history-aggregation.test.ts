/**
 * Pure-Unit-Tests für `aggregateHistoryByMonth` / `sumAllocationView`
 * (`shared/domain/budget/history-aggregation.ts`).
 *
 * Laufen OHNE DB/Server und sind Teil der Stryker-Mutation-Suite (Task #770).
 * Decken Bucketing pro Monat+Topf, die write_off-Asymmetrie zwischen
 * Allocation- und Window-Sicht, Datums-/Typ-Filter, das Ignorieren
 * unbekannter Transaktionstypen und die Sortierung ab.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateHistoryByMonth,
  sumAllocationView,
  type HistoryTxInput,
} from "@shared/domain/budget/history-aggregation";

const tx = (
  budgetType: string,
  transactionDate: string,
  transactionType: HistoryTxInput["transactionType"],
  amountCents: number,
): HistoryTxInput => ({ budgetType, transactionDate, transactionType, amountCents });

describe("aggregateHistoryByMonth — Bucketing & Sichten", () => {
  it("aggregiert pro Monat+Topf und nutzt Math.abs auf die Beträge", () => {
    const out = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-01-05", "consumption", -1000),
      tx("entlastungsbetrag_45b", "2026-01-20", "consumption", 500),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].month).toBe("2026-01");
    expect(out[0].consumptionCents).toBe(1500);
  });

  it("write_off zählt in Allocation-Sicht, NICHT in Window-Sicht", () => {
    const out = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-02-01", "consumption", 2000),
      tx("entlastungsbetrag_45b", "2026-02-02", "write_off", 300),
      tx("entlastungsbetrag_45b", "2026-02-03", "manual_adjustment", 100),
      tx("entlastungsbetrag_45b", "2026-02-04", "reversal", 500),
    ]);
    const b = out[0];
    // Allocation: 2000 + 300 + 100 − 500 = 1900
    expect(b.netUsedAllocationCents).toBe(1900);
    // Window: 2000 − 500 = 1500 (OHNE write_off & manual_adjustment)
    expect(b.netUsedWindowCents).toBe(1500);
  });

  it("trennt verschiedene Töpfe und Monate in eigene Buckets", () => {
    const out = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-01-01", "consumption", 100),
      tx("umwandlung_45a", "2026-01-01", "consumption", 200),
      tx("entlastungsbetrag_45b", "2026-02-01", "consumption", 300),
    ]);
    expect(out).toHaveLength(3);
  });

  it("ignoriert unbekannte Transaktionstypen in allen Sichten", () => {
    const out = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-03-01", "consumption", 1000),
      tx("entlastungsbetrag_45b", "2026-03-02", "mystery_type", 9999),
    ]);
    const b = out[0];
    expect(b.consumptionCents).toBe(1000);
    expect(b.netUsedAllocationCents).toBe(1000);
    expect(b.netUsedWindowCents).toBe(1000);
  });

  it("filtert per from/to (inklusiv) und budgetTypes", () => {
    const txs = [
      tx("entlastungsbetrag_45b", "2026-01-15", "consumption", 100),
      tx("entlastungsbetrag_45b", "2026-02-15", "consumption", 200),
      tx("entlastungsbetrag_45b", "2026-03-15", "consumption", 400),
      tx("umwandlung_45a", "2026-02-15", "consumption", 800),
    ];
    const out = aggregateHistoryByMonth(txs, {
      from: "2026-02-01",
      to: "2026-02-28",
      budgetTypes: ["entlastungsbetrag_45b"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].month).toBe("2026-02");
    expect(out[0].consumptionCents).toBe(200);
  });

  it("überspringt Datumswerte, die kürzer als YYYY-MM sind", () => {
    const out = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-0", "consumption", 100),
      tx("entlastungsbetrag_45b", "2026-04-01", "consumption", 200),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].consumptionCents).toBe(200);
  });

  it("sortiert nach Monat, dann Topf", () => {
    const out = aggregateHistoryByMonth([
      tx("umwandlung_45a", "2026-02-01", "consumption", 1),
      tx("entlastungsbetrag_45b", "2026-02-01", "consumption", 1),
      tx("entlastungsbetrag_45b", "2026-01-01", "consumption", 1),
    ]);
    expect(out.map((b) => `${b.month}/${b.budgetType}`)).toEqual([
      "2026-01/entlastungsbetrag_45b",
      "2026-02/entlastungsbetrag_45b",
      "2026-02/umwandlung_45a",
    ]);
  });
});

describe("sumAllocationView", () => {
  it("summiert die Allocation-Sicht über alle Monate eines Topfs", () => {
    const buckets = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-01-01", "consumption", 1000),
      tx("entlastungsbetrag_45b", "2026-02-01", "consumption", 2000),
      tx("entlastungsbetrag_45b", "2026-02-02", "reversal", 500),
      tx("umwandlung_45a", "2026-01-01", "consumption", 9999),
    ]);
    expect(sumAllocationView(buckets, "entlastungsbetrag_45b")).toBe(2500);
  });

  it("liefert 0 für einen Topf ohne Buchungen", () => {
    const buckets = aggregateHistoryByMonth([
      tx("entlastungsbetrag_45b", "2026-01-01", "consumption", 1000),
    ]);
    expect(sumAllocationView(buckets, "ersatzpflege_39_42a")).toBe(0);
  });
});
