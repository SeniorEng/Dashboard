/**
 * Task #1376: SSoT für die erlaubten Rechnungs-Status-Übergänge.
 *
 * Diese Map ERSETZT die zuvor lokal im Handler `PATCH /billing/:id/status`
 * definierte `allowedTransitions`-Konstante. Sowohl der Einzel-Statuswechsel
 * als auch der neue Sammel-Statuswechsel (`POST /billing/bulk-status`) lesen
 * dieselbe Quelle, damit beide Pfade niemals auseinanderdriften.
 *
 * Lebenszyklus (Task #1284):
 *   Entwurf → Versendet → Avis erhalten → Bezahlt (+ Storniert).
 * "avis_erhalten" liegt zwischen Versendet und Bezahlt. Manuell darf von
 * versendet/avis_erhalten direkt auf bezahlt gesprungen werden;
 * bezahlt/storniert werden nie herabgestuft.
 *
 * Task #1434: "versendet" darf zusätzlich auf "entwurf" ZURÜCKGESETZT werden
 * (Korrektur eines versehentlich/zu früh markierten Versands). Beim Rücksetzen
 * wird `sentAt` wieder geleert (siehe `updateInvoiceStatusTx`). Bewusst NUR von
 * "versendet" aus — aus "avis_erhalten"/"bezahlt"/"storniert" gibt es kein
 * Zurück (diese Status implizieren bereits eingetretene Folgewirkungen).
 */
export const INVOICE_STATUS_TRANSITIONS: Record<string, string[]> = {
  entwurf: ["versendet", "storniert"],
  versendet: ["entwurf", "avis_erhalten", "bezahlt", "storniert"],
  avis_erhalten: ["bezahlt", "storniert"],
  bezahlt: ["storniert"],
  storniert: [],
};

/** Ist der Übergang `from → to` laut SSoT erlaubt? */
export function isAllowedInvoiceStatusTransition(from: string, to: string): boolean {
  return INVOICE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
