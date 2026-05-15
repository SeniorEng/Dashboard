/**
 * Task #441 — Single Source of Truth für Geld-Formatierung und -Parsing.
 *
 * Alle Cent-↔ Euro-Konvertierungen MÜSSEN diesen Helper benutzen, damit:
 *   - das deutsche Format (",", " €") überall identisch ist,
 *   - das Negativ-Zeichen einheitlich gesetzt wird,
 *   - kein einzelner Callsite mehr `(x / 100).toFixed(2)` öffnet, was
 *     historisch zu Rundungs- und Anzeigedrift geführt hat.
 *
 * Architektur-Test `tests/architecture/no-money-arithmetic-outside-helper.test.ts`
 * verhindert neue `/ 100`/`* 100`-Money-Arithmetik außerhalb dieser Datei.
 */

const EURO_FORMATTER_DE = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Cents → Euro als reine `number` (kein String-Format). Behält Vorzeichen.
 *
 * @example centsToEuroNumber(12550) // 125.5
 * @example centsToEuroNumber(-500)  // -5
 */
export function centsToEuroNumber(cents: number): number {
  return cents / 100;
}

/**
 * Formatiert einen Cent-Betrag im deutschen Format ("125,50 €", "-5,00 €").
 *
 * Optionen:
 *   - `showSign`: setzt ein "+" vor positive Beträge (z.B. Audit-Log-Diffs).
 *   - `withCurrency`: wenn `false`, wird das "€" weggelassen ("125,50").
 *     Default `true`.
 *
 * @example formatEuroDE(12550)                    // "125,50 €"
 * @example formatEuroDE(-500)                     // "-5,00 €"
 * @example formatEuroDE(12550, { showSign: true })// "+125,50 €"
 * @example formatEuroDE(12550, { withCurrency: false }) // "125,50"
 */
export function formatEuroDE(
  cents: number,
  options?: { showSign?: boolean; withCurrency?: boolean },
): string {
  const value = centsToEuroNumber(cents);
  const formatted = options?.withCurrency === false
    ? value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : EURO_FORMATTER_DE.format(value);
  if (options?.showSign && cents > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

/**
 * Parst einen Euro-String im deutschen oder gemischten Format zu Cents.
 * Akzeptiert: "125,50", "125.50", "1.234,56", "1234.56", "125", "  125 €  ".
 *
 * Liefert:
 *   - `null` bei leerem/ungültigem Input (Konsumenten entscheiden selbst,
 *     ob `null` als Fehler oder "kein Wert" interpretiert wird),
 *   - sonst die exakte Cent-Repräsentation (gerundet).
 *
 * @example parseEuroDE("125,50")    // 12550
 * @example parseEuroDE("1.234,56")  // 123456
 * @example parseEuroDE("")          // null
 */
export function parseEuroDE(input: string | null | undefined): number | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Entferne Euro-Zeichen und Whitespace innerhalb der Eingabe.
  const cleaned = trimmed.replace(/[€\s]/g, "");
  if (cleaned === "") return null;

  let normalized: string;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    // Deutsches Format mit Tausenderpunkten: "1.234,56"
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // Reines deutsches Format: "125,50"
    normalized = cleaned.replace(",", ".");
  } else {
    // Englisches Format oder Ganzzahl: "125.50" / "125"
    normalized = cleaned;
  }

  const parsed = parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}
