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
 * Der Tag von HEUTE in Berliner Zeit (ISO, YYYY-MM-DD).
 *
 * Der Monatsabschluss ist ein Ereignis in Berliner Zeit — der Scheduler rechnet
 * so. Wer daneben `todayISO()` (Server-Lokalzeit) benutzt, bekommt am
 * Cutoff-Tag je nach Container-Zeitzone eine andere Antwort als der Abschluss
 * selbst.
 *
 * Lag bisher als private Funktion im `month-close-scheduler` — hierher gezogen,
 * damit es EINE gibt und nicht zwei.
 */
export function todayBerlinIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

/**
 * Liegt der Cutoff des Monats (year, month) am Tag `today` bereits hinter uns?
 *
 * Ticket 6hWgVqw2C8442hcG. ABGELEITET aus `daysUntilCutoff`, nicht als zweite
 * Datumsrechnung: der Cutoff ist nicht der 8., sondern der 8. mit Rückverlegung
 * über Wochenenden und Feiertage. Wer das nachbaut, baut es irgendwann anders
 * nach.
 *
 * Der Cutoff-Tag SELBST zählt noch NICHT als vorbei: an ihm läuft der Abschluss
 * erst (`autoCloseMonthForCutoff` feuert über `isCutoffDay`). Deshalb `< 0`.
 *
 * ── Warum die Funktion NICHT „istMonatAbgeschlossen" heißt ───────────────
 * Weil sie das nicht beantwortet. „Ist der Monat abgeschlossen?" hat bereits
 * eine kanonische, ZUSTANDS-basierte Antwort: `isMonthClosed(userId, dateStr)`
 * liest `employee_month_closings` und kennt `reopened_at`. Diese hier rechnet
 * nur den Kalender.
 *
 * Und die beiden können auseinanderlaufen: der Auto-Abschluss läuft NUR am
 * Cutoff-Tag und NUR für Mitarbeiter mit Aktivität im Monat. Lief er an dem Tag
 * nicht, oder hatte jemand keine Aktivität, ist sein Monat nie abgeschlossen
 * worden — der Kalender sagt trotzdem „vorbei".
 *
 * Eine erste Fassung hieß `isMonthClosedAt` und war damit ein Zweitbegriff
 * derselben fachlichen Frage mit einer anderen Antwort.
 *
 * `today` ist ein Parameter, kein Aufruf im Rumpf — die Frage hängt wirklich an
 * der Wanduhr, muss aber prüfbar bleiben, ohne die Zeit zu manipulieren.
 */
export function istNachMonatsCutoff(today: string, year: number, month: number): boolean {
  return daysUntilCutoff(today, year, month) < 0;
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

/**
 * Slots der Tages-Entprellung des Monatsabschluss-Schedulers
 * (`server/services/month-close-scheduler.ts`, `runDaily`).
 *
 * Liegt HIER und nicht beim Scheduler, obwohl sie dort hingehört: das
 * Scheduler-Modul zieht beim Import `server/lib/db` mit und verlangt eine
 * `DATABASE_URL`. Eine Konstante hinter einer DB-Abhängigkeit lässt sich nicht
 * als Einheit prüfen — und genau diese Prüfung ist der Punkt.
 *
 * Denn die WERTE müssen paarweise verschieden sein, und der Typ erzwingt das
 * NICHT: `{ reminder: "reminder", autoClose: "reminder" }` typprüft anstandslos.
 * Die Folge wäre schwerer als der Fehler, den die Entprellung behebt — der
 * Auto-Close läse die Marke des Reminders, übersprünge sich selbst, und wegen
 * `isCutoffDay` (strikte Tagesgleichheit) würde der Monat NIE geschlossen,
 * still und ohne Log. Abgesichert in
 * `tests/unit/scheduler-daily-debounce.test.ts`.
 */
export const DAILY_SCHEDULER_SLOTS = {
  reminder: "reminder",
  autoClose: "auto-close",
} as const;

export type DailySchedulerSlot =
  (typeof DAILY_SCHEDULER_SLOTS)[keyof typeof DAILY_SCHEDULER_SLOTS];
