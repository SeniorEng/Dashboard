/**
 * Task #1599 — Datums-basierter Qonto-Backfill über alle überwachten Konten.
 *
 * Zerlegt einen Zeitraum [start, end] in monats-große Fenster. Der Backfill
 * fragt Qonto pro Konto und Fenster ab (`emitted_at_from`/`emitted_at_to`),
 * damit einzelne Abfragen klein bleiben (Qonto begrenzt ~10k Treffer pro Query)
 * und die Pagination sicher terminiert.
 */

export interface DateWindow {
  from: Date;
  to: Date;
}

/**
 * Task #1607 — Harte Obergrenze für die Rückreichweite eines Backfills.
 *
 * Ein Voll-Abzug, dessen Startdatum weiter als diese Anzahl Monate in der
 * Vergangenheit liegt, gilt als „gefährlich groß": er erzeugt sehr viele
 * Monats-Fenster (== Qonto-API-Abfragen pro Konto), ist entsprechend langsam
 * und belastet die Qonto-API stark. Solche Läufe werden nicht mehr nur
 * gewarnt (Task #1606), sondern erfordern eine EXPLIZITE Zusatz-Bestätigung
 * (Client-Checkbox + Server-Flag `acknowledgeExtendedLookback`).
 *
 * Anpassen: EINEN Wert hier ändern — Client (Zusatz-Bestätigung) und Server
 * (Guard) lesen beide diese Konstante. Normale, aktuelle Backfills (Startdatum
 * innerhalb der letzten `MAX_BACKFILL_LOOKBACK_MONTHS` Monate) bleiben davon
 * unberührt und laufen ohne Zusatz-Bestätigung.
 */
export const MAX_BACKFILL_LOOKBACK_MONTHS = 24;

/**
 * Anzahl voller Kalendermonate, die `start` vor `end` liegt (0, wenn `start`
 * im selben Monat wie `end` oder später liegt). Rein monats-granular — dieselbe
 * Kennzahl, die die Client-Umfangsanzeige („… zurück") verwendet.
 */
export function monthsBetween(start: Date, end: Date): number {
  const diff =
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return diff > 0 ? diff : 0;
}

/**
 * Task #1607 — Reicht ein Backfill ab `start` (bis `end`, i.d.R. heute) weiter
 * zurück als die erlaubte Standard-Rückreichweite? Wenn ja, ist eine explizite
 * Zusatz-Bestätigung nötig. SSoT für Client-Checkbox UND Server-Guard.
 */
export function exceedsBackfillLookbackCap(start: Date, end: Date): boolean {
  return monthsBetween(start, end) > MAX_BACKFILL_LOOKBACK_MONTHS;
}

/**
 * Liefert lückenlose, nicht-überlappende Monats-Fenster von `start` bis `end`
 * (inklusive). Das erste Fenster beginnt exakt bei `start`, jedes weitere am
 * Monatsersten (00:00 lokal); jedes Fenster endet an der letzten Millisekunde
 * seines Monats bzw. das letzte bei `end`.
 */
export function enumerateMonthlyWindows(start: Date, end: Date): DateWindow[] {
  if (end.getTime() < start.getTime()) return [];

  const windows: DateWindow[] = [];
  let cursor = new Date(start.getTime());

  while (cursor.getTime() <= end.getTime()) {
    // Erste Millisekunde des Folgemonats.
    const nextMonthStart = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(nextMonthStart.getTime() - 1);
    const windowEnd = monthEnd.getTime() < end.getTime() ? monthEnd : end;
    windows.push({ from: new Date(cursor.getTime()), to: new Date(windowEnd.getTime()) });
    cursor = nextMonthStart;
  }

  return windows;
}
