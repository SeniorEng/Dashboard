/**
 * Task #561 — Kilometer-Line-Items: konsistente Quantisierung.
 *
 * Hintergrund: Anfahrts-/Customer-Kilometer kommen als Dezimal-Float aus dem
 * Routing-/GPS-System (z.B. 2,714 km). Vor diesem Modul wurden Anzeige und
 * Berechnung unabhängig gerundet — Folge: Menge × Satz ≠ Summe auf dem PDF,
 * was eine Pflegekasse/GoBD-Prüfung berechtigt zurückweisen würde
 * (siehe Rechnung RE-2026-0003 — Analyse in der Task-Beschreibung).
 *
 * Konvention: GoBD-konform wird die Strecke auf zwei Nachkommastellen
 * kaufmännisch gerundet und genau dieser Wert sowohl ANGEZEIGT als auch
 * BERECHNET. So gilt für jede km-Line garantiert
 *   Math.round(roundedQuantity * unitPriceCents) === totalCents.
 *
 * Wer immer das Rechnungs-PDF oder den Leistungsnachweis berührt, ruft die
 * Helper hier — keine eigene Rundung im Routes-Code oder im Template.
 */

const KM_DECIMALS = 2;

/**
 * Kaufmännische Rundung auf zwei Nachkommastellen. Negative km werden
 * absichtlich beibehalten (z.B. Stornorechnung mit negativem Total — die
 * Strecke bleibt positiv, das Vorzeichen liegt im totalCents).
 */
export function quantizeKm(km: number): number {
  if (!Number.isFinite(km)) return 0;
  const factor = 10 ** KM_DECIMALS;
  return Math.round(km * factor) / factor;
}

/**
 * Liefert den auf Cent gerundeten Gesamtbetrag einer km-Line bei Satz
 * `unitPriceCents` pro Kilometer. Verwendet denselben quantisierten Wert,
 * der auch via `formatKmQuantityDisplay` angezeigt wird.
 */
export function computeKmLineTotalCents(km: number, unitPriceCents: number): number {
  const q = quantizeKm(km);
  return Math.round(q * unitPriceCents);
}

/**
 * Deutsche Anzeige einer km-Strecke mit zwei Nachkommastellen und
 * Komma-Trenner — z.B. `2,71 km`.
 */
export function formatKmQuantityDisplay(km: number): string {
  const q = quantizeKm(km);
  return `${q.toFixed(KM_DECIMALS).replace(".", ",")} km`;
}

/**
 * Deutsche Anzeige einer Stundenleistung (Minuten in `h`/`Min.`).
 * Konsistent zum bestehenden Verhalten von `formatMinutes` im PDF-Template
 * — hier gespiegelt, damit der Template-Code keine eigene Formatierungslogik
 * mehr braucht und Drift unmöglich wird.
 */
export function formatHoursQuantityDisplay(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} Min.`;
  if (rem === 0) return `${h} Std.`;
  return `${h} Std. ${rem} Min.`;
}

export type LineItemQuantityUnit = "hours" | "km";

/**
 * Service-Codes, die als Kilometer-Strecke abgerechnet werden. Zentralisiert,
 * damit Routes/PDF/ZUGFeRD denselben Filter teilen.
 */
export const KM_SERVICE_CODES = new Set<string>(["travel_km", "customer_km"]);

export function isKmLineItem(serviceCode: string | null | undefined): boolean {
  return !!serviceCode && KM_SERVICE_CODES.has(serviceCode);
}

/**
 * Rohwert der Menge für ein Line-Item — Stunden (Dezimal) oder Kilometer
 * (zwei Nachkommastellen). Wird in das neue `quantity_raw`-Feld persistiert
 * und ist die einzige Quelle für PDF-Anzeige und ZUGFeRD-Quantity.
 *
 * - Für Stunden: `durationMinutes / 60` (kann viele Nachkommastellen haben).
 * - Für Kilometer: `quantizeKm(km)`.
 */
export function deriveQuantityRaw(
  unit: LineItemQuantityUnit,
  args: { durationMinutes?: number | null; km?: number | null },
): number {
  if (unit === "km") {
    return quantizeKm(args.km ?? 0);
  }
  const minutes = args.durationMinutes ?? 0;
  return minutes / 60;
}

/**
 * Anzeige-Helper für ein persistiertes Line-Item. Bevorzugt die neuen
 * Felder `quantityRaw`/`quantityUnit` (Task #561). Fällt auf
 * `durationMinutes` + `serviceCode` zurück, damit bestehende
 * Rechnungs-PDFs (vor Migration) unverändert rendern — die historische
 * Drift bleibt für sie sichtbar (GoBD-Immutabilität).
 */
export function renderLineItemQuantity(item: {
  serviceCode: string | null;
  durationMinutes: number;
  quantityRaw?: number | null;
  quantityUnit?: LineItemQuantityUnit | string | null;
}): string {
  const unit = (item.quantityUnit as LineItemQuantityUnit | null | undefined)
    ?? (isKmLineItem(item.serviceCode) ? "km" : "hours");
  if (unit === "km") {
    const km = item.quantityRaw ?? item.durationMinutes;
    return formatKmQuantityDisplay(km);
  }
  // Stunden — historisch wurde der Wert in Minuten transportiert.
  const minutes = item.quantityRaw != null
    ? Math.round(item.quantityRaw * 60)
    : item.durationMinutes;
  return formatHoursQuantityDisplay(minutes);
}
