/**
 * Task #1291 (Phase 3.3) — `priceFor`-SSoT: die EINE Preis-Auflösung.
 *
 * Heute beantworten mehrere Stellen die Frage „Welcher Preis gilt für Kunde X,
 * Service Y am Datum Z?" ad-hoc (Termin-Kostenrechner, Rechnungs-Line-Items,
 * Budget-Vorschau, Statistik). Diese reine Funktion ist die einzige
 * Auflösungslogik; alle Lese-/Schreibpfade importieren sie, statt eigene
 * Lookups zu bauen.
 *
 * Auflösungsreihenfolge (zeitversioniert):
 *   1. Kunden-Preis   — eine VORHANDENE Kundenzeile gewinnt IMMER über Standard,
 *                       auch bei `priceCents = 0` (= explizit kostenlos, z. B.
 *                       „keine Anfahrt"). Es zählt die EXISTENZ der Zeile, nicht
 *                       der Wert — KEIN 0/NULL-Kurzschluss auf Standard.
 *   2. Standard-Preis — firmenweit, zeitversioniert (Schatten-Hook; heute leer,
 *                       bis die konsolidierte `prices`-Tabelle den Standard-Scope
 *                       befüllt).
 *   3. Katalog-Default — `services.defaultPriceCents` als unterster Fallback;
 *                        nicht abrechenbare Services (`isBillable === false`)
 *                        lösen 0 auf.
 *
 * Rein (keine I/O): Aufrufer laden die Zeilen und übergeben sie. Datums-Vergleich
 * erfolgt lexikografisch auf `YYYY-MM-DD`.
 */

export type PriceScope = "customer" | "standard" | "default";

/** Eine zeitversionierte Preiszeile (Kunden- oder Standard-Scope). */
export interface VersionedPriceRow {
  priceCents: number;
  /** `YYYY-MM-DD` oder null (= offener Anfang). */
  validFrom: string | null;
  /** `YYYY-MM-DD` oder null (= offenes Ende). */
  validTo: string | null;
  /** Deterministischer Tiebreaker bei identischem `validFrom` (höher = neuer). */
  id: number;
}

/** Katalog-Attribute eines Services für den Default-Fallback. */
export interface PriceCatalogEntry {
  defaultPriceCents: number;
  isBillable: boolean;
}

export interface PriceResolution {
  cents: number;
  scope: PriceScope;
}

const MIN_DATE = "0000-01-01";
const MAX_DATE = "9999-12-31";

/**
 * Wählt die am `date` aktive Zeile: alle Zeilen, deren `[validFrom, validTo]`
 * das Datum enthält; bei mehreren gewinnt das späteste `validFrom`, dann die
 * höchste `id`. Gibt `null`, wenn keine Zeile passt.
 */
function pickActive(rows: readonly VersionedPriceRow[], date: string): VersionedPriceRow | null {
  let best: VersionedPriceRow | null = null;
  for (const r of rows) {
    const from = r.validFrom ?? MIN_DATE;
    const to = r.validTo ?? MAX_DATE;
    if (date < from || date > to) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const bestFrom = best.validFrom ?? MIN_DATE;
    if (from > bestFrom || (from === bestFrom && r.id > best.id)) {
      best = r;
    }
  }
  return best;
}

/**
 * Löst den geltenden Preis (Integer-Cents) für ein Service am `date` auf.
 *
 * Gibt `null` NUR, wenn weder eine Kunden-/Standard-Zeile noch ein
 * Katalog-Eintrag existiert (= unbekanntes Service); Aufrufer behandeln das als
 * klaren Konfigurationsfehler.
 */
export function resolvePriceFor(args: {
  date: string;
  customerRows: readonly VersionedPriceRow[];
  standardRows?: readonly VersionedPriceRow[];
  catalog?: PriceCatalogEntry;
}): PriceResolution | null {
  // 1. Kunden-Override — EXISTENZ gewinnt (cents === 0 ist ein gültiger Preis).
  const customer = pickActive(args.customerRows, args.date);
  if (customer !== null) {
    return { cents: customer.priceCents, scope: "customer" };
  }

  // 2. Standard (firmenweit, zeitversioniert).
  const standard = pickActive(args.standardRows ?? [], args.date);
  if (standard !== null) {
    return { cents: standard.priceCents, scope: "standard" };
  }

  // 3. Katalog-Default (unterster Fallback).
  if (args.catalog) {
    const cents = args.catalog.isBillable === false ? 0 : args.catalog.defaultPriceCents;
    return { cents, scope: "default" };
  }

  return null;
}
