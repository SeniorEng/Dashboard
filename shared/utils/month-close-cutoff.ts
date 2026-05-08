import { getHolidays } from "./holidays";

const BUNDESEINHEITLICHE_FEIERTAGE = new Set<string>([
  "Neujahr",
  "Karfreitag",
  "Ostermontag",
  "Tag der Arbeit",
  "Christi Himmelfahrt",
  "Pfingstmontag",
  "Tag der Deutschen Einheit",
  "1. Weihnachtsfeiertag",
  "2. Weihnachtsfeiertag",
]);

function getNationalHolidayDates(year: number): Set<string> {
  const dates = new Set<string>();
  for (const h of getHolidays(year)) {
    if (BUNDESEINHEITLICHE_FEIERTAGE.has(h.name)) {
      dates.add(h.date);
    }
  }
  return dates;
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekendOrHoliday(d: Date, holidays: Set<string>): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  return holidays.has(toIsoDate(d));
}

/**
 * Berechnet den Cutoff-Tag für den Monatsabschluss eines Monats.
 *
 * Regel: Der 8. des Folgemonats ist der Cutoff. Fällt der 8. auf ein
 * Wochenende oder einen bundeseinheitlichen Feiertag, wird der Cutoff
 * auf den vorherigen Werktag VORgezogen (so dass bis zur 10.-Auszahlung
 * sicher abgerechnet werden kann).
 *
 * @param year  Jahr des abgeschlossenen Monats (z.B. 2026 für Mai 2026)
 * @param month Monat (1-12) des abgeschlossenen Monats
 * @returns ISO-Datum (YYYY-MM-DD) des Cutoff-Tags
 */
export function computeMonthCloseCutoff(year: number, month: number): string {
  // Folgemonat
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }

  const holidaysCurrent = getNationalHolidayDates(nextYear);
  const holidaysPrev = getNationalHolidayDates(nextYear - 1);
  const holidaysAll = new Set<string>([...holidaysCurrent, ...holidaysPrev]);

  let cutoff = new Date(Date.UTC(nextYear, nextMonth - 1, 8));
  while (isWeekendOrHoliday(cutoff, holidaysAll)) {
    cutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
  }

  return toIsoDate(cutoff);
}

/**
 * Liefert true, wenn `today` der Cutoff-Tag für den Monat (year, month) ist.
 */
export function isCutoffDay(today: string, year: number, month: number): boolean {
  return computeMonthCloseCutoff(year, month) === today;
}

/**
 * Liefert die Anzahl Tage zwischen heute und dem Cutoff (positiv = Cutoff in Zukunft).
 * `today` ist ein ISO-Datum (YYYY-MM-DD). Wenn der Cutoff bereits vergangen ist,
 * gibt die Funktion einen negativen Wert zurück.
 */
export function daysUntilCutoff(today: string, year: number, month: number): number {
  const cutoff = computeMonthCloseCutoff(year, month);
  const todayMs = Date.UTC(
    parseInt(today.slice(0, 4)),
    parseInt(today.slice(5, 7)) - 1,
    parseInt(today.slice(8, 10)),
  );
  const cutoffMs = Date.UTC(
    parseInt(cutoff.slice(0, 4)),
    parseInt(cutoff.slice(5, 7)) - 1,
    parseInt(cutoff.slice(8, 10)),
  );
  return Math.round((cutoffMs - todayMs) / (24 * 60 * 60 * 1000));
}

/**
 * Liefert (year, month) des Vormonats relativ zu einem ISO-Datum.
 */
export function previousMonth(today: string): { year: number; month: number } {
  const y = parseInt(today.slice(0, 4));
  const m = parseInt(today.slice(5, 7));
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}
