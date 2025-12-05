/**
 * Date Utilities
 * 
 * Zeitzonen-sichere Datums-Funktionen für die Anwendung.
 * 
 * WICHTIG: Datumsstrings im Format "YYYY-MM-DD" niemals direkt mit 
 * `new Date(dateString)` parsen! JavaScript interpretiert diese als 
 * UTC-Mitternacht, was bei der Konvertierung in die lokale Zeitzone 
 * zu Verschiebungen um einen Tag führen kann.
 */

/**
 * Parst einen Datumsstring im Format "YYYY-MM-DD" zeitzonen-sicher.
 * Gibt ein Date-Objekt zurück, das Mitternacht in der lokalen Zeitzone darstellt.
 * 
 * @param dateString - Datumsstring im Format "YYYY-MM-DD"
 * @returns Date-Objekt in lokaler Zeitzone
 * 
 * @example
 * const date = parseLocalDate("2025-12-04");
 * // Gibt Date für 4. Dezember 2025 00:00:00 lokale Zeit zurück
 */
export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Formatiert ein Date-Objekt als "YYYY-MM-DD" String.
 * 
 * @param date - Das zu formatierende Date-Objekt
 * @returns Datumsstring im Format "YYYY-MM-DD"
 */
export function formatDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Formatiert einen Datumsstring für die deutsche Anzeige.
 * 
 * @param dateString - Datumsstring im Format "YYYY-MM-DD"
 * @param options - Intl.DateTimeFormatOptions für die Formatierung
 * @returns Formatierter deutscher Datumsstring
 * 
 * @example
 * formatDateForDisplay("2025-12-04", { day: "numeric", month: "long" });
 * // Gibt "4. Dezember" zurück
 */
export function formatDateForDisplay(
  dateString: string,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }
): string {
  const date = parseLocalDate(dateString);
  return date.toLocaleDateString("de-DE", options);
}

/**
 * Gibt heute als "YYYY-MM-DD" String zurück.
 */
export function getTodayString(): string {
  return formatDateString(new Date());
}

/**
 * Prüft ob ein Datumsstring heute ist.
 */
export function isToday(dateString: string): boolean {
  return dateString === getTodayString();
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

/**
 * Berechnet die Differenz in Tagen zwischen zwei Datumsstrings.
 * 
 * @returns Positive Zahl wenn date2 nach date1 liegt, negative wenn davor
 */
export function daysBetween(date1: string, date2: string): number {
  const d1 = parseLocalDate(date1);
  const d2 = parseLocalDate(date2);
  const diffTime = d2.getTime() - d1.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}
