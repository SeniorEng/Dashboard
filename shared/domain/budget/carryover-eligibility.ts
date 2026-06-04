/**
 * Task #928 — Pure §45b-Übertrag-Obergrenze (SSoT).
 *
 * Bei der Kundenanlage darf der Übertrag aus dem Vorjahr (§45b-Restguthaben)
 * höchstens so viele Monatsaufstockungen umfassen, wie der Kunde im Vorjahr
 * pflegegrad-berechtigt war. Diese Mathematik wurde im Wizard-Schritt inline
 * berechnet; sie lebt jetzt hier als reine, seiteneffektfreie Funktion.
 *
 * Keine DB-Zugriffe, keine State-Werte — alle Inputs werden explizit übergeben.
 */
import { BUDGET_45B_MAX_MONTHLY_CENTS } from "../budgets";

/**
 * Anzahl der im Vorjahr §45b-berechtigten Monate (0–12), abgeleitet aus dem
 * Pflegegrad-Beginn (`pflegegradSeit`, ISO "YYYY-MM-DD") relativ zum laufenden
 * Jahr `currentYear`:
 *  - Pflegegrad erst in DIESEM Jahr begonnen → 0 berechtigte Vorjahresmonate.
 *  - Pflegegrad im Vorjahr begonnen → ab dem Startmonat anteilig (z.B. März → 10).
 *  - Pflegegrad vor dem Vorjahr (oder kein Datum) → volle 12 Monate.
 */
export function eligible45bCarryoverMonths(
  pflegegradSeit: string | null | undefined,
  currentYear: number,
): number {
  const previousYear = currentYear - 1;
  if (!pflegegradSeit) return 12;

  const [year, month] = pflegegradSeit.split("-").map(Number);
  if (!year || !month) return 12;

  if (year > previousYear) return 0;
  if (year === previousYear) return 12 - (month - 1);
  return 12;
}

/**
 * Maximal zulässiger §45b-Übertrag in Cent für `eligibleMonths` berechtigte
 * Monate (Monatsaufstockung × Monate).
 */
export function max45bCarryoverCents(eligibleMonths: number): number {
  return BUDGET_45B_MAX_MONTHLY_CENTS * eligibleMonths;
}

/**
 * Task #959 — Obergrenze für den §45b-STARTWERT (`initial_balance`) in Cent.
 *
 * Ein §45b-Startwert repräsentiert das im LAUFENDEN Jahr bis zum Startmonat
 * akkumulierte, noch nicht verbrauchte Guthaben (z.B. Onboarding im März mit
 * unverbrauchtem Januar–März). Er darf höchstens so groß sein, wie bis zum
 * Startmonat überhaupt angesammelt werden konnte: (Anzahl der vom Accrual-Anker
 * bis zum Startmonat verstrichenen, §45b-berechtigten Monate) × Monatsaufstockung.
 *
 * - `accrualAnchorISO` = §45b-Accrual-Beginn (i.d.R. Pflegegrad-Beginn, ISO
 *   "YYYY-MM-DD"). Fehlt er, wird ab Januar des Startjahres gerechnet (großzügige
 *   Obergrenze: es kann nicht mehr als `startMonth` Monate angesammelt sein).
 * - `startMonthISO` = Datum, für das der Startwert gebucht wird ("YYYY-MM-DD").
 *
 * Reiner Wert, keine Seiteneffekte. Der Vorjahres-Übertrag wird separat über
 * `max45bCarryoverCents` begrenzt (eigene Allokationszeile).
 */
export function max45bStartValueCents(
  accrualAnchorISO: string | null | undefined,
  startMonthISO: string,
): number {
  const [startYear, startMonth] = startMonthISO.split("-").map(Number);
  if (!startYear || !startMonth) return BUDGET_45B_MAX_MONTHLY_CENTS;

  let earliestEligibleMonth = 1;
  if (accrualAnchorISO) {
    const [anchorYear, anchorMonth] = accrualAnchorISO.split("-").map(Number);
    if (anchorYear && anchorMonth) {
      if (anchorYear > startYear) return 0; // im Startjahr noch nicht berechtigt
      if (anchorYear === startYear) earliestEligibleMonth = anchorMonth;
      // anchorYear < startYear → ab Januar (earliestEligibleMonth bleibt 1)
    }
  }

  const months = Math.max(0, startMonth - earliestEligibleMonth + 1);
  return months * BUDGET_45B_MAX_MONTHLY_CENTS;
}

/**
 * Task #981 — Reiner Accrual-Anker-Resolver (SSoT).
 *
 * Der §45b-Accrual-Anker ist der früheste Pflegegrad-Beginn (`validFrom`) aus
 * der Care-Level-Historie eines Kunden. Er speist sowohl die angezeigte als auch
 * die durchgesetzte §45b-Startwert-Obergrenze (`max45bStartValueCents`) und den
 * Vorjahres-Übertrag (`eligible45bCarryoverMonths`).
 *
 * Diese Funktion ist REIHENFOLGE-UNABHÄNGIG: sie wählt das lexikografisch
 * kleinste (= chronologisch früheste) `validFrom` der übergebenen Zeilen,
 * unabhängig davon, ob die Historie auf- oder absteigend sortiert geliefert
 * wird. Leere/ungültige Zeilen werden ignoriert. Gibt es keine gültige Zeile,
 * fällt die Funktion auf `fallbackISO` (i.d.R. den erfassten Startmonat) zurück.
 *
 * Hintergrund: Client und Server leiteten den Anker zuvor mit je eigenem
 * Ausdruck ab (frühestes `validFrom` vs. letztes Element der `desc`-Historie).
 * Beide stimmten nur überein, solange `getCustomerCareLevelHistory` in
 * `desc(validFrom)`-Ordnung liefert. Dieser gemeinsame Resolver entfernt die
 * Abhängigkeit von der DB-Sortierung.
 *
 * Reiner Wert, keine Seiteneffekte, kein `Date`-Parsing.
 */
export function resolve45bAccrualAnchor(
  careLevelHistory: ReadonlyArray<{ validFrom?: string | null }>,
  fallbackISO: string,
): string {
  let earliest: string | undefined;
  for (const row of careLevelHistory) {
    const validFrom = row?.validFrom;
    if (!validFrom) continue;
    if (earliest === undefined || validFrom < earliest) {
      earliest = validFrom;
    }
  }
  return earliest ?? fallbackISO;
}

/**
 * Task #964 — Deutsche Fehler-/Hinweismeldung, die einen §45b-Startwert mit
 * einem Stichmonat/`validFrom` aus einem früheren Jahr ablehnt und stattdessen
 * auf das Übertrag-Feld verweist. Rechtlicher Hintergrund: §45b-Guthaben aus
 * einem Vorjahr ist ein Übertrag (verfällt am 30.06. des laufenden Jahres) und
 * KEIN dauerhafter Startwert.
 */
export const PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE =
  "Ein §45b-Restguthaben aus einem früheren Jahr ist ein Übertrag aus dem Vorjahr "
  + "(verfällt am 30.06. dieses Jahres) und kann nicht als Startwert erfasst werden. "
  + "Bitte tragen Sie den Betrag im Feld \"Übertrag aus Vorjahr\" ein.";

/**
 * Task #964 — Reiner Guard, der einen §45b-Startwert mit einem Stichmonat aus
 * einem früheren Jahr ablehnt. Gilt AUSSCHLIESSLICH für §45b (Entlastungsbetrag);
 * §45a/§39 werden über diese Funktion nie geprüft. Vorjahres-§45b-Guthaben muss
 * als Übertrag (`carryover`) erfasst werden, nicht als dauerhafter Startwert.
 *
 * @param startMonthISO Stichmonat/`validFrom` des Startwerts ("YYYY-MM" oder
 *   "YYYY-MM-DD").
 * @param currentYear  Laufendes Jahr (vom Aufrufer übergeben — keine `Date`-
 *   Seiteneffekte hier).
 * @returns Deutsche Fehlermeldung, falls das Jahr vor `currentYear` liegt, sonst
 *   `null`. Ungültige/leere Eingaben ergeben `null` (Schema-Validierung greift
 *   separat).
 */
export function validate45bInitialBalanceNotPriorYear(
  startMonthISO: string,
  currentYear: number,
): string | null {
  const year = Number(startMonthISO.split("-")[0]);
  if (!Number.isFinite(year) || year === 0) return null;
  return year < currentYear ? PRIOR_YEAR_45B_INITIAL_BALANCE_MESSAGE : null;
}
