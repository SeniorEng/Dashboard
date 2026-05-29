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
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import type { BudgetType } from "./budgets";
import { BUDGET_TYPES } from "./budgets";
export type InvoicePotKey = BudgetType | "private";

/** Reihenfolge für deterministische Largest-Remainder-Tiebreaks. */
export const POT_ORDER: ReadonlyArray<InvoicePotKey> = stryMutAct_9fa48("0") ? [] : (stryCov_9fa48("0"), [...BUDGET_TYPES, stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), "private")]);
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
function distributeWithLargestRemainder(itemTotalCents: number, weights: Partial<Record<InvoicePotKey, number>>): Partial<Record<InvoicePotKey, number>> {
  if (stryMutAct_9fa48("2")) {
    {}
  } else {
    stryCov_9fa48("2");
    const positivePots: InvoicePotKey[] = stryMutAct_9fa48("3") ? POT_ORDER : (stryCov_9fa48("3"), POT_ORDER.filter(stryMutAct_9fa48("4") ? () => undefined : (stryCov_9fa48("4"), p => stryMutAct_9fa48("8") ? (weights[p] ?? 0) <= 0 : stryMutAct_9fa48("7") ? (weights[p] ?? 0) >= 0 : stryMutAct_9fa48("6") ? false : stryMutAct_9fa48("5") ? true : (stryCov_9fa48("5", "6", "7", "8"), (stryMutAct_9fa48("9") ? weights[p] && 0 : (stryCov_9fa48("9"), weights[p] ?? 0)) > 0))));
    if (stryMutAct_9fa48("12") ? positivePots.length !== 0 : stryMutAct_9fa48("11") ? false : stryMutAct_9fa48("10") ? true : (stryCov_9fa48("10", "11", "12"), positivePots.length === 0)) return {};
    const totalWeight = positivePots.reduce(stryMutAct_9fa48("13") ? () => undefined : (stryCov_9fa48("13"), (s, p) => stryMutAct_9fa48("14") ? s - (weights[p] ?? 0) : (stryCov_9fa48("14"), s + (stryMutAct_9fa48("15") ? weights[p] && 0 : (stryCov_9fa48("15"), weights[p] ?? 0)))), 0);
    if (stryMutAct_9fa48("19") ? totalWeight > 0 : stryMutAct_9fa48("18") ? totalWeight < 0 : stryMutAct_9fa48("17") ? false : stryMutAct_9fa48("16") ? true : (stryCov_9fa48("16", "17", "18", "19"), totalWeight <= 0)) return {};
    const out: Partial<Record<InvoicePotKey, number>> = {};
    const remainders: Array<{
      pot: InvoicePotKey;
      rem: number;
      order: number;
    }> = stryMutAct_9fa48("20") ? ["Stryker was here"] : (stryCov_9fa48("20"), []);
    let assigned = 0;
    for (const pot of positivePots) {
      if (stryMutAct_9fa48("21")) {
        {}
      } else {
        stryCov_9fa48("21");
        const w = stryMutAct_9fa48("22") ? weights[pot] && 0 : (stryCov_9fa48("22"), weights[pot] ?? 0);
        const exact = stryMutAct_9fa48("23") ? itemTotalCents * w * totalWeight : (stryCov_9fa48("23"), (stryMutAct_9fa48("24") ? itemTotalCents / w : (stryCov_9fa48("24"), itemTotalCents * w)) / totalWeight);
        const base = (stryMutAct_9fa48("28") ? itemTotalCents < 0 : stryMutAct_9fa48("27") ? itemTotalCents > 0 : stryMutAct_9fa48("26") ? false : stryMutAct_9fa48("25") ? true : (stryCov_9fa48("25", "26", "27", "28"), itemTotalCents >= 0)) ? Math.floor(exact) : Math.ceil(exact);
        out[pot] = base;
        stryMutAct_9fa48("29") ? assigned -= base : (stryCov_9fa48("29"), assigned += base);
        remainders.push(stryMutAct_9fa48("30") ? {} : (stryCov_9fa48("30"), {
          pot,
          rem: stryMutAct_9fa48("31") ? exact + base : (stryCov_9fa48("31"), exact - base),
          order: POT_ORDER.indexOf(pot)
        }));
      }
    }
    let diff = stryMutAct_9fa48("32") ? itemTotalCents + assigned : (stryCov_9fa48("32"), itemTotalCents - assigned);
    if (stryMutAct_9fa48("35") ? diff === 0 : stryMutAct_9fa48("34") ? false : stryMutAct_9fa48("33") ? true : (stryCov_9fa48("33", "34", "35"), diff !== 0)) {
      if (stryMutAct_9fa48("36")) {
        {}
      } else {
        stryCov_9fa48("36");
        // Bei positivem Total: größte positive Reste zuerst; bei negativem Total
        // (Storno) sind alle Reste ≤0, wir nehmen die "kleinsten" (am dichtesten
        // an 0) zuerst — beides läuft auf eine deterministische Sortierung
        // |rem| desc, dann POT_ORDER, raus.
        stryMutAct_9fa48("37") ? remainders : (stryCov_9fa48("37"), remainders.sort(stryMutAct_9fa48("38") ? () => undefined : (stryCov_9fa48("38"), (a, b) => stryMutAct_9fa48("41") ? Math.abs(b.rem) - Math.abs(a.rem) && a.order - b.order : stryMutAct_9fa48("40") ? false : stryMutAct_9fa48("39") ? true : (stryCov_9fa48("39", "40", "41"), (stryMutAct_9fa48("42") ? Math.abs(b.rem) + Math.abs(a.rem) : (stryCov_9fa48("42"), Math.abs(b.rem) - Math.abs(a.rem))) || (stryMutAct_9fa48("43") ? a.order + b.order : (stryCov_9fa48("43"), a.order - b.order))))));
        const step = (stryMutAct_9fa48("47") ? diff <= 0 : stryMutAct_9fa48("46") ? diff >= 0 : stryMutAct_9fa48("45") ? false : stryMutAct_9fa48("44") ? true : (stryCov_9fa48("44", "45", "46", "47"), diff > 0)) ? 1 : stryMutAct_9fa48("48") ? +1 : (stryCov_9fa48("48"), -1);
        let i = 0;
        while (stryMutAct_9fa48("50") ? diff !== 0 || remainders.length > 0 : stryMutAct_9fa48("49") ? false : (stryCov_9fa48("49", "50"), (stryMutAct_9fa48("52") ? diff === 0 : stryMutAct_9fa48("51") ? true : (stryCov_9fa48("51", "52"), diff !== 0)) && (stryMutAct_9fa48("55") ? remainders.length <= 0 : stryMutAct_9fa48("54") ? remainders.length >= 0 : stryMutAct_9fa48("53") ? true : (stryCov_9fa48("53", "54", "55"), remainders.length > 0)))) {
          if (stryMutAct_9fa48("56")) {
            {}
          } else {
            stryCov_9fa48("56");
            const tgt = remainders[stryMutAct_9fa48("57") ? i * remainders.length : (stryCov_9fa48("57"), i % remainders.length)];
            out[tgt.pot] = stryMutAct_9fa48("58") ? (out[tgt.pot] ?? 0) - step : (stryCov_9fa48("58"), (stryMutAct_9fa48("59") ? out[tgt.pot] && 0 : (stryCov_9fa48("59"), out[tgt.pot] ?? 0)) + step);
            stryMutAct_9fa48("60") ? diff += step : (stryCov_9fa48("60"), diff -= step);
            stryMutAct_9fa48("61") ? i-- : (stryCov_9fa48("61"), i++);
          }
        }
      }
    }

    // Null-Einträge raus, damit der Aufrufer leichter filtern kann.
    for (const pot of positivePots) {
      if (stryMutAct_9fa48("62")) {
        {}
      } else {
        stryCov_9fa48("62");
        if (stryMutAct_9fa48("65") ? out[pot] !== 0 : stryMutAct_9fa48("64") ? false : stryMutAct_9fa48("63") ? true : (stryCov_9fa48("63", "64", "65"), out[pot] === 0)) delete out[pot];
      }
    }
    return out;
  }
}

/**
 * Splittet alle Line-Items auf die Pots auf. Items zu Terminen ohne
 * Pot-Konsumption (kein Budget-Mapping vorhanden) landen unter
 * `"private"` — das spiegelt das Bestandsverhalten (Selbstzahler-
 * Default für nicht-kassenkonsumierte Leistungen) wider.
 */
export function splitLineItemsAcrossPots<T extends SplitInputItem>(lineItems: T[], budgetSplitPerAppt: Map<number, BudgetSplitForAppointment>, options: {
  fallbackPot?: InvoicePotKey;
} = {}): SplitShare<T>[] {
  if (stryMutAct_9fa48("66")) {
    {}
  } else {
    stryCov_9fa48("66");
    const fallbackPot = stryMutAct_9fa48("67") ? options.fallbackPot && "private" : (stryCov_9fa48("67"), options.fallbackPot ?? (stryMutAct_9fa48("68") ? "" : (stryCov_9fa48("68"), "private")));
    const out: SplitShare<T>[] = stryMutAct_9fa48("69") ? ["Stryker was here"] : (stryCov_9fa48("69"), []);
    for (const item of lineItems) {
      if (stryMutAct_9fa48("70")) {
        {}
      } else {
        stryCov_9fa48("70");
        const split = budgetSplitPerAppt.get(item.appointmentId);
        if (stryMutAct_9fa48("73") ? !split && Object.keys(split.cents).length === 0 : stryMutAct_9fa48("72") ? false : stryMutAct_9fa48("71") ? true : (stryCov_9fa48("71", "72", "73"), (stryMutAct_9fa48("74") ? split : (stryCov_9fa48("74"), !split)) || (stryMutAct_9fa48("76") ? Object.keys(split.cents).length !== 0 : stryMutAct_9fa48("75") ? false : (stryCov_9fa48("75", "76"), Object.keys(split.cents).length === 0)))) {
          if (stryMutAct_9fa48("77")) {
            {}
          } else {
            stryCov_9fa48("77");
            out.push(stryMutAct_9fa48("78") ? {} : (stryCov_9fa48("78"), {
              potKey: fallbackPot,
              item,
              totalCents: item.totalCents
            }));
            continue;
          }
        }
        const shares = distributeWithLargestRemainder(item.totalCents, split.cents);
        for (const pot of POT_ORDER) {
          if (stryMutAct_9fa48("79")) {
            {}
          } else {
            stryCov_9fa48("79");
            const cents = shares[pot];
            if (stryMutAct_9fa48("82") ? cents == null && cents === 0 : stryMutAct_9fa48("81") ? false : stryMutAct_9fa48("80") ? true : (stryCov_9fa48("80", "81", "82"), (stryMutAct_9fa48("84") ? cents != null : stryMutAct_9fa48("83") ? false : (stryCov_9fa48("83", "84"), cents == null)) || (stryMutAct_9fa48("86") ? cents !== 0 : stryMutAct_9fa48("85") ? false : (stryCov_9fa48("85", "86"), cents === 0)))) continue;
            out.push(stryMutAct_9fa48("87") ? {} : (stryCov_9fa48("87"), {
              potKey: pot,
              item,
              totalCents: cents
            }));
          }
        }
      }
    }
    return out;
  }
}

/** Aggregiert die Pot-Shares zurück in „Σ pro Pot". */
export function sumSharesByPot<T extends SplitInputItem>(shares: SplitShare<T>[]): Partial<Record<InvoicePotKey, number>> {
  if (stryMutAct_9fa48("88")) {
    {}
  } else {
    stryCov_9fa48("88");
    const out: Partial<Record<InvoicePotKey, number>> = {};
    for (const s of shares) {
      if (stryMutAct_9fa48("89")) {
        {}
      } else {
        stryCov_9fa48("89");
        out[s.potKey] = stryMutAct_9fa48("90") ? (out[s.potKey] ?? 0) - s.totalCents : (stryCov_9fa48("90"), (stryMutAct_9fa48("91") ? out[s.potKey] && 0 : (stryCov_9fa48("91"), out[s.potKey] ?? 0)) + s.totalCents);
      }
    }
    return out;
  }
}