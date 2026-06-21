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
  // Re-export-Shim auf den zentralen Money-Helper (Task #441).
  // Bitte direkt `formatEuroDE` aus `@shared/utils/money` verwenden — dieser
  // Wrapper bleibt für Bestandscode erhalten.
  return formatEuroDE(cents, options);
}

export { formatEuroDE, parseEuroDE, centsToEuroNumber } from "./money";
import { formatEuroDE } from "./money";
import { quantizeKm } from "@shared/domain/invoice-line-items";

/**
 * Task #616 — km wird projektweit mit 2 NK angezeigt (gleiche Quantisierung
 * wie in Rechnungs-Line-Items, Task #561). Vorher lieferte `formatKm` 1 NK,
 * was im Budget-Ledger zu „70,0 km" statt „7,30 km" führte und damit
 * Anzeige ≠ Buchung erzeugte.
 */
export function formatKm(km: number | string | null | undefined): string {
  const n = quantizeKm(Number(km ?? 0));
  return n.toFixed(2).replace(".", ",");
}

/**
 * Task #616 — Parsed eine deutsche Dezimaleingabe ("7,3" → 7.3) NaN-sicher.
 * Akzeptiert auch englisches Format (Punkt) für maschinell vorbefüllte
 * Werte. Wird in allen km/Stunden-Inputs der Doku-Routen verwendet, damit
 * "7,3" nicht stillschweigend zu 7 oder 73 wird.
 */
export function parseGermanDecimal(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const normalized = String(value).trim().replace(",", ".");
  if (normalized === "") return 0;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Formatiert eine Tageszahl im deutschen Format (Komma statt Punkt). Trimmt
 * unnötige Nachkommastellen, behält aber bis zu 2 Dezimalstellen, wenn der
 * Wert nicht ganzzahlig ist (z. B. 17,5 oder 17,42).
 */
export function formatVacationDays(days: number | string | null | undefined): string {
  const n = Number(days ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return n.toString();
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Task #1372 — Normalisiert einen Personennamen einheitlich auf
 * „Nachname, Vorname". Verwendet im Leistungsnachweis, damit alle Belege
 * dieselbe Schreibweise tragen (statt mal „Krawalski, Lothar", mal
 * „Gertraude Falk").
 *
 * Sind `vorname` UND `nachname` vorhanden, wird „Nachname, Vorname"
 * zusammengesetzt. Fehlt eines (Bestandsdaten ohne strukturierte Felder),
 * fällt die Funktion auf den `fallback` (i.d.R. der zusammengesetzte
 * `name`) zurück, damit nie ein leerer oder unvollständiger Name entsteht.
 */
export function formatCustomerNameLastFirst(
  vorname: string | null | undefined,
  nachname: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const v = (vorname ?? "").trim();
  const n = (nachname ?? "").trim();
  if (v && n) return `${n}, ${v}`;
  const fb = (fallback ?? "").trim();
  if (fb) return fb;
  // Letzter Rückfall: einzeln vorhandener Teil (besser als leer).
  return n || v;
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
