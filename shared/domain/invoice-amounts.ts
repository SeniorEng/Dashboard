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
import { ustJeSatz, ustSatzBP, type UstGruppe, type UstPosition } from "./invoice-vat";

/** Sicht einer Rechnungszeile für Betrag und USt-Entscheidung (Tabelle D). */
export interface PotAmountItem extends UstPosition {
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
 * Die USt EINES Topfs (= einer Folge-Rechnung): Satz je Position nach
 * Tabelle D, Summe je Satz gerundet. Rechnungserstellung (`invoice-calc.ts`)
 * und Anzeige (`summarizePotAmounts`) rufen dieselbe Funktion — die Positionen
 * tragen den Satz danach als `vatRateBp` in die gespeicherte Zeile.
 *
 * `privatePotIsTaxable === false`: Privat-Topf, der nur aus einer fehlenden
 * Buchung entstand (Anzeige-Pfad) — keine USt (siehe `summarizePotAmounts`).
 */
export function ustFuerTopf<T extends PotAmountItem>(
  pot: InvoicePotKey,
  items: readonly T[],
  opts: { privatePotIsTaxable?: boolean } = {},
): { items: Array<T & { vatRateBp: number }>; gruppen: UstGruppe[]; netCents: number; vatCents: number } {
  const topf = {
    kassenTopf: pot !== "private",
    privatTopfSteuerbar: pot === "private" ? (opts.privatePotIsTaxable ?? true) : true,
  };
  const mitSatz = items.map((i) => ({ ...i, vatRateBp: ustSatzBP(i, topf) }));
  const { gruppen, ustCents } = ustJeSatz(mitSatz);
  return {
    items: mitSatz,
    gruppen,
    netCents: mitSatz.reduce((n, i) => n + i.totalCents, 0),
    vatCents: ustCents,
  };
}

/**
 * Task #1905 — DIE EINE Aggregation „Topf-Zeilen → Netto/USt/Brutto", Quelle
 * für die Rechnung (`buildInvoiceDraft`) und für die IST-Beträge der Karte
 * „Noch zu erstellen".
 *
 * Die USt kommt je Topf aus `ustFuerTopf` (Tabelle D, § 4 Nr. 16 g UStG).
 * ERSETZT die frühere Zahlertyp-Regel (Kassen-Töpfe 0 %, Privat-Topf 19 %;
 * im Einzeltopf die zeilenweise USt des Zeilen-Bauers mit Reklassifizierung
 * auf 19 %) samt den Parametern `builderNetCents`/`builderVatCents` — der
 * Zeilen-Bauer rechnet keine USt mehr.
 *
 * `privatePotIsTaxable` trennt den Rechnungs- vom Anzeige-Pfad: beim Erstellen
 * ist ein Privat-Anteil für einen reinen Kassen-Kunden schon vorher hart
 * gesperrt (`splitLineItemsByPot`, Task #1353), dort ist der Wert immer
 * `true`. Auf dem Anzeige-Pfad kann ein Privat-Topf allein aus der fehlenden
 * Buchung entstehen (Fallback-Topf) — ihm USt aufzuschlagen wäre falsch.
 *
 * Geld ist ausnahmslos Integer-Cents.
 */
export function summarizePotAmounts(args: {
  potItems: Map<InvoicePotKey, PotAmountItem[]>;
  billingType: string;
  /** Default `true` (Rechnungs-Pfad). */
  privatePotIsTaxable?: boolean;
}): PotAmountsResult {
  const { potItems } = args;
  const hasPrivateShare = potItems.has("private");
  const needsBudgetSplit = potItems.size > 1;
  let netCents = 0;
  let vatCents = 0;
  for (const [pot, items] of potItems) {
    const t = ustFuerTopf(pot, items, { privatePotIsTaxable: args.privatePotIsTaxable });
    netCents += t.netCents;
    vatCents += t.vatCents;
  }
  return {
    netCents,
    vatCents,
    grossCents: netCents + vatCents,
    hasPrivateShare,
    needsBudgetSplit,
    singlePotIsPrivate: !needsBudgetSplit && hasPrivateShare,
  };
}

/**
 * Brutto einer GEPLANTEN (noch nicht dokumentierten) Termin-Menge für die
 * Plan-Spalte der Liste „Bereit zum Abrechnen". Ohne Buchung gibt es keinen
 * Topf-Split; die Einordnung bleibt die bisherige: Selbstzahler = Privat-Topf,
 * sonst Kasse. Die USt je Position kommt aus derselben Regel (`ustFuerTopf`).
 * ERSETZT `totalNetCents + totalVatCents` aus dem Zeilen-Bauer, der keine
 * USt mehr rechnet.
 */
export function planBruttoCents(items: readonly PotAmountItem[], billingType: string): number {
  const t = ustFuerTopf(billingType === "selbstzahler" ? "private" : "entlastungsbetrag_45b", items);
  return t.netCents + t.vatCents;
}
