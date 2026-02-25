/**
 * Zentrale Formatierungs-Utilities für CareConnect
 * 
 * Diese Datei enthält alle Formatierungsfunktionen für:
 * - Währungsbeträge (Cent → Euro)
 * - Datums-Anzeige (verschiedene deutsche Formate)
 * 
 * WICHTIG: Immer diese zentralen Funktionen verwenden statt lokale zu definieren.
 */

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
