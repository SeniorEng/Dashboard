/**
 * Task #773 — Property-Based Drift-Detektor: Storno-Symmetrie.
 *
 * Ergänzt den beispielbasierten Storno-Detektor
 * (`tests/equality/storno-summe-null.test.ts`) und den per-Topf-Split-Detektor
 * (`tests/equality/invoice-per-pot-arithmetic.test.ts`) um einen Property-Test
 * über die echte Split-Domäne (`shared/domain/budget-invoice-split.ts`).
 *
 * Modelliert wird der GoBD-konforme Korrektur-Pfad „Storno + identische
 * Neuanlage" (siehe replit.md → Gotcha „Rechnungs-Line-Item-Mengen"):
 *   1. Buchung   — Termin-Beträge werden per `splitLineItemsAcrossPots` auf
 *                  die N Budget-Töpfe (+ Selbstzahler) aufgeteilt.
 *   2. Storno    — billing.ts kopiert die Line-Items mit invertierten
 *                  Beträgen und splittet erneut (negatives Termin-Total,
 *                  identische Pot-Gewichte).
 *   3. Neuanlage — identische positive Beträge werden erneut gesplittet.
 *
 * Eigenschaft (für ZUFÄLLIGE Termin-/Topf-Szenarien):
 *   - Storno kehrt die Buchung EXAKT um: Σ(Buchung) + Σ(Storno) = 0 — pro
 *     Topf (Pot-Saldo), pro Termin und in der Gesamtsumme (Kunden-Saldo).
 *   - Nach Storno + Neuanlage sind alle Aggregate identisch zum Stand vor dem
 *     Storno: Σ(Buchung + Storno + Neuanlage) = Σ(Buchung).
 *   - Die Neuanlage reproduziert die Buchung deterministisch (gleiche Shares).
 *
 * Da eine Allocation immer zu genau einem Topf gehört, deckt der Pot-Saldo-
 * Vergleich zugleich die Allocation-Used-Symmetrie ab. Der Test mockt nichts —
 * er ruft denselben Split auf, den der Abrechnungslauf und der Storno-Pfad in
 * Produktion verwenden.
 *
 * Nutzt den globalen fast-check-Setup (seed: 42, numRuns: 100 aus
 * `tests/setup.ts`).
 */
// @ts-nocheck

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  splitLineItemsAcrossPots,
  sumSharesByPot,
  type BudgetSplitForAppointment,
  type InvoicePotKey,
  type SplitInputItem,
  type SplitShare,
} from "@shared/domain/budget-invoice-split";

interface ApptSpec {
  totalCents: number;
  kasse45b: number;
  kasse45a: number;
  kasse39: number;
  priv: number;
}

const apptArb = fc.record({
  totalCents: fc.integer({ min: 1, max: 100_000 }),
  kasse45b: fc.integer({ min: 0, max: 30_000 }),
  kasse45a: fc.integer({ min: 0, max: 30_000 }),
  kasse39: fc.integer({ min: 0, max: 30_000 }),
  priv: fc.integer({ min: 0, max: 30_000 }),
});

function buildScenario(rows: ApptSpec[]): {
  items: SplitInputItem[];
  splitMap: Map<number, BudgetSplitForAppointment>;
} {
  const items: SplitInputItem[] = rows.map((r, idx) => ({
    appointmentId: idx + 1,
    totalCents: r.totalCents,
  }));
  const splitMap = new Map<number, BudgetSplitForAppointment>();
  rows.forEach((r, idx) => {
    const cents: Partial<Record<InvoicePotKey, number>> = {};
    if (r.kasse45b > 0) cents["entlastungsbetrag_45b"] = r.kasse45b;
    if (r.kasse45a > 0) cents["umwandlung_45a"] = r.kasse45a;
    if (r.kasse39 > 0) cents["ersatzpflege_39_42a"] = r.kasse39;
    if (r.priv > 0) cents["private"] = r.priv;
    splitMap.set(items[idx].appointmentId, { cents });
  });
  return { items, splitMap };
}

function negate(items: SplitInputItem[]): SplitInputItem[] {
  return items.map((i) => ({ ...i, totalCents: -i.totalCents }));
}

function sumPerAppt(shares: SplitShare<SplitInputItem>[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of shares) {
    out.set(
      s.item.appointmentId,
      (out.get(s.item.appointmentId) ?? 0) + s.totalCents,
    );
  }
  return out;
}

function totalCents(shares: SplitShare<SplitInputItem>[]): number {
  return shares.reduce((s, sh) => s + sh.totalCents, 0);
}

describe("Task #773 — Storno-Symmetrie (Property-Based)", () => {
  it("property: Storno kehrt die Buchung exakt um (Pot-Saldo, Termin, Kunde)", () => {
    fc.assert(
      fc.property(fc.array(apptArb, { minLength: 1, maxLength: 8 }), (rows) => {
        const { items, splitMap } = buildScenario(rows);

        const booking = splitLineItemsAcrossPots(items, splitMap);
        const storno = splitLineItemsAcrossPots(negate(items), splitMap);

        // Pot-Saldo: Σ pro Topf = 0
        const bookByPot = sumSharesByPot(booking);
        const stornoByPot = sumSharesByPot(storno);
        for (const pot of new Set([
          ...Object.keys(bookByPot),
          ...Object.keys(stornoByPot),
        ]) as Set<InvoicePotKey>) {
          expect((bookByPot[pot] ?? 0) + (stornoByPot[pot] ?? 0)).toBe(0);
        }

        // Termin-Saldo: Σ pro appointmentId = 0
        const bookByAppt = sumPerAppt(booking);
        const stornoByAppt = sumPerAppt(storno);
        for (const item of items) {
          expect(
            (bookByAppt.get(item.appointmentId) ?? 0) +
              (stornoByAppt.get(item.appointmentId) ?? 0),
          ).toBe(0);
        }

        // Kunden-Saldo: Gesamtsumme = 0
        expect(totalCents(booking) + totalCents(storno)).toBe(0);
      }),
    );
  });

  it("property: nach Storno + Neuanlage sind alle Aggregate identisch zum Stand davor", () => {
    fc.assert(
      fc.property(fc.array(apptArb, { minLength: 1, maxLength: 8 }), (rows) => {
        const { items, splitMap } = buildScenario(rows);

        const booking = splitLineItemsAcrossPots(items, splitMap);
        const storno = splitLineItemsAcrossPots(negate(items), splitMap);
        const reBooking = splitLineItemsAcrossPots(items, splitMap);

        // Determinismus: Neuanlage reproduziert die Buchung exakt.
        expect(reBooking).toEqual(booking);

        // Σ(Buchung + Storno + Neuanlage) muss Σ(Buchung) entsprechen.
        const before = sumSharesByPot(booking);
        const after = sumSharesByPot([...booking, ...storno, ...reBooking]);
        expect(after).toEqual(before);

        // Gegen-Kontrolle pro Termin.
        const beforeAppt = sumPerAppt(booking);
        const afterAppt = sumPerAppt([...booking, ...storno, ...reBooking]);
        for (const item of items) {
          expect(afterAppt.get(item.appointmentId) ?? 0).toBe(
            beforeAppt.get(item.appointmentId) ?? 0,
          );
        }
      }),
    );
  });
});
