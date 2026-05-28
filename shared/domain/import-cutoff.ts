/**
 * Task #708 — Cutoff-Schutz für Excel-Re-Imports.
 *
 * Beim wiederholten Excel-Import (vor allem im Reconcile-Pfad) sollen
 * DB-Termine, deren Datum **nach** dem letzten in der Excel enthaltenen
 * Monat liegt, niemals angefasst werden. Sonst würde z.B. ein Re-Import
 * eines Jan-Apr-Excels zukünftige (Mai+) bereits geplante Termine eines
 * Kunden als „nicht in Excel → stornieren" markieren.
 *
 * `computeLastExcelMonth` liefert den letzten Tag des größten YYYY-MM,
 * der in den übergebenen Excel-Datumsangaben vorkommt (`null` falls leer).
 * Aufrufer interpretieren das Ergebnis als oberen Grenz-Stichtag
 * (`appointment.date > lastDay` ⇒ geschützt).
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ExcelCutoff {
  /** Größter YYYY-MM in der Excel. */
  yearMonth: string;
  /** Letzter Tag dieses Monats als ISO-Datum (YYYY-MM-DD). */
  lastDay: string;
}

function lastDayOfMonthISO(year: number, monthOneIndexed: number): string {
  const d = new Date(Date.UTC(year, monthOneIndexed, 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function computeLastExcelMonth(
  dates: ReadonlyArray<string | null | undefined>,
): ExcelCutoff | null {
  let maxYm: string | null = null;
  for (const raw of dates) {
    if (!raw) continue;
    const m = ISO_DATE_RE.exec(raw);
    if (!m) continue;
    const ym = `${m[1]}-${m[2]}`;
    if (maxYm == null || ym > maxYm) maxYm = ym;
  }
  if (maxYm == null) return null;
  const [yStr, mStr] = maxYm.split("-");
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  return { yearMonth: maxYm, lastDay: lastDayOfMonthISO(year, month) };
}

export function isBeyondCutoff(dateISO: string, cutoff: ExcelCutoff): boolean {
  return dateISO > cutoff.lastDay;
}
