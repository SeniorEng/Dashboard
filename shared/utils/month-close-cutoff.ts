import { getNationalHolidayDates } from "./holidays";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Zerlegt ein ISO-Datum (YYYY-MM-DD) in seine numerischen Bestandteile.
 * Bewusst über `split("-")` statt `slice()` — so ist jede Stelle eine eigene
 * Komponente, deren Vertauschen/Entfernen ein Test sichtbar machen kann
 * (mit `slice(0,4)` + `parseInt` blieben Index-Mutationen unbemerkt, weil
 * `parseInt` ohnehin am `-` stoppt).
 */
function parseIsoParts(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-");
  return { year: Number(y), month: Number(m), day: Number(d) };
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
  // Folgemonat: `month` ist 1-12, der 0-basierte Index des Folgemonats ist
  // also `month`. Date.UTC normalisiert den Dezember→Januar-Überlauf selbst,
  // daher kein manuelles Roll-over nötig. Das Cutoff-Jahr (für die
  // Feiertagsliste) ist nur im Dezember das Folgejahr.
  const cutoffYear = month === 12 ? year + 1 : year;
  const holidays = getNationalHolidayDates(cutoffYear);

  let cutoff = new Date(Date.UTC(year, month, 8));
  while (isWeekendOrHoliday(cutoff, holidays)) {
    cutoff = new Date(cutoff.getTime() - MS_PER_DAY);
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
  const t = parseIsoParts(today);
  const c = parseIsoParts(cutoff);
  const todayMs = Date.UTC(t.year, t.month - 1, t.day);
  const cutoffMs = Date.UTC(c.year, c.month - 1, c.day);
  return Math.round((cutoffMs - todayMs) / MS_PER_DAY);
}

/**
 * Liefert (year, month) des Vormonats relativ zu einem ISO-Datum.
 */
export function previousMonth(today: string): { year: number; month: number } {
  const { year, month } = parseIsoParts(today);
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}
