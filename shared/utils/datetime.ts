/**
 * Zentrale Datum/Zeit-Utilities für CareConnect
 * 
 * WICHTIG: Das System verwendet "Variante C: Lokale Zeiten ohne Zeitzone"
 * - Alle Zeiten sind implizit "deutsche Ortszeit"
 * - Keine UTC-Konvertierung nötig
 * - Datenbank speichert: date als "YYYY-MM-DD", time als "HH:MM:SS"
 * 
 * @see replit.md für vollständige Dokumentation
 */

export interface ParsedTime {
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Parst einen Datums-String "YYYY-MM-DD" zu einem Date-Objekt (lokale Mitternacht)
 * WICHTIG: Niemals new Date("2025-12-04") verwenden - führt zu UTC-Problemen!
 */
export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Parst einen Zeit-String "HH:MM:SS" oder "HH:MM" zu ParsedTime
 */
export function parseLocalTime(timeString: string): ParsedTime {
  const parts = timeString.split(":").map(Number);
  return {
    hours: parts[0] || 0,
    minutes: parts[1] || 0,
    seconds: parts[2] || 0,
  };
}

/**
 * Formatiert ein Date-Objekt zu "YYYY-MM-DD" (ISO-Format für Datenbank)
 */
export function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Formatiert eine Zeit zu "HH:MM" für Anzeige
 * Akzeptiert: "HH:MM:SS", "HH:MM", Date-Objekt, oder ISO-Timestamp-String
 */
export function formatTimeHHMM(time: string | Date): string {
  if (time instanceof Date) {
    const hours = String(time.getHours()).padStart(2, "0");
    const minutes = String(time.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  
  // Handle ISO timestamp string (e.g., "2025-12-02T09:45:00.000Z")
  if (time.includes("T")) {
    const date = new Date(time);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  
  // Handle time string "HH:MM:SS" or "HH:MM"
  const parts = time.split(":");
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Formatiert eine Zeit zu "HH:MM:SS" für Datenbank
 * Akzeptiert: Date-Objekt, "HH:MM", oder bereits formatiert "HH:MM:SS"
 */
export function formatTimeHHMMSS(time: string | Date): string {
  if (time instanceof Date) {
    const hours = String(time.getHours()).padStart(2, "0");
    const minutes = String(time.getMinutes()).padStart(2, "0");
    const seconds = String(time.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }
  
  // Handle ISO timestamp string
  if (time.includes("T")) {
    const date = new Date(time);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }
  
  // If already "HH:MM:SS", return as-is
  const parts = time.split(":");
  if (parts.length === 3) {
    return time;
  }
  
  // If "HH:MM", add seconds
  return `${parts[0]}:${parts[1]}:00`;
}

/**
 * Kombiniert Datum und Zeit zu einem Date-Objekt (lokale Zeit)
 */
export function combineDateAndTime(dateString: string, timeString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  const parsed = parseLocalTime(timeString);
  return new Date(year, month - 1, day, parsed.hours, parsed.minutes, parsed.seconds);
}

/**
 * Konvertiert eine Zeit zu Minuten seit Mitternacht
 * Akzeptiert: "HH:MM:SS", "HH:MM", Date-Objekt, oder ISO-Timestamp-String
 * 
 * WICHTIG: Diese Funktion ist robust gegen verschiedene Eingabeformate,
 * da Drizzle je nach Spaltentyp unterschiedliche Typen zurückgibt.
 */
export function timeToMinutes(time: string | Date | null | undefined): number {
  if (time === null || time === undefined) {
    return 0;
  }
  
  // Handle Date object
  if (time instanceof Date) {
    return time.getHours() * 60 + time.getMinutes();
  }
  
  // Handle ISO timestamp string (e.g., "2025-12-02T09:45:00.000Z")
  if (typeof time === "string" && time.includes("T")) {
    const date = new Date(time);
    return date.getHours() * 60 + date.getMinutes();
  }
  
  // Handle time string "HH:MM:SS" or "HH:MM"
  if (typeof time === "string") {
    const parts = time.split(":").map(Number);
    const hours = parts[0] || 0;
    const minutes = parts[1] || 0;
    return hours * 60 + minutes;
  }
  
  return 0;
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

/**
 * Berechnet die Differenz zwischen zwei Zeiten in Minuten
 * Akzeptiert: "HH:MM:SS", "HH:MM", Date-Objekt, oder ISO-Timestamp-String
 */
export function timeDifferenceMinutes(startTime: string | Date, endTime: string | Date): number {
  return timeToMinutes(endTime) - timeToMinutes(startTime);
}

/**
 * Addiert Minuten zu einer Zeit und gibt das Ergebnis als "HH:MM:SS" zurück
 */
export function addMinutesToTime(timeString: string, minutesToAdd: number): string {
  const currentMinutes = timeToMinutes(timeString);
  return minutesToTime(currentMinutes + minutesToAdd);
}

/**
 * Prüft ob eine Zeit zwischen zwei anderen Zeiten liegt (inklusiv)
 */
export function isTimeBetween(
  time: string | Date,
  startTime: string | Date,
  endTime: string | Date
): boolean {
  const timeMinutes = timeToMinutes(time);
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
}

/**
 * Formatiert Minuten als Stunden:Minuten String für Anzeige (z.B. "2:30 Std")
 */
export function formatDurationDisplay(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} Min`;
  }
  if (minutes === 0) {
    return `${hours} Std`;
  }
  return `${hours}:${String(minutes).padStart(2, "0")} Std`;
}

/**
 * Formatiert ein Datum für die deutsche Anzeige (z.B. "04.12.2025" oder "4. Dezember 2025")
 */
export function formatDateGerman(date: Date | string, style: "short" | "long" = "short"): string {
  const d = typeof date === "string" ? parseLocalDate(date) : date;
  
  if (style === "long") {
    const months = [
      "Januar", "Februar", "März", "April", "Mai", "Juni",
      "Juli", "August", "September", "Oktober", "November", "Dezember"
    ];
    return `${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`;
  }
  
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

/**
 * Gibt den Wochentag zurück (Montag = 0, Sonntag = 6)
 * JavaScript Date verwendet Sonntag = 0, daher Konvertierung
 */
export function getWeekdayIndex(date: Date | string): number {
  const d = typeof date === "string" ? parseLocalDate(date) : date;
  const jsDay = d.getDay(); // 0 = Sunday
  return jsDay === 0 ? 6 : jsDay - 1; // Convert to Monday = 0
}

/**
 * Gibt den deutschen Wochentagsnamen zurück
 */
export function getWeekdayName(date: Date | string, style: "short" | "long" = "short"): string {
  const shortNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const longNames = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const index = getWeekdayIndex(date);
  return style === "long" ? longNames[index] : shortNames[index];
}

/**
 * Prüft ob zwei Datums-Strings den gleichen Tag repräsentieren
 */
export function isSameDay(date1: string | Date, date2: string | Date): boolean {
  const d1 = typeof date1 === "string" ? date1 : formatDateISO(date1);
  const d2 = typeof date2 === "string" ? date2 : formatDateISO(date2);
  return d1 === d2;
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
