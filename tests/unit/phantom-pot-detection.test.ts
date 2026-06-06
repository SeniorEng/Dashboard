/**
 * Task #1016 — Reine Tests der Phantom-Topf-Erkennung
 * (`isPotEntirelyReversed` / `collectReversedConsumptionIds`).
 *
 * Eine „Phantom-Topf-Rechnung" repräsentiert einen Budget-Topf, dessen
 * Konsumption für die Rechnungs-Termine VOLLSTÄNDIG storniert wurde — netto
 * bleibt keine lebende Konsumption. Diese Tests sichern die genaue Semantik:
 *   - nie belegter Topf ⇒ NICHT phantom (echter Selbstzahler/Bestand),
 *   - ≥1 lebende Konsumption ⇒ NICHT phantom,
 *   - komplett storniert (verknüpft ODER NOTE-basierter Waisen-Storno) ⇒ phantom,
 *   - Stornos anderer Töpfe lassen den Topf unberührt.
 */
import { describe, it, expect } from "vitest";
import {
  isPotEntirelyReversed,
  collectReversedConsumptionIds,
  type SplitConsumptionRow,
  type SplitReversalRow,
} from "@shared/domain/budget-invoice-split";

const c = (
  id: number,
  budgetType: string,
  amountCents: number,
  appointmentId: number | null = 1,
): SplitConsumptionRow => ({ id, appointmentId, budgetType, amountCents });

const linkedReversal = (reversedTransactionId: number): SplitReversalRow => ({
  reversedTransactionId,
  notes: null,
});

const noteReversal = (origId: number): SplitReversalRow => ({
  reversedTransactionId: null,
  notes: `Storno der Buchung von Transaktion #${origId}`,
});

describe("collectReversedConsumptionIds", () => {
  it("sammelt verknüpfte UND NOTE-basierte Waisen-Stornos", () => {
    const ids = collectReversedConsumptionIds([
      linkedReversal(10),
      noteReversal(20),
      { reversedTransactionId: null, notes: "kein Storno-Marker" },
    ]);
    expect([...ids].sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it("liefert leeres Set ohne Reversals", () => {
    expect(collectReversedConsumptionIds([]).size).toBe(0);
  });
});

describe("isPotEntirelyReversed", () => {
  it("false, wenn der Topf nie Konsumption hatte", () => {
    const consumptions = [c(1, "entlastungsbetrag_45b", -5000)];
    expect(isPotEntirelyReversed(consumptions, [], "umwandlung_45a")).toBe(false);
  });

  it("false, solange eine lebende Konsumption im Topf bleibt", () => {
    const consumptions = [
      c(1, "umwandlung_45a", -5000),
      c(2, "umwandlung_45a", -3000),
    ];
    // nur eine der beiden storniert
    expect(isPotEntirelyReversed(consumptions, [linkedReversal(1)], "umwandlung_45a")).toBe(false);
  });

  it("true, wenn ALLE Konsumptionen des Topfes verknüpft storniert sind", () => {
    const consumptions = [
      c(1, "umwandlung_45a", -5000),
      c(2, "umwandlung_45a", -3000),
    ];
    const reversals = [linkedReversal(1), linkedReversal(2)];
    expect(isPotEntirelyReversed(consumptions, reversals, "umwandlung_45a")).toBe(true);
  });

  it("true auch bei NOTE-basiertem Waisen-Storno", () => {
    const consumptions = [c(7, "umwandlung_45a", -5000)];
    expect(isPotEntirelyReversed(consumptions, [noteReversal(7)], "umwandlung_45a")).toBe(true);
  });

  it("§45a phantom, während §45b im selben Termin lebendig bleibt (Egon-Uhlig-Fall)", () => {
    const consumptions = [
      c(1, "umwandlung_45a", -5000), // wird storniert
      c(2, "entlastungsbetrag_45b", -13100), // bleibt lebendig
    ];
    const reversals = [linkedReversal(1)];
    expect(isPotEntirelyReversed(consumptions, reversals, "umwandlung_45a")).toBe(true);
    expect(isPotEntirelyReversed(consumptions, reversals, "entlastungsbetrag_45b")).toBe(false);
  });

  it("Storno eines fremden Topfes lässt den Zieltopf unberührt", () => {
    const consumptions = [
      c(1, "umwandlung_45a", -5000),
      c(2, "entlastungsbetrag_45b", -3000),
    ];
    // Reversal verweist auf §45b-Konsumption — §45a bleibt lebendig
    expect(isPotEntirelyReversed(consumptions, [linkedReversal(2)], "umwandlung_45a")).toBe(false);
  });
});
