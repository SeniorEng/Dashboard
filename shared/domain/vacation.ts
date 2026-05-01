import { parseLocalDate } from "../utils/datetime";

function calculateProRataVacationDays(
  vacationDaysPerYear: number,
  eintrittsdatum: string,
  year: number
): number {
  const startDate = parseLocalDate(eintrittsdatum);
  const startYear = startDate.getFullYear();

  if (year < startYear) return 0;

  if (year > startYear) return vacationDaysPerYear;

  const startMonth = startDate.getMonth();
  const remainingMonths = 12 - startMonth;
  const proRata = (vacationDaysPerYear / 12) * remainingMonths;
  return Math.ceil(proRata);
}

export function calculateCarryOverDays(
  unusedDaysFromPreviousYear: number,
  year: number,
  todayISOStr: string
): number {
  if (unusedDaysFromPreviousYear <= 0) return 0;

  const today = parseLocalDate(todayISOStr);
  const expiryDate = new Date(year, 3, 1);

  if (today >= expiryDate) {
    return 0;
  }

  const yearStart = new Date(year, 0, 1);
  if (today < yearStart) {
    return unusedDaysFromPreviousYear;
  }

  return unusedDaysFromPreviousYear;
}

export function getVacationEntitlement(
  vacationDaysPerYear: number,
  eintrittsdatum: string | null,
  year: number
): number {
  if (!eintrittsdatum) return vacationDaysPerYear;
  return calculateProRataVacationDays(vacationDaysPerYear, eintrittsdatum, year);
}


export function calculateVacationEntitlementByWorkDays(weeklyWorkDays: number): number {
  return Math.round((weeklyWorkDays * 24) / 6);
}

// ============================================
// Anteilige Berechnung mit Anspruchs-Historie
// ============================================

export interface VacationEntitlementHistoryEntry {
  validFromYear: number;
  validFromMonth: number; // 1-12
  daysPerYear: number;
}

/**
 * Berechnet den Jahresurlaubsanspruch für `year` anteilig pro Monat:
 *  - Monate vor dem Eintrittsmonat zählen 0.
 *  - Für jeden anderen Monat wird der zu diesem Monat gültige `daysPerYear`
 *    aus der History herangezogen und durch 12 geteilt.
 *  - Summe wird auf 2 Nachkommastellen gerundet.
 *
 * Wenn `history` leer ist, wird auf `getVacationEntitlement` zurückgefallen
 * (Backwards-Kompatibilität).
 */
export function calculateAnnualEntitlementWithHistory(
  history: VacationEntitlementHistoryEntry[],
  eintrittsdatum: string | null,
  year: number,
  fallbackDaysPerYear: number,
): number {
  if (history.length === 0) {
    return getVacationEntitlement(fallbackDaysPerYear, eintrittsdatum, year);
  }

  let entryYear: number | null = null;
  let entryMonth: number | null = null; // 1-12
  if (eintrittsdatum) {
    const start = parseLocalDate(eintrittsdatum);
    entryYear = start.getFullYear();
    entryMonth = start.getMonth() + 1;
    if (year < entryYear) return 0;
  }

  // Sortiere History aufsteigend nach validFrom (Jahr * 100 + Monat).
  const sorted = [...history].sort((a, b) => {
    const ka = a.validFromYear * 100 + a.validFromMonth;
    const kb = b.validFromYear * 100 + b.validFromMonth;
    return ka - kb;
  });

  // Bestimme den initial gültigen Wert für den Jahresanfang: das ist der
  // letzte History-Eintrag, dessen validFrom <= (year, 1) ist. Existiert keiner
  // (alle History-Einträge liegen in der Zukunft des betrachteten Jahres),
  // nutzen wir den frühesten History-Wert als Fallback.
  let activeDays: number = sorted[0].daysPerYear;
  for (const h of sorted) {
    const hKey = h.validFromYear * 100 + h.validFromMonth;
    const yearStartKey = year * 100 + 1;
    if (hKey <= yearStartKey) activeDays = h.daysPerYear;
  }

  let sum = 0;
  for (let month = 1; month <= 12; month++) {
    // Update activeDays, wenn ein History-Eintrag in diesem Monat in Kraft tritt.
    for (const h of sorted) {
      if (h.validFromYear === year && h.validFromMonth === month) {
        activeDays = h.daysPerYear;
      }
    }

    if (entryYear !== null && entryMonth !== null) {
      if (year === entryYear && month < entryMonth) continue;
    }

    sum += activeDays / 12;
  }

  return Math.round(sum * 100) / 100;
}
