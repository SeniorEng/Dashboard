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
import { parseStornoReference } from "./budget/phantom-storno";
import { STANDARD_VAT_RATE_BP } from "./invoice-vat";

export type InvoicePotKey = BudgetType | "private";

/** Reihenfolge für deterministische Largest-Remainder-Tiebreaks. */
export const POT_ORDER: ReadonlyArray<InvoicePotKey> = [
  ...BUDGET_TYPES,
  "private",
];

/**
 * Task #1010 — Lesbare deutsche Bezeichnung pro Budget-Topf für die UI
 * (Rechnungs-Split-Hinweis). Single Source of Truth, damit der Vorschau-
 * Hinweis exakt die Töpfe der erzeugten Folge-Rechnungen benennt.
 */
export const POT_DISPLAY_LABELS: Record<InvoicePotKey, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlungsanspruch",
  ersatzpflege_39_42a: "§39/§42a Verhinderungspflege",
  private: "Privat",
};

/** True, wenn der Topf ein echter Selbstzahler-/Privatanteil ist. */
export function isPrivatePot(potKey: InvoicePotKey): boolean {
  return potKey === "private";
}

export interface BudgetSplitForAppointment {
  /** cents pro Pot, summiert aus den `consumption`-Transaktionen. */
  cents: Partial<Record<InvoicePotKey, number>>;
}

/** Mappt einen rohen `budget_type` auf einen Pot-Key (unbekannt → "private"). */
export function toPotKey(budgetType: string): InvoicePotKey {
  return (POT_ORDER as readonly string[]).includes(budgetType)
    ? (budgetType as InvoicePotKey)
    : "private";
}

/** Minimal-Sicht auf eine `consumption`-Ledger-Zeile für den Split. */
export interface SplitConsumptionRow {
  id: number;
  appointmentId: number | null;
  budgetType: string;
  amountCents: number;
}

/** Minimal-Sicht auf eine `reversal`-Ledger-Zeile für den Split. */
export interface SplitReversalRow {
  reversedTransactionId: number | null;
  notes: string | null;
}

/**
 * Task #1012 — Baut den Pot-Split aus den Ledger-Zeilen und schließt dabei
 * Konsumptionen aus, die durch ein Storno wieder zurückgenommen wurden.
 *
 * Hintergrund: `getBudgetSplitForAppointments` las bisher ALLE
 * `consumption`-Zeilen und ignorierte Reversals komplett. Ein Topf, dessen
 * Verbrauch ausschließlich aus stornierten Buchungen besteht (z.B. eine
 * „Phantom-§45a-Aufteilung", die durch ein Storno entstanden ist), erschien
 * dadurch weiterhin im Split und erzeugte eine überflüssige eigene
 * Folge-Rechnung.
 *
 * Eine Konsumption gilt als zurückgenommen, wenn ihre `id`
 *   - von einer VERKNÜPFTEN Reversal-Zeile referenziert wird
 *     (`reversed_transaction_id` gesetzt), ODER
 *   - von einer NOTE-basierten Waisen-Storno-Zeile referenziert wird
 *     („Storno … von Transaktion #<id>", `reversed_transaction_id` NULL) —
 *     beide Fälle werden gemäß der Phantom-Storno-Konvention als echtes
 *     Storno gewertet (vgl. `shared/domain/budget/phantom-storno.ts`).
 *
 * Nur die verbleibenden (lebenden) Konsumptionen fließen in den Split;
 * Töpfe ohne lebende Konsumption tauchen nicht mehr auf.
 */
/**
 * Sammelt die IDs aller Konsumptions-Buchungen, die durch ein Storno wieder
 * zurückgenommen wurden — sowohl über die VERKNÜPFUNG
 * (`reversed_transaction_id`) als auch über NOTE-basierte Waisen-Stornos
 * („Storno … von Transaktion #<id>"). Single Source of Truth für die
 * Storno-Erkennung im Rechnungs-Split UND in der Phantom-Topf-Rechnungs-
 * Diagnose (Task #1016).
 */
export function collectReversedConsumptionIds(
  reversals: SplitReversalRow[],
): Set<number> {
  const reversedConsumptionIds = new Set<number>();
  for (const r of reversals) {
    if (r.reversedTransactionId != null) {
      reversedConsumptionIds.add(r.reversedTransactionId);
    }
    const noteRef = parseStornoReference(r.notes);
    if (noteRef != null) reversedConsumptionIds.add(noteRef);
  }
  return reversedConsumptionIds;
}

export function buildBudgetSplitFromLedger(
  consumptions: SplitConsumptionRow[],
  reversals: SplitReversalRow[],
): Map<number, BudgetSplitForAppointment> {
  const reversedConsumptionIds = collectReversedConsumptionIds(reversals);

  const out = new Map<number, BudgetSplitForAppointment>();
  for (const c of consumptions) {
    if (c.appointmentId == null) continue;
    if (reversedConsumptionIds.has(c.id)) continue; // storniert → nicht abrechnen
    const potKey = toPotKey(c.budgetType);
    const entry = out.get(c.appointmentId) ?? { cents: {} };
    entry.cents[potKey] = (entry.cents[potKey] ?? 0) + Math.abs(c.amountCents);
    out.set(c.appointmentId, entry);
  }
  return out;
}

/**
 * Task #1016 — Phantom-Topf-Rechnungs-Diagnose.
 *
 * Beantwortet die Frage: „Ist der Budget-Topf `potKey` für die übergebenen
 * Konsumptions-/Reversal-Zeilen AUSSCHLIESSLICH durch stornierte Buchungen
 * belegt?" — d.h. es GAB Konsumption in diesem Topf, aber sie wurde komplett
 * zurückgenommen, sodass netto keine lebende Konsumption mehr existiert.
 *
 * Genau dieser Zustand kennzeichnet eine überflüssige, bereits ausgestellte
 * Folge-Rechnung für `potKey` (z.B. die §45a-Phantom-Rechnung im Egon-Uhlig-
 * Fall): Die Rechnung repräsentiert einen Topf, der real (netto) gar nicht
 * mehr belegt ist.
 *
 * Rückgabe:
 *   - `false`, wenn der Topf NIE Konsumption hatte (echte Selbstzahler /
 *     Alt-Daten — keine „stornierte" Belegung, nichts aufzuräumen).
 *   - `false`, solange ≥1 lebende (nicht stornierte) Konsumption im Topf bleibt.
 *   - `true`, nur wenn der Topf Konsumption HATTE und ALLE davon storniert sind.
 *
 * Die Storno-Erkennung nutzt dieselbe SSoT wie der Rechnungs-Split
 * (`collectReversedConsumptionIds`) — verknüpfte UND NOTE-basierte Waisen-Stornos.
 */
export function isPotEntirelyReversed(
  consumptions: SplitConsumptionRow[],
  reversals: SplitReversalRow[],
  potKey: InvoicePotKey,
): boolean {
  const potConsumptions = consumptions.filter(
    (c) => toPotKey(c.budgetType) === potKey,
  );
  if (potConsumptions.length === 0) return false; // nie belegt → nichts zu stornieren
  const reversedIds = collectReversedConsumptionIds(reversals);
  const hasLive = potConsumptions.some((c) => !reversedIds.has(c.id));
  return !hasLive;
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

// ============================================
// BETRAGS-AGGREGATION (Task #1905)
// ============================================

/** Minimal-Sicht einer Rechnungszeile für die Betrags-Aggregation. */
export interface PotAmountItem {
  totalCents: number;
}

export interface PotAmountsResult {
  netCents: number;
  vatCents: number;
  grossCents: number;
  hasPrivateShare: boolean;
  needsBudgetSplit: boolean;
  singlePotIsPrivate: boolean;
}

/**
 * Task #1905 — DIE EINE Aggregation „Topf-Zeilen → Netto/USt/Brutto".
 *
 * ERSETZT die zuvor zweimal ausgeschriebene Rechnung in `buildInvoiceDraft`
 * (Single-Pot-Zweig + Multi-Pot-Schleife) und ist zugleich die Quelle für die
 * IST-Beträge der Karte „Noch zu erstellen". Vorher las die Liste nur
 * `totalNetCents + totalVatCents` aus `buildLineItemsFromAppointments` und
 * verfehlte damit die Reklassifizierung unten — der angezeigte Betrag konnte um
 * bis zu 19 % unter dem liegen, was tatsächlich abgerechnet wird.
 *
 * Die USt-Regel (unverändert, nur an EINE Stelle gezogen):
 *  • Multi-Pot: Kassen-Töpfe 0 %, Privat-Topf 19 % — je Topf gerundet, wie es
 *    die Folge-Rechnungen ausweisen.
 *  • Single-Pot: die zeilenweise gerechnete USt des Zeilen-Bauers, AUSSER der
 *    einzige belegte Topf ist „private" und der Kunde ist kein Selbstzahler
 *    (z. B. Pflegekasse mit `acceptsPrivatePayment` und ausgeschöpftem Topf) —
 *    dann wird auf den Privat-Satz umgerechnet, weil die Rechnung als
 *    Selbstzahler-Rechnung ausgestellt wird.
 *
 * `allowPrivateReclassification` trennt den Rechnungs- vom Anzeige-Pfad: beim
 * Erstellen ist ein Privat-Anteil für einen reinen Kassen-Kunden schon vorher
 * hart gesperrt (`splitLineItemsByPot`, Task #1353), dort ist der Wert also
 * immer `true`. Auf dem Anzeige-Pfad über noch nicht gebuchte Termine kann ein
 * Privat-Topf dagegen allein aus der fehlenden Buchung entstehen — ihm 19 %
 * aufzuschlagen wäre falsch, denn eine fehlende Buchung ist kein Privatanteil.
 *
 * Geld ist ausnahmslos Integer-Cents.
 */
export function summarizePotAmounts(args: {
  potItems: Map<InvoicePotKey, PotAmountItem[]>;
  billingType: string;
  /** Netto-Summe aus dem Zeilen-Bauer (Single-Pot-Basis). */
  builderNetCents: number;
  /** USt-Summe aus dem Zeilen-Bauer (Single-Pot-Basis). */
  builderVatCents: number;
  /** Default `true` (Rechnungs-Pfad). Siehe Docstring. */
  allowPrivateReclassification?: boolean;
}): PotAmountsResult {
  const { potItems, billingType, builderNetCents, builderVatCents } = args;
  const hasPrivateShare = potItems.has("private");
  const needsBudgetSplit = potItems.size > 1;

  if (!needsBudgetSplit) {
    const singlePotIsPrivate = hasPrivateShare && potItems.size === 1;
    const reclassifyToSelbstzahler =
      singlePotIsPrivate &&
      billingType !== "selbstzahler" &&
      (args.allowPrivateReclassification ?? true);
    const vatCents = reclassifyToSelbstzahler
      ? Math.round((builderNetCents * STANDARD_VAT_RATE_BP) / 10000)
      : builderVatCents;
    return {
      netCents: builderNetCents,
      vatCents,
      grossCents: builderNetCents + vatCents,
      hasPrivateShare,
      needsBudgetSplit: false,
      singlePotIsPrivate,
    };
  }

  let netCents = 0;
  let vatCents = 0;
  for (const [pot, items] of potItems) {
    const net = items.reduce((s, i) => s + i.totalCents, 0);
    netCents += net;
    if (pot === "private") {
      vatCents += Math.round((net * STANDARD_VAT_RATE_BP) / 10000);
    }
  }
  return {
    netCents,
    vatCents,
    grossCents: netCents + vatCents,
    hasPrivateShare,
    needsBudgetSplit: true,
    singlePotIsPrivate: false,
  };
}
