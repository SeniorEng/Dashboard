/**
 * Zentrale Datum/Zeit-Utilities für CareConnect
 * 
 * KONVENTIONEN (verbindlich für alle Implementierungen):
 * 
 * 1. SPEICHERFORMATE (Datenbank):
 *    - Datum: "YYYY-MM-DD" (PostgreSQL `date`)
 *    - Uhrzeit: "HH:MM:SS" (PostgreSQL `time without time zone`)
 *    - Dauer: Integer in Minuten (PostgreSQL `integer`)
 *    - Systemzeitstempel: `timestamptz` (created_at, updated_at etc.)
 * 
 * 2. ANZEIGEFORMATE (Frontend):
 *    - Uhrzeit: "HH:MM" (Sekunden werden nie angezeigt)
 *    - Datum: "DD.MM.YYYY" (deutsch) oder "YYYY-MM-DD" (Formulare)
 * 
 * 3. VERBOTENE PATTERNS:
 *    - NIEMALS `new Date()` für Uhrzeiten verwenden → Zeitzonen-Probleme!
 *    - NIEMALS Date-Objekte an Zeit-Utilities übergeben
 *    - NIEMALS ISO-Timestamps ("2025-12-02T09:45:00.000Z") für lokale Zeiten
 *    - Alle Zeit-Funktionen akzeptieren NUR Strings
 * 
 * 4. SICHERE ALTERNATIVE für "aktuelle Uhrzeit":
 *    - `currentTimeHHMMSS()` → gibt "HH:MM:SS" als String zurück
 *    - `todayISO()` → gibt "YYYY-MM-DD" als String zurück
 * 
 * @see replit.md für vollständige Dokumentation
 */
import { format as dfFormat } from "date-fns";
import { de } from "date-fns/locale";

interface ParsedTime {
  hours: number;
  minutes: number;
  seconds: number;
}

// ============================================================
// UHR-NAHT (§45b-Präventions-Cluster Welle 1 — injizierbare Uhr)
// ============================================================

/**
 * Die EINE Stelle, an der dieses Repo „jetzt" liest.
 *
 * Alle „aktuelle Zeit"-Funktionen dieser Datei (`todayISO`, `isPast`,
 * `currentTimeHHMMSS`, die Geburtsdatums-Prüfungen) gehen hierdurch — und damit
 * mittelbar auch `currentYearAndMonth()`, das auf `todayISO()` aufsetzt. Die
 * ~150 Aufrufstellen im Repo erben die Naht, ohne angefasst zu werden.
 *
 * ── Warum es diese Naht gibt ────────────────────────────────────────────
 * Die §45b-Fristen (Verfall strikt 30.06., Halbjahres-Boden, Jahreswechsel)
 * sind ohne bewegliche Uhr nicht prüfbar. `vi.setSystemTime`
 * (`tests/helpers/frozen-clock.ts`) wirkt NUR im Testprozess; die
 * Integrationstests sprechen aber einen eigenständigen App-Server an, der seine
 * eigene Systemzeit liest. Genau daran scheiterte die bisherige Umgehung, die
 * `tests/helpers/billing-month.ts` in ihrer Anker-Familie dokumentiert
 * („einen Clock-Override kennt der Server nicht").
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────
 * `setClockProvider` wirft außerhalb `NODE_ENV === "test"`. Der Default ist die
 * Echt-Uhr; in Produktion ist die Naht ein einzelner Funktionsaufruf und sonst
 * nichts. Die Server-Middleware, die den `X-Test-Clock`-Header liest, wird
 * außerhalb `NODE_ENV === "test"` gar nicht erst registriert — der Header
 * trifft dort auf keinen Leser. Bewacht von
 * `tests/architecture/injectable-clock.test.ts`.
 *
 * ── Client-Sicherheit ───────────────────────────────────────────────────
 * Hier steht bewusst NUR die Funktionsreferenz. Die AsyncLocalStorage-Mechanik
 * (`node:async_hooks`) liegt in `server/lib/test-clock.ts` — diese Datei wird
 * auch in den Browser gebündelt und darf keinen `node:`-Import bekommen. Der
 * Client setzt nie einen Provider und läuft damit immer auf der Echt-Uhr.
 */
type ClockProvider = () => Date;

const REAL_CLOCK: ClockProvider = () => new Date();

let clockProvider: ClockProvider = REAL_CLOCK;

/** `true`, wenn wir nachweislich im Testlauf sind (auch im Browser-Bundle sicher). */
function isTestEnv(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.NODE_ENV === "test"
  );
}

/**
 * Interner Zugriff auf „jetzt". Alle Now-Leser dieser Datei benutzen ihn.
 *
 * Liefert bewusst immer eine KOPIE: Aufrufer wie `isPast` rufen
 * `setHours(0,0,0,0)` auf dem Ergebnis auf. Gäbe ein Provider dieselbe
 * `Date`-Instanz mehrfach heraus (`() => festesDatum` ist die naheliegende
 * Test-Schreibweise), würde der erste Aufrufer die Uhr dauerhaft auf
 * Mitternacht mutieren.
 */
function nowDate(): Date {
  return new Date(clockProvider().getTime());
}

/**
 * Setzt die Uhr-Quelle. NUR für Tests — wirft außerhalb `NODE_ENV === "test"`,
 * damit ein versehentlicher Produktiv-Aufruf laut scheitert statt still die
 * Systemzeit zu verbiegen.
 */
export function setClockProvider(provider: ClockProvider): void {
  if (!isTestEnv()) {
    throw new Error(
      "setClockProvider ist nur unter NODE_ENV=test erlaubt (aktuell: " +
        `${typeof process !== "undefined" ? process.env?.NODE_ENV ?? "undefined" : "kein process"}). ` +
        "Die injizierbare Uhr ist ein Test-Werkzeug, kein Produktiv-Schalter.",
    );
  }
  clockProvider = provider;
}

/**
 * Stellt die Echt-Uhr wieder her. Bewusst OHNE Env-Guard und idempotent: der
 * Weg ZURÜCK zur Systemzeit muss immer offenstehen (Sicherheitsnetz in
 * `tests/setup.ts#afterEach`, analog zu `thawTime`).
 */
export function resetClockProvider(): void {
  clockProvider = REAL_CLOCK;
}

// ============================================================
// DATUM-FUNKTIONEN
// ============================================================

/**
 * Parst einen Datums-String "YYYY-MM-DD" zu einem Date-Objekt (lokale Mitternacht)
 * Nur für Berechnungen (Wochentag, Datumsvergleiche) verwenden,
 * NICHT für Zeitberechnungen!
 */
export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Formatiert ein Date-Objekt zu "YYYY-MM-DD" (ISO-Format für Datenbank)
 * Nur für Datum-Berechnungen (addDays etc.) verwenden.
 */
export function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Gibt das heutige Datum als "YYYY-MM-DD" zurück
 */
export function todayISO(): string {
  return formatDateISO(nowDate());
}

/**
 * Berechnet das Datum in n Tagen als "YYYY-MM-DD"
 */
export function addDays(dateString: string, days: number): string {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return formatDateISO(date);
}

/**
 * Gibt den Wochentag zurück (Montag = 0, Sonntag = 6)
 * @param dateStr - Datum als "YYYY-MM-DD" String
 */
function getWeekdayIndex(dateStr: string): number {
  const d = parseLocalDate(dateStr);
  const jsDay = d.getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

/**
 * Prüft ob ein Datum auf ein Wochenende (Samstag oder Sonntag) fällt
 * @param dateStr - Datum als "YYYY-MM-DD" String
 */
export function isWeekend(dateStr: string): boolean {
  const index = getWeekdayIndex(dateStr);
  return index >= 5;
}

/**
 * Formatiert einen Datumsstring für die deutsche Anzeige mit Intl.DateTimeFormat.
 * Flexibler als formatDateGerman() - akzeptiert beliebige DateTimeFormatOptions.
 * @param dateString - Datumsstring im Format "YYYY-MM-DD"
 * @param options - Intl.DateTimeFormatOptions für die Formatierung
 */
export function formatDateForDisplay(
  dateString: string,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }
): string {
  const date = parseLocalDate(dateString);
  return date.toLocaleDateString("de-DE", options);
}

/**
 * Prüft ob ein "YYYY-MM-DD"-String einem real existierenden Kalenderdatum
 * entspricht (fängt z. B. den 31. Februar oder den 13. Monat ab).
 * @param dateStr - Datum als "YYYY-MM-DD" String
 */
export function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Prüft ob ein Datumsstring in der Vergangenheit liegt.
 */
export function isPast(dateString: string): boolean {
  const date = parseLocalDate(dateString);
  const today = nowDate();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

/**
 * Prüft, ob ein Datums-String "YYYY-MM-DD" das heutige Datum ist.
 */
export function isToday(dateString: string): boolean {
  return dateString === todayISO();
}

/**
 * Prüft, ob ein Datums-String "YYYY-MM-DD" der morgige Tag ist.
 */
export function isTomorrow(dateString: string): boolean {
  return dateString === addDays(todayISO(), 1);
}

/**
 * Prüft, ob ein String ein gültiges Datum "YYYY-MM-DD" ergibt.
 */
export function isValidDateString(dateString: string): boolean {
  if (!dateString) return false;
  const date = parseLocalDate(dateString);
  return !Number.isNaN(date.getTime());
}

/**
 * Zentrale deutschsprachige Datumsformatierung via date-fns + de-Locale.
 * Bündelt die date-fns-Locale-Nutzung an EINER Stelle (Task #928), statt sie
 * über UI-Dateien zu streuen. Akzeptiert ein Date-Objekt ODER einen ISO-String
 * "YYYY-MM-DD" (lokal geparst). `pattern` ist ein date-fns-Format-Token-String
 * (z.B. "EEEE, d. MMMM", "d. MMM yyyy", "MMMM yyyy").
 */
export function formatGermanDate(date: Date | string, pattern: string): string {
  const d = typeof date === "string" ? parseLocalDate(date) : date;
  return dfFormat(d, pattern, { locale: de });
}

/**
 * Montag 00:00 (lokal) der Woche, in der `date` liegt. Date-Objekt-Variante
 * für UI-Wochenberechnungen (entspricht date-fns `startOfWeek(d, { weekStartsOn: 1 })`).
 */
export function startOfWeekMonday(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysSinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysSinceMonday);
  return d;
}

/**
 * `date` plus `days` Tage als neues Date-Objekt (lokal, Uhrzeit bleibt erhalten).
 * Date-Objekt-Variante von `addDays` (das mit Strings arbeitet).
 */
export function addDaysToDate(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * `date` plus `weeks` Wochen als neues Date-Objekt.
 */
export function addWeeksToDate(date: Date, weeks: number): Date {
  return addDaysToDate(date, weeks * 7);
}

/**
 * Prüft, ob zwei Date-Objekte auf denselben Kalendertag (lokal) fallen.
 * Uhrzeit wird ignoriert (entspricht date-fns `isSameDay`).
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return formatDateISO(a) === formatDateISO(b);
}

// ============================================================
// ZEIT-FUNKTIONEN (NUR Strings, KEINE Date-Objekte!)
// ============================================================

/**
 * Parst einen Zeit-String "HH:MM:SS" oder "HH:MM" zu ParsedTime
 * @param timeString - Zeit als "HH:MM" oder "HH:MM:SS"
 */
function parseLocalTime(timeString: string): ParsedTime {
  const parts = timeString.split(":").map(Number);
  return {
    hours: parts[0] || 0,
    minutes: parts[1] || 0,
    seconds: parts[2] || 0,
  };
}

/**
 * Gibt die aktuelle Uhrzeit als "HH:MM:SS" String zurück.
 * Dies ist die EINZIGE Stelle wo `new Date()` für Uhrzeiten erlaubt ist.
 */
export function currentTimeHHMMSS(): string {
  const now = nowDate();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Gibt die aktuelle Uhrzeit als "HH:MM" String zurück.
 */
export function currentTimeHHMM(): string {
  return currentTimeHHMMSS().slice(0, 5);
}

/**
 * Formatiert eine Zeit zu "HH:MM" für Anzeige
 * @param time - Zeit als "HH:MM:SS" oder "HH:MM" String
 */
export function formatTimeHHMM(time: string): string {
  const parts = time.split(":");
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Formatiert eine Zeit zu "HH:MM:SS" für Datenbank
 * @param time - Zeit als "HH:MM" oder bereits "HH:MM:SS" String
 */
export function formatTimeHHMMSS(time: string): string {
  const parts = time.split(":");
  if (parts.length === 3) {
    return time;
  }
  return `${parts[0]}:${parts[1]}:00`;
}

/**
 * Addiert Minuten zu einer Zeit und gibt das Ergebnis als "HH:MM" zurück.
 * @param time - Zeit als "HH:MM" oder "HH:MM:SS" String
 * @param minutes - Anzahl Minuten zum Addieren
 */
export function addMinutesToTime(time: string, minutes: number): string {
  const parsed = parseLocalTime(time);
  const totalMinutes = parsed.hours * 60 + parsed.minutes + minutes;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Addiert Minuten zu einer Zeit und gibt das Ergebnis als "HH:MM:SS" zurück.
 * @param time - Zeit als "HH:MM" oder "HH:MM:SS" String
 * @param minutes - Anzahl Minuten zum Addieren
 */
export function addMinutesToTimeHHMMSS(time: string, minutes: number): string {
  return addMinutesToTime(time, minutes) + ":00";
}

/**
 * Konvertiert eine Zeit zu Minuten seit Mitternacht
 * @param time - Zeit als "HH:MM" oder "HH:MM:SS" String, oder null/undefined
 * @returns Minuten seit Mitternacht (0 bei null/undefined)
 */
export function timeToMinutes(time: string | null | undefined): number {
  if (time === null || time === undefined) {
    return 0;
  }

  const parts = time.split(":").map(Number);
  const hours = parts[0] || 0;
  const minutes = parts[1] || 0;
  return hours * 60 + minutes;
}

/**
 * Konvertiert Minuten seit Mitternacht zu "HH:MM" für Anzeige
 */
export function minutesToTimeDisplay(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// ============================================================
// DAUER-FUNKTIONEN
// ============================================================

/**
 * Formatiert Minuten als Stunden:Minuten String für Anzeige
 * @param totalMinutes - Gesamtminuten
 * @param style - "compact" für "2:30 Std", "verbose" für "2 Std. 30 Min."
 */
export function formatDurationDisplay(totalMinutes: number, style: "compact" | "verbose" = "compact"): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (style === "verbose") {
    if (hours === 0) return `${minutes} Min.`;
    if (minutes === 0) return `${hours} Std.`;
    return `${hours} Std. ${minutes} Min.`;
  }

  if (hours === 0) {
    return `${minutes} Min`;
  }
  if (minutes === 0) {
    return `${hours} Std`;
  }
  return `${hours}:${String(minutes).padStart(2, "0")} Std`;
}

/**
 * Validiert ein Geburtsdatum auf Plausibilität.
 * @param geburtsdatum - Datum als "YYYY-MM-DD" String
 * @returns null wenn gültig, sonst deutsche Fehlermeldung
 */
export function validateGeburtsdatum(geburtsdatum: string | null | undefined): string | null {
  if (!geburtsdatum) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(geburtsdatum)) {
    return "Geburtsdatum muss im Format YYYY-MM-DD sein";
  }

  const birth = parseLocalDate(geburtsdatum);
  if (isNaN(birth.getTime())) {
    return "Ungültiges Geburtsdatum";
  }

  const today = nowDate();
  today.setHours(0, 0, 0, 0);

  if (birth >= today) {
    return "Geburtsdatum muss in der Vergangenheit liegen";
  }

  const ageDiff = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  const age = monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate()) ? ageDiff - 1 : ageDiff;

  if (age > 120) {
    return "Geburtsdatum ist unplausibel (Person wäre über 120 Jahre alt)";
  }

  return null;
}

export function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


function firstDayOfYear(year: number): string {
  return `${year}-01-01`;
}

export function currentYearAndMonth(): { year: number; month: number } {
  const d = parseLocalDate(todayISO());
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * Parst einen System-Zeitstempel (z. B. von einer `timestamptz`-Spalte oder
 * einem `created_at`/`updated_at`-Feld) zu einem `Date`-Objekt.
 *
 * - Erlaubt: vollständige ISO-8601-Strings inkl. Timezone-Suffix
 *   (z. B. "2026-04-28T15:30:00.000Z") sowie `Date`-Objekte (Pass-Through).
 * - Verboten: reine "YYYY-MM-DD"-Strings → dafür `parseLocalDate` nutzen,
 *   sonst entstehen Off-by-one-Bugs beim Wechsel zwischen UTC und CET.
 *
 * Diese Funktion ist die einzige Stelle, an der `new Date(stringVar)` für
 * Zeitstempel-Strings benutzt werden darf. So bleibt das Verbot aus K2
 * (Tiefenanalyse 2026-04-18) projektweit konsequent durchsetzbar.
 */
export function parseTimestamp(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new TypeError(`parseTimestamp: erwartet string|Date, erhielt ${typeof value}`);
  }
  // YYYY-MM-DD ohne Zeit-Anteil → Aufrufer hat das falsche Werkzeug gewählt.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(
      `parseTimestamp: "${value}" ist ein Datums-String ohne Zeitzone. Bitte parseLocalDate() verwenden.`
    );
  }
  return new Date(value);
}

export function isChild(geburtsdatum: string | null): boolean {
  if (!geburtsdatum) return false;
  const birth = parseLocalDate(geburtsdatum);
  const today = nowDate();
  const age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    return age - 1 < 18;
  }
  return age < 18;
}
