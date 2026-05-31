/**
 * Task #872 — §45b statutory monthly allocation enumeration (SSoT).
 *
 * §45b ("Entlastungsbetrag") ist ein kumulatives Jahresbudget mit einer
 * monatlichen Aufstockung (Default 131 € = `BUDGET_45B_MAX_MONTHLY_CENTS`).
 * Historisch wurde diese Aufstockung NICHT als Datenbankzeilen gespeichert,
 * sondern in `calculateAllocated45b` pro Aufruf rein rechnerisch Monat-für-Monat
 * aufsummiert ("virtuelles Auto-Renewal"). Diese Funktion zieht GENAU diese
 * Monatsaufzählung als reine, seiteneffektfreie SSoT heraus — sie ist
 * gleichzeitig:
 *
 *  - die Berechnungsgrundlage des (refaktorierten) Read-Pfads,
 *  - die Quelle der materialisierten `statutory_monthly`-Allokationszeilen,
 *  - der Reconciliation-Oracle für den Backfill (Zero-Diff gegen die Alt-Summe).
 *
 * Die async DB-Auflösung (Anker/Horizont/Initial-Balance-Monate/historisierter
 * Monatsbetrag) bleibt im Storage-Layer; sie wird hier als bereits aufgelöste
 * Eingabe übergeben, damit die Aufzählung pur und testbar ist.
 */

export interface Statutory45bMonth {
  readonly year: number;
  readonly month: number;
  readonly amountCents: number;
}

export interface Enumerate45bInput {
  /** Erster Monat der Aufstockung (inklusive). */
  readonly allocStartYear: number;
  readonly allocStartMonth: number;
  /** Letzter Monat der Aufstockung (inklusive). */
  readonly endYear: number;
  readonly endMonth: number;
  /**
   * Monate, die durch eine AKTIVE `initial_balance`-Allokation belegt sind und
   * daher NICHT zusätzlich monatlich aufgestockt werden (Task #101/#642).
   * Schlüssel-Format: `"YYYY-M"` mit NICHT-aufgefülltem Monat (z. B. `"2026-3"`),
   * exakt wie der Legacy-`initialBalanceSet`.
   */
  readonly initialBalanceMonthKeys: ReadonlySet<string>;
  /**
   * Liefert den (historisierten, geclampten) monatlichen Aufstockungsbetrag in
   * Cent für einen gegebenen `(year, month)` — i. d. R. der pro-Kunde
   * konfigurierte "Unser Anteil" bzw. der gesetzliche Default.
   */
  readonly monthlyAmountFor: (year: number, month: number) => number;
}

/**
 * Zählt alle §45b-Aufstockungsmonate von `allocStart` bis `end` (inklusive) auf,
 * überspringt dabei durch einen aktiven Startwert belegte Monate und ermittelt
 * pro Monat den damals gültigen Aufstockungsbetrag. Reihenfolge: chronologisch
 * aufsteigend (FIFO-tauglich).
 */
export function enumerate45bStatutoryMonths(
  input: Enumerate45bInput,
): Statutory45bMonth[] {
  const out: Statutory45bMonth[] = [];
  let y = input.allocStartYear;
  let m = input.allocStartMonth;
  while (y < input.endYear || (y === input.endYear && m <= input.endMonth)) {
    if (!input.initialBalanceMonthKeys.has(`${y}-${m}`)) {
      out.push({ year: y, month: m, amountCents: input.monthlyAmountFor(y, m) });
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Summiert die Cent-Beträge einer §45b-Monatsaufzählung. */
export function sum45bStatutoryMonths(
  months: readonly Statutory45bMonth[],
): number {
  return months.reduce((sum, x) => sum + x.amountCents, 0);
}
