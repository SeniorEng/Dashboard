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

export interface ParsedTime {
  hours: number;
  minutes: number;
  seconds: number;
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
  return formatDateISO(new Date());
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
 * Prüft ob zwei Datums-Strings den gleichen Tag repräsentieren
 * @param date1 - Datum als "YYYY-MM-DD" String
 * @param date2 - Datum als "YYYY-MM-DD" String
 */
export function isSameDay(date1: string, date2: string): boolean {
  return date1 === date2;
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
 * Prüft ob ein Datumsstring heute ist.
 */
export function isToday(dateString: string): boolean {
  return dateString === todayISO();
}

/**
 * Prüft ob ein Datumsstring in der Vergangenheit liegt.
 */
export function isPast(dateString: string): boolean {
  const date = parseLocalDate(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
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
  const now = new Date();
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
 * Konvertiert Minuten seit Mitternacht zu "HH:MM:SS"
 */
export function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
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

export function isChild(geburtsdatum: string | null): boolean {
  if (!geburtsdatum) return false;
  const birth = parseLocalDate(geburtsdatum);
  const today = new Date();
  const age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    return age - 1 < 18;
  }
  return age < 18;
}
