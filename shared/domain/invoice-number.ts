/**
 * SSoT für die Rechnungsnummer-Zeichenkette `RE-<jahr>-<laufnummer>`.
 *
 * Genau EINE Funktion erzeugt das Format — Anzeige-, Vergabe- und
 * Report-Pfade importieren dieselbe (keine parallele Inline-Bildung).
 *
 * Vorwärts-Änderung (GoBD-konform): Ab `INVOICE_NUMBER_WIDE_PAD_FROM_YEAR`
 * wird die laufende Nummer auf 5 Stellen genullt, davor auf 4. Bereits
 * vergebene Nummern (Jahr ≤ 2026) bleiben damit unverändert; es wird nichts
 * neu nummeriert.
 */

/** Ab diesem Rechnungs-Jahr wird die laufende Nummer 5-stellig genullt. */
export const INVOICE_NUMBER_WIDE_PAD_FROM_YEAR = 2027;

const NARROW_PAD_WIDTH = 4;
const WIDE_PAD_WIDTH = 5;

/**
 * Mindest-Breite der laufenden Nummer für ein Rechnungs-Jahr.
 * Padding ist eine MINDEST-Breite, NIE eine Obergrenze — überläuft ein Jahr
 * die Breite (z. B. > 99999 ab 2027), wächst die Nummer einfach weiter.
 */
export function invoiceNumberPadWidth(year: number): number {
  return year >= INVOICE_NUMBER_WIDE_PAD_FROM_YEAR ? WIDE_PAD_WIDTH : NARROW_PAD_WIDTH;
}

/** Baut die Rechnungsnummer `RE-<jahr>-<laufnummer>` (SSoT). */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `RE-${year}-${String(sequence).padStart(invoiceNumberPadWidth(year), "0")}`;
}
