/**
 * Zentrale Formatierungs-Utilities für CareConnect
 * 
 * Diese Datei enthält alle Formatierungsfunktionen für:
 * - Währungsbeträge (Cent → Euro)
 * - Datums-Anzeige (verschiedene deutsche Formate)
 * 
 * WICHTIG: Immer diese zentralen Funktionen verwenden statt lokale zu definieren.
 */

import { parseLocalDate } from "./datetime";

/**
 * Formatiert einen Cent-Betrag als Euro-String mit deutschem Format.
 * 
 * @param cents - Betrag in Cent (z.B. 12550 für 125,50€)
 * @param options - Optionale Formatierungsoptionen
 * @returns Formatierter String (z.B. "125,50 €")
 * 
 * @example
 * formatCurrency(12550) → "125,50 €"
 * formatCurrency(0) → "0,00 €"
 * formatCurrency(-500) → "-5,00 €"
 */
export function formatCurrency(cents: number, options?: { showSign?: boolean }): string {
  const euros = cents / 100;
  const formatted = euros.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  
  if (options?.showSign && cents > 0) {
    return `+${formatted}`;
  }
  
  return formatted;
}

/**
 * Formatiert einen Cent-Betrag als Euro-String ohne Währungssymbol.
 * 
 * @param cents - Betrag in Cent
 * @returns Formatierter String (z.B. "125,50")
 */
export function formatCurrencyValue(cents: number): string {
  const euros = cents / 100;
  return euros.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formatiert einen Euro-Stundensatz.
 * 
 * @param centsPerHour - Stundensatz in Cent
 * @returns Formatierter String (z.B. "25,50 €/Std")
 */
export function formatHourlyRate(centsPerHour: number): string {
  const euros = centsPerHour / 100;
  return `${euros.toLocaleString("de-DE", { minimumFractionDigits: 2 })} €/Std`;
}

/**
 * Formatiert einen Datumsstring für die deutsche Anzeige.
 * 
 * @param dateStr - Datumsstring im Format "YYYY-MM-DD" oder ISO-Timestamp "YYYY-MM-DDTHH:mm:ss"
 * @param style - Anzeigeformat
 *   - "short": "04.12.2025"
 *   - "medium": "4. Dez. 2025"
 *   - "long": "4. Dezember 2025"
 *   - "relative": "Heute", "Gestern", "Morgen" wenn passend
 * @returns Formatierter deutscher Datumsstring
 * 
 * @example
 * formatDateDisplay("2025-12-04") → "04.12.2025"
 * formatDateDisplay("2025-12-04T14:30:00.000Z") → "04.12.2025"
 * formatDateDisplay("2025-12-04", "long") → "4. Dezember 2025"
 */
export function formatDateDisplay(
  dateStr: string,
  style: "short" | "medium" | "long" | "relative" = "short"
): string {
  if (!dateStr) return "";
  
  // Handle ISO timestamps by extracting just the date part
  const dateOnly = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  const date = parseLocalDate(dateOnly);
  
  if (style === "relative") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    
    const diffDays = Math.round((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "Heute";
    if (diffDays === 1) return "Morgen";
    if (diffDays === -1) return "Gestern";
    // Fall through to short format
  }
  
  if (style === "long") {
    const months = [
      "Januar", "Februar", "März", "April", "Mai", "Juni",
      "Juli", "August", "September", "Oktober", "November", "Dezember"
    ];
    return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}`;
  }
  
  if (style === "medium") {
    const months = [
      "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni",
      "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."
    ];
    return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}`;
  }
  
  // short format (default)
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

/**
 * Formatiert einen Monat und Jahr.
 * 
 * @param year - Jahr (z.B. 2025)
 * @param month - Monat (1-12)
 * @param style - "short" für "Dez 2025", "long" für "Dezember 2025"
 * @returns Formatierter String
 */
export function formatAddress(entity: {
  strasse?: string | null;
  nr?: string | null;
  hausnummer?: string | null;
  plz?: string | null;
  stadt?: string | null;
  address?: string | null;
}): string {
  const parts = [];
  const houseNumber = entity.nr || entity.hausnummer;
  if (entity.strasse) {
    parts.push(`${entity.strasse}${houseNumber ? ` ${houseNumber}` : ""}`);
  }
  if (entity.plz || entity.stadt) {
    parts.push(`${entity.plz || ""} ${entity.stadt || ""}`.trim());
  }
  if (parts.length > 0) return parts.join(", ");
  return entity.address || "Keine Adresse hinterlegt";
}

export function formatMonthYear(
  year: number,
  month: number,
  style: "short" | "long" = "long"
): string {
  const shortMonths = ["Jan", "Feb", "März", "Apr", "Mai", "Juni", "Juli", "Aug", "Sep", "Okt", "Nov", "Dez"];
  const longMonths = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  
  const monthName = style === "long" ? longMonths[month - 1] : shortMonths[month - 1];
  return `${monthName} ${year}`;
}
