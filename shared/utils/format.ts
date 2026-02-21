/**
 * Zentrale Formatierungs-Utilities für CareConnect
 * 
 * Diese Datei enthält alle Formatierungsfunktionen für:
 * - Währungsbeträge (Cent → Euro)
 * - Datums-Anzeige (verschiedene deutsche Formate)
 * 
 * WICHTIG: Immer diese zentralen Funktionen verwenden statt lokale zu definieren.
 */

import { parseLocalDate, formatDateForDisplay } from "./datetime";

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
 * @deprecated Use formatDateForDisplay from @shared/utils/datetime instead.
 * 
 * Formatiert einen Datumsstring für die deutsche Anzeige.
 * Delegates to formatDateForDisplay() from datetime.ts.
 * 
 * @param dateStr - Datumsstring im Format "YYYY-MM-DD" oder ISO-Timestamp "YYYY-MM-DDTHH:mm:ss"
 * @param style - Anzeigeformat
 *   - "short": "04.12.2025"
 *   - "medium": "4. Dez. 2025"
 *   - "long": "4. Dezember 2025"
 *   - "relative": "Heute", "Gestern", "Morgen" wenn passend
 * @returns Formatierter deutscher Datumsstring
 */
export function formatDateDisplay(
  dateStr: string,
  style: "short" | "medium" | "long" | "relative" = "short"
): string {
  if (!dateStr) return "";
  
  const dateOnly = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  
  if (style === "relative") {
    const date = parseLocalDate(dateOnly);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "Heute";
    if (diffDays === 1) return "Morgen";
    if (diffDays === -1) return "Gestern";
  }
  
  if (style === "medium") {
    const date = parseLocalDate(dateOnly);
    const months = [
      "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni",
      "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."
    ];
    return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}`;
  }
  
  if (style === "long") {
    return formatDateForDisplay(dateOnly, { day: "numeric", month: "long", year: "numeric" });
  }
  
  return formatDateForDisplay(dateOnly);
}

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
