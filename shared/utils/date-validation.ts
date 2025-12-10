/**
 * Zentrale Date-Validierung für Backend und Frontend
 * 
 * Alle Datumsfelder in der App verwenden das ISO-Format "YYYY-MM-DD" für die Speicherung.
 * Diese Utility-Funktionen stellen sicher, dass Datumsstrings konsistent validiert werden.
 */

import { z } from "zod";

/**
 * ISO Date String Format: "YYYY-MM-DD"
 * Beispiele: "2025-12-10", "1985-03-04"
 */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Prüft, ob ein String ein gültiges ISO-Datum ist
 */
export function isValidISODate(dateString: string): boolean {
  if (!ISO_DATE_REGEX.test(dateString)) {
    return false;
  }
  
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * Parst einen ISO-Datumsstring zu einem Date-Objekt
 * Gibt null zurück wenn ungültig
 */
export function parseISODate(dateString: string | null | undefined): Date | null {
  if (!dateString || !isValidISODate(dateString)) {
    return null;
  }
  
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Formatiert ein Date-Objekt zu einem ISO-Datumsstring
 */
export function formatToISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Gibt das heutige Datum als ISO-String zurück
 */
export function todayISODate(): string {
  return formatToISODate(new Date());
}

/**
 * Zod-Schema für optionale ISO-Datumsstrings
 * Verwendet für Formulare und API-Validierung
 */
export const isoDateSchema = z.string()
  .refine((val) => isValidISODate(val), {
    message: "Ungültiges Datumsformat. Bitte verwenden Sie das Format JJJJ-MM-TT.",
  });

/**
 * Zod-Schema für optionale ISO-Datumsstrings (nullable)
 */
export const isoDateOptionalSchema = z.string()
  .refine((val) => val === "" || isValidISODate(val), {
    message: "Ungültiges Datumsformat. Bitte verwenden Sie das Format JJJJ-MM-TT.",
  })
  .transform((val) => val === "" ? null : val)
  .nullable();

/**
 * Prüft, ob ein Datum in der Vergangenheit liegt (ohne die Uhrzeit zu berücksichtigen)
 */
export function isDateInPast(dateString: string): boolean {
  const date = parseISODate(dateString);
  if (!date) return false;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  
  return date < today;
}

/**
 * Prüft, ob ein Datum heute ist
 */
export function isDateToday(dateString: string): boolean {
  const date = parseISODate(dateString);
  if (!date) return false;
  
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

/**
 * Prüft, ob ein Datum in der Zukunft liegt
 */
export function isDateInFuture(dateString: string): boolean {
  const date = parseISODate(dateString);
  if (!date) return false;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  
  return date > today;
}

/**
 * Berechnet die Differenz in Tagen zwischen zwei Datumsstrings
 * Positiv wenn date2 nach date1 liegt
 */
export function daysDifference(date1: string, date2: string): number | null {
  const d1 = parseISODate(date1);
  const d2 = parseISODate(date2);
  
  if (!d1 || !d2) return null;
  
  const diffTime = d2.getTime() - d1.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Fügt Tage zu einem Datum hinzu und gibt den neuen ISO-String zurück
 */
export function addDaysToDate(dateString: string, days: number): string | null {
  const date = parseISODate(dateString);
  if (!date) return null;
  
  date.setDate(date.getDate() + days);
  return formatToISODate(date);
}
