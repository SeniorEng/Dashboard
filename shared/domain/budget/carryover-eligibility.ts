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
