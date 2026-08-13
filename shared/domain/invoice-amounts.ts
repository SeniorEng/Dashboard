/**
 * Task #1905 — Betrags-Aggregation der Rechnung: „Topf-Zeilen → Netto/USt/Brutto".
 *
 * Bewusst ein EIGENES Modul und nicht Teil von `budget-invoice-split.ts`: jenes
 * ist property-getestet und läuft im Command-Mutation-Profil, dessen Runner nur
 * die beiden `tests/equality/*`-Property-Dateien ausführt. Diese Aggregation ist
 * dagegen deterministisch und unit-getestet
 * (`tests/unit/pot-amounts-summary.test.ts`) — sie gehört ins vitest-Profil.
 * Läge sie in der anderen Datei, liefe das Mutations-Gate ihre Mutanten gegen
 * eine Suite, die sie gar nicht aufruft.
 *
 * Geld ist ausnahmslos Integer-Cents.
 */
import type { InvoicePotKey } from "./budget-invoice-split";
import { STANDARD_VAT_RATE_BP } from "./invoice-vat";

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
 * `privatePotIsTaxable` trennt den Rechnungs- vom Anzeige-Pfad und gilt für
 * BEIDE Zweige: er beantwortet die eine Frage „ist dieser Privat-Topf ein
 * echter Privatanteil?". Beim Erstellen ist ein Privat-Anteil für einen reinen
 * Kassen-Kunden schon vorher hart gesperrt (`splitLineItemsByPot`, Task #1353),
 * dort ist der Wert also immer `true`. Auf dem Anzeige-Pfad über noch nicht
 * gebuchte Termine kann ein Privat-Topf dagegen allein aus der fehlenden Buchung
 * entstehen (Fallback-Topf) — ihm 19 % aufzuschlagen wäre falsch, denn eine
 * fehlende Buchung ist kein Privatanteil.
 *
 * Der Multi-Pot-Zweig hat das zunächst NICHT berücksichtigt und den Privat-Topf
 * bedingungslos besteuert. Für einen reinen Kassen-Kunden mit Kassen-Topf PLUS
 * Fallback-Überhang wies die Liste damit USt aus, die keine Rechnung je
 * ausweisen kann (die Erstellung bricht für ihn am #1353-Backstop ab) — also
 * genau in dem Fall, für den das Flag gebaut wurde.
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
  /** Default `true` (Rechnungs-Pfad). Gilt für BEIDE Zweige, siehe Docstring. */
  privatePotIsTaxable?: boolean;
}): PotAmountsResult {
  const { potItems, billingType, builderNetCents, builderVatCents } = args;
  const hasPrivateShare = potItems.has("private");
  const needsBudgetSplit = potItems.size > 1;

  if (!needsBudgetSplit) {
    const singlePotIsPrivate = hasPrivateShare && potItems.size === 1;
    const reclassifyToSelbstzahler =
      singlePotIsPrivate &&
      billingType !== "selbstzahler" &&
      (args.privatePotIsTaxable ?? true);
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

  const privateTaxable = args.privatePotIsTaxable ?? true;
  let netCents = 0;
  let vatCents = 0;
  for (const [pot, items] of potItems) {
    const net = items.reduce((s, i) => s + i.totalCents, 0);
    netCents += net;
    if (pot === "private" && privateTaxable) {
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
