/**
 * Task #759 — Variant C: Rechnungs-Split pro Budget-Topf.
 *
 * Pure, deterministische Aufteilung der Line-Items eines Abrechnungslaufs
 * auf die N Budget-Töpfe (`entlastungsbetrag_45b`, `umwandlung_45a`,
 * `ersatzpflege_39_42a`) und den Selbstzahler-Pot (`"private"`).
 *
 * Garantien
 * ---------
 * 1. Σ der Anteile pro Termin = `item.totalCents` für jeden Termin —
 *    es gibt KEINEN Cent-Drift gegenüber den ursprünglichen Line-Item-
 *    Beträgen. Realisiert via Largest-Remainder-Rundung (Hare-Quote) und
 *    deterministischem Tiebreak (Pot-Reihenfolge in `POT_ORDER`).
 *
 * 2. Σ über alle Pot-Rechnungen + Selbstzahler-Pot = Σ
 *    `appointment.totalCents` (Drift-Detektor in
 *    `tests/equality/invoice-per-pot-arithmetic.test.ts`).
 *
 * 3. Buchungs-Konsistenz: die Verteilung folgt 1:1 den `budget_transactions`
 *    (consumption) des jeweiligen Termins; der Split repräsentiert NICHT
 *    den theoretischen Cap-Verlauf, sondern was tatsächlich gebucht wurde.
 */

import type { BudgetType } from "./budgets";
import { BUDGET_TYPES } from "./budgets";

export type InvoicePotKey = BudgetType | "private";

/** Reihenfolge für deterministische Largest-Remainder-Tiebreaks. */
export const POT_ORDER: ReadonlyArray<InvoicePotKey> = [
  ...BUDGET_TYPES,
  "private",
];

export interface BudgetSplitForAppointment {
  /** cents pro Pot, summiert aus den `consumption`-Transaktionen. */
  cents: Partial<Record<InvoicePotKey, number>>;
}

export interface SplitInputItem {
  appointmentId: number;
  totalCents: number;
}

export interface SplitShare<T extends SplitInputItem> {
  potKey: InvoicePotKey;
  item: T;
  /** Anteil dieses Items am `potKey`-Topf in Cent (immer ganzzahlig). */
  totalCents: number;
}

/**
 * Verteilt ein einzelnes Line-Item auf die N Pots gemäß der Anteils-
 * Gewichte aus `weights`. Σ Output-Cents = `itemTotalCents`.
 *
 * Largest-Remainder: erst `Math.floor(item * w_i / Σw)`, dann Resttropfen
 * an die Pots mit dem größten Bruchteil (Tiebreak: `POT_ORDER`).
 */
function distributeWithLargestRemainder(
  itemTotalCents: number,
  weights: Partial<Record<InvoicePotKey, number>>,
): Partial<Record<InvoicePotKey, number>> {
  const positivePots: InvoicePotKey[] = POT_ORDER.filter(
    (p) => (weights[p] ?? 0) > 0,
  );
  if (positivePots.length === 0) return {};

  const totalWeight = positivePots.reduce((s, p) => s + (weights[p] ?? 0), 0);
  if (totalWeight <= 0) return {};

  const out: Partial<Record<InvoicePotKey, number>> = {};
  const remainders: Array<{ pot: InvoicePotKey; rem: number; order: number }> = [];
  let assigned = 0;

  for (const pot of positivePots) {
    const w = weights[pot] ?? 0;
    const exact = (itemTotalCents * w) / totalWeight;
    const base = itemTotalCents >= 0 ? Math.floor(exact) : Math.ceil(exact);
    out[pot] = base;
    assigned += base;
    remainders.push({
      pot,
      rem: exact - base,
      order: POT_ORDER.indexOf(pot),
    });
  }

  let diff = itemTotalCents - assigned;
  if (diff !== 0) {
    // Bei positivem Total: größte positive Reste zuerst; bei negativem Total
    // (Storno) sind alle Reste ≤0, wir nehmen die "kleinsten" (am dichtesten
    // an 0) zuerst — beides läuft auf eine deterministische Sortierung
    // |rem| desc, dann POT_ORDER, raus.
    remainders.sort(
      (a, b) => Math.abs(b.rem) - Math.abs(a.rem) || a.order - b.order,
    );
    const step = diff > 0 ? 1 : -1;
    let i = 0;
    while (diff !== 0 && remainders.length > 0) {
      const tgt = remainders[i % remainders.length];
      out[tgt.pot] = (out[tgt.pot] ?? 0) + step;
      diff -= step;
      i++;
    }
  }

  // Null-Einträge raus, damit der Aufrufer leichter filtern kann.
  for (const pot of positivePots) {
    if (out[pot] === 0) delete out[pot];
  }
  return out;
}

/**
 * Splittet alle Line-Items auf die Pots auf. Items zu Terminen ohne
 * Pot-Konsumption (kein Budget-Mapping vorhanden) landen unter
 * `"private"` — das spiegelt das Bestandsverhalten (Selbstzahler-
 * Default für nicht-kassenkonsumierte Leistungen) wider.
 */
export function splitLineItemsAcrossPots<T extends SplitInputItem>(
  lineItems: T[],
  budgetSplitPerAppt: Map<number, BudgetSplitForAppointment>,
  options: { fallbackPot?: InvoicePotKey } = {},
): SplitShare<T>[] {
  const fallbackPot = options.fallbackPot ?? "private";
  const out: SplitShare<T>[] = [];

  for (const item of lineItems) {
    const split = budgetSplitPerAppt.get(item.appointmentId);
    if (!split || Object.keys(split.cents).length === 0) {
      out.push({ potKey: fallbackPot, item, totalCents: item.totalCents });
      continue;
    }
    const shares = distributeWithLargestRemainder(item.totalCents, split.cents);
    for (const pot of POT_ORDER) {
      const cents = shares[pot];
      if (cents == null || cents === 0) continue;
      out.push({ potKey: pot, item, totalCents: cents });
    }
  }

  return out;
}

/** Aggregiert die Pot-Shares zurück in „Σ pro Pot". */
export function sumSharesByPot<T extends SplitInputItem>(
  shares: SplitShare<T>[],
): Partial<Record<InvoicePotKey, number>> {
  const out: Partial<Record<InvoicePotKey, number>> = {};
  for (const s of shares) {
    out[s.potKey] = (out[s.potKey] ?? 0) + s.totalCents;
  }
  return out;
}
