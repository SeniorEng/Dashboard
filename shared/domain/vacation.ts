export function calculateProRataVacationDays(
  vacationDaysPerYear: number,
  eintrittsdatum: string,
  year: number
): number {
  const startDate = new Date(eintrittsdatum);
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
  todayISO: string
): number {
  if (unusedDaysFromPreviousYear <= 0) return 0;

  const today = new Date(todayISO);
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

export function calculateUnusedDays(
  entitlement: number,
  carryOver: number,
  usedDays: number,
  plannedDays: number
): number {
  return entitlement + carryOver - usedDays - plannedDays;
}

export const VACATION_EXPIRY_DATE = "01.04.";
export const DEFAULT_VACATION_DAYS = 30;
