/**
 * Task #1687 — Reine Referenz-/Matching-Helfer für den Zahlungsavis-Import.
 *
 * Diese Funktionen sind bewusst DB-frei und leben in `shared/domain`, damit
 * Parser (`server/services/avis-parser.ts`) UND Matching-Route
 * (`server/routes/admin/qonto.ts`) EXAKT dieselbe Referenz-Normalisierung/
 * -Extraktion nutzen (eine SSoT statt zweier paralleler Regex-Blöcke).
 */

/**
 * Excel/OCR liefert bei langen Ziffern-Referenzen häufig den Buchstaben `O`
 * statt der Ziffer `0` (z.B. `RE-2026-O191`). Für den Abgleich normalisieren wir
 * `O`/`o` → `0`. Bewusst eng gehalten: nur innerhalb bereits erkannter
 * Rechnungsnummer-Token angewandt, damit Namen o.Ä. unberührt bleiben.
 */
export function normalizeAvisRef(raw: string): string {
  return raw.replace(/[Oo]/g, "0");
}

/**
 * Excel schreibt lange Ziffern-Referenzen gerne als Fließkomma in
 * wissenschaftlicher Notation (`4,00000061835E+15`). Solche Werte sind als
 * Rechnungsnummer wertlos und dürfen NICHT automatisch zugeordnet werden —
 * stattdessen wird der Import als „nicht zugeordnet" mit Warnhinweis geführt.
 */
export function isExcelExponential(text: string): boolean {
  return /\d[.,]?\d*e\+?\d+/i.test(text.trim());
}

const RE_INVOICE_PATTERN = /RE-\d{4}-[0-9Oo]+/;
const NUMERIC_INVOICE_PATTERN = /\b(\d{6,})\b/;

/**
 * Extrahiert eine Rechnungsnummer aus einem freien Textfeld. Erst das kanonische
 * `RE-JJJJ-NNNN`-Muster (O→0-tolerant, normalisiert), dann als Fallback eine lange
 * (≥6-stellige) Ziffernfolge. Excel-Exponential-Müll wird verworfen.
 */
export function extractInvoiceNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  if (isExcelExponential(text)) return null;

  const reMatch = text.match(RE_INVOICE_PATTERN);
  if (reMatch) return normalizeAvisRef(reMatch[0]);

  const numMatch = text.match(NUMERIC_INVOICE_PATTERN);
  if (numMatch) return numMatch[1];

  return null;
}

/**
 * Genau-ein-Kandidat-Regel (analog `resolveUniqueBulkMatch` in
 * `bulk-advice-match.ts`): eine automatische Zuordnung erfolgt NUR, wenn genau ein
 * Kandidat übrig bleibt. Bei 0 oder ≥2 Kandidaten → `null` (⇒ „nicht zugeordnet",
 * manuelle Prüfung), niemals ein willkürlicher erster Treffer.
 */
export function resolveUniqueMatch<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0] : null;
}
