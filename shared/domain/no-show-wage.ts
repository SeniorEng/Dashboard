/**
 * Task #167 — SSoT: "Was ist eine Leerfahrt (No-Show) wert?"
 *
 * Ein `customer_no_show` (Kunde nicht angetroffen / Vergebliche Anfahrt) wird
 * exakt wie ein normaler Termin bezahlt, plus eine gedeckelte Wartepauschale —
 * NIE auf die geplante Dauer (`durationPromised`). Diese Funktion ist die EINE
 * Stelle, die diese Frage beantwortet; sowohl die Mitarbeiter-Sicht
 * ("Meine Zeiten") als auch die Admin-Mitarbeiterabrechnung teilen sie, damit
 * die Zahlen nie auseinanderlaufen (Anti-Drift-Test gesichert).
 *
 * Regel (mit Alrik bestätigt):
 * - Fahrtzeit = origin-gated wie beim normalen Termin: `travelMinutes` zählt NUR,
 *   wenn der MA von einem vorherigen Termin kam (`travelOriginType='appointment'`);
 *   von zu Hause → 0 Fahrtminuten.
 * - Anfahrt-km = wie bei normaler Anfahrt, ausschließlich aus `noShowKilometers`
 *   (die einzige No-Show-Km-SSoT). Ein No-Show hat keine Kunden-km.
 * - Wartepauschale = `noShowWaitMinutes`, gedeckelt auf {@link NO_SHOW_WAIT_CAP_MINUTES}.
 *   Der Cap wird zusätzlich beim Input erzwungen (Eingabe == Auszahlung); der
 *   Clamp hier schützt Alt-Datensätze, die vor dem Input-Cap > 15 gespeichert wurden.
 *
 * Diese Datei importiert bewusst NICHTS (pure Domain-Logik).
 */

/** Maximal bezahlte/erfassbare Wartezeit einer Leerfahrt (Minuten). */
export const NO_SHOW_WAIT_CAP_MINUTES = 15;

export interface NoShowWageInput {
  // Bewusst als `string` typisiert (DB-Spalte ist `text`): nur der exakte Wert
  // `'appointment'` schaltet die Fahrtzeit frei, alles andere (inkl. `'home'`,
  // NULL, Alt-Werte) zählt als „von zu Hause" → 0 Fahrtminuten.
  travelOriginType: string | null | undefined;
  travelMinutes: number | null | undefined;
  noShowWaitMinutes: number | null | undefined;
  noShowKilometers: number | null | undefined;
}

export interface NoShowWageResult {
  /** Bezahlte Fahrtminuten (origin-gated, ≥0, gerundet). */
  travelMinutes: number;
  /** Bezahlte Wartezeit (0..NO_SHOW_WAIT_CAP_MINUTES, gerundet). */
  waitMinutes: number;
  /** Summe der lohnrelevanten Minuten (Fahrt + gedeckelte Wartezeit). */
  paidMinutes: number;
  /** Anfahrt-km (≥0). */
  kilometers: number;
}

export function computeNoShowWage(input: NoShowWageInput): NoShowWageResult {
  const travelMinutes = input.travelOriginType === "appointment"
    ? Math.max(0, Math.round(input.travelMinutes ?? 0))
    : 0;

  const rawWait = Math.max(0, Math.round(input.noShowWaitMinutes ?? 0));
  const waitMinutes = Math.min(NO_SHOW_WAIT_CAP_MINUTES, rawWait);

  const kilometers = Math.max(0, input.noShowKilometers ?? 0);

  return {
    travelMinutes,
    waitMinutes,
    paidMinutes: travelMinutes + waitMinutes,
    kilometers,
  };
}
