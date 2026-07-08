/**
 * Task #1695 — Einzel-PDF-Export (ehem. „Lexware-Export").
 *
 * Pure Datei-Namens-Helfer für den „Einzeln (ZIP)"-Rechnungsdruck auf
 * /admin/billing. Jede Rechnung wird als eigene PDF (optional inkl.
 * Leistungsnachweis) in ein ZIP gepackt; der Eintrags-Name folgt dem Muster
 * `Rechnungsnummer_Kunde_Datum.pdf` (filesystem-sicher sanitisiert).
 *
 * Reine String-Logik (kein DB-/IO-Zugriff), bewusst NICHT als
 * `calculate*`/`compute*` benannt (würde den Arch-Test
 * `tests/architecture/calculations-in-shared.test.ts` triggern, der solche
 * Namen außerhalb dieses Verzeichnisses verbietet — hier ist es erlaubt, der
 * neutrale `build*`-Name hält die Absicht aber klar von Geld-/Budget-Mathe
 * getrennt).
 */

/**
 * Sanitisiert ein einzelnes Namens-Segment auf filesystem- und ZIP-sichere
 * Zeichen: alles außer `A-Z a-z 0-9 _ -` wird zu `_` zusammengefasst, führende/
 * abschließende `_` entfernt. Leeres Ergebnis → `fallback`.
 */
export function sanitizeExportSegment(input: string | null | undefined, fallback: string): string {
  const cleaned = (input ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export interface InvoiceExportFilenameInput {
  invoiceNumber: string;
  customerName?: string | null;
  /** Anzeigedatum für den Dateinamen (ISO yyyy-mm-dd bevorzugt). */
  date: string;
}

/**
 * Baut den Basis-Dateinamen (inkl. `.pdf`-Endung) aus Rechnungsnummer,
 * Kundenname und Datum: `Rechnungsnummer_Kunde_Datum.pdf`. Jedes Segment wird
 * einzeln sanitisiert, sodass das Trenn-`_` zwischen den Feldern erhalten
 * bleibt.
 */
export function buildInvoiceExportFilename(input: InvoiceExportFilenameInput): string {
  const number = sanitizeExportSegment(input.invoiceNumber, "Rechnung");
  const customer = sanitizeExportSegment(input.customerName, "Kunde");
  const date = sanitizeExportSegment(input.date, "Datum");
  return `${number}_${customer}_${date}.pdf`;
}

/**
 * De-dupliziert eine Liste von Dateinamen innerhalb desselben ZIP-Archivs:
 * Kollisionen erhalten ein `-2`, `-3`, … vor der Endung. Reihenfolge bleibt
 * erhalten; Vergleich case-insensitiv (Windows-ZIP-Sicherheit).
 */
export function dedupeExportFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    // Auch den neuen, suffixierten Namen registrieren, damit ein bereits
    // existierender `…-2` nicht erneut kollidiert.
    let suffix = count + 1;
    let candidate = `${stem}-${suffix}${ext}`;
    while (seen.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${stem}-${suffix}${ext}`;
    }
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}
