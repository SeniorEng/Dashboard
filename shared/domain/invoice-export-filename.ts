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
 * Task #1696 — „Sprechende" Datei-Namen für Einzel-Downloads (Rechnung,
 * Leistungsnachweis, Bündel) im Rechnungs-Zeilen-Menü.
 *
 * Anders als `sanitizeExportSegment` (ZIP-Eintrag, ASCII-only) sollen diese
 * Namen für den Menschen lesbar bleiben: deutsche Umlaute (Müller, Schäfer)
 * werden BEWAHRT, es wird lediglich filesystem-Unsicheres entfernt. Format:
 * `Rechnungsnummer - Nachname, Vorname - Dokumentart.pdf`.
 */

export type SpeakingInvoiceDocumentKind = "invoice" | "leistungsnachweis" | "bundle";

const SPEAKING_KIND_LABEL: Record<SpeakingInvoiceDocumentKind, string> = {
  invoice: "Rechnung",
  leistungsnachweis: "Leistungsnachweis",
  bundle: "Rechnung+Leistungsnachweis",
};

/**
 * Entfernt filesystem-unsichere Zeichen (`\\ / : * ? " < > |` sowie
 * Steuerzeichen), erhält aber Buchstaben inkl. Umlaute, Ziffern, Leerzeichen,
 * Komma, Bindestrich, Plus und Punkt. Whitespace wird kollabiert/getrimmt.
 * Leeres Ergebnis → `fallback`.
 */
export function sanitizeSpeakingSegment(input: string | null | undefined, fallback: string): string {
  const cleaned = (input ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

/**
 * Baut das Namens-Segment `Nachname, Vorname`. Fällt auf einen einzelnen
 * vorhandenen Namensteil, dann auf den kombinierten Kundennamen und zuletzt auf
 * `Kunde` zurück, damit nie ein kaputter Dateiname entsteht.
 */
function buildSpeakingNameSegment(
  vorname: string | null | undefined,
  nachname: string | null | undefined,
  customerName: string | null | undefined,
): string {
  const v = (vorname ?? "").trim();
  const n = (nachname ?? "").trim();
  if (n && v) return `${n}, ${v}`;
  if (n) return n;
  if (v) return v;
  const combined = (customerName ?? "").trim();
  if (combined) return combined;
  return "Kunde";
}

export interface SpeakingInvoiceFilenameInput {
  invoiceNumber: string;
  vorname?: string | null;
  nachname?: string | null;
  /** Kombinierter Kundenname als Fallback, wenn Vor-/Nachname fehlen. */
  customerName?: string | null;
  kind: SpeakingInvoiceDocumentKind;
}

/**
 * Baut den sprechenden Datei-Namen (inkl. `.pdf`) im Muster
 * `Rechnungsnummer - Nachname, Vorname - Dokumentart.pdf`. Jedes Segment wird
 * einzeln sanitisiert, sodass die ` - `-Trenner erhalten bleiben.
 */
export function buildSpeakingInvoiceFilename(input: SpeakingInvoiceFilenameInput): string {
  const number = sanitizeSpeakingSegment(input.invoiceNumber, "Rechnung");
  const name = sanitizeSpeakingSegment(
    buildSpeakingNameSegment(input.vorname, input.nachname, input.customerName),
    "Kunde",
  );
  const label = SPEAKING_KIND_LABEL[input.kind];
  return `${number} - ${name} - ${label}.pdf`;
}

/**
 * Task #1698 — „Sprechender" Datei-Name für den Krankenkassen-Bündel-Download
 * (ein Monat + eine Pflegekasse, als zusammengeführtes PDF oder ZIP). Analog zu
 * `buildSpeakingInvoiceFilename` bleiben Umlaute BEWAHRT, nur filesystem-
 * Unsicheres wird entfernt. Format: `<Pflegekasse> - <YYYY-MM> - Sammelbündel.<ext>`.
 * Abgegrenzt vom monatsweiten Sammeldruck (bleibt unverändert).
 */
export interface SpeakingKassenBundleFilenameInput {
  providerName?: string | null;
  year: number;
  month: number;
  extension: "pdf" | "zip";
}

export function buildSpeakingKassenBundleFilename(input: SpeakingKassenBundleFilenameInput): string {
  const provider = sanitizeSpeakingSegment(input.providerName, "Pflegekasse");
  const period = `${input.year}-${String(input.month).padStart(2, "0")}`;
  return `${provider} - ${period} - Sammelbündel.${input.extension}`;
}

/**
 * Baut einen header-sicheren `Content-Disposition`-Wert mit ASCII-Fallback und
 * RFC-5987-`filename*` (UTF-8-percent-encoded), sodass Umlaute im „Speichern
 * unter"-Dialog erhalten bleiben. `disposition` ist standardmäßig `inline`.
 */
export function buildContentDisposition(
  filename: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  // ASCII-Fallback: Nicht-ASCII → `_`, Anführungszeichen/Backslash entschärfen.
  // eslint-disable-next-line no-control-regex
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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
