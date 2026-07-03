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
