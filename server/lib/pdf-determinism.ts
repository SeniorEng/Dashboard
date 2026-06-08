import crypto from "crypto";

/**
 * Task #1047 — PDF-Byte-Reproduzierbarkeit.
 *
 * Eingebettete PDFs sind von Haus aus NICHT byte-stabil: drei Render-Pfade
 * schreiben jeweils Wall-Clock-Zeitstempel bzw. zufalls-/zählerabhängige IDs:
 *
 *   1. Chromium (`page.pdf`) schreibt `/CreationDate`/`/ModDate` (Info-Dict)
 *      als Wall-Clock. (Die früheren Tagged-PDF-`/ID (nodeNNNNNNNN)`-Zähler
 *      werden separat über `page.pdf({ tagged:false })` eliminiert.)
 *   2. node-zugferd (ZUGFeRD/PDF-A-3-Embed) schreibt im XMP-Metadaten-Stream
 *      `xmp:CreateDate`/`xmp:ModifyDate`/`xmp:MetadataDate` sowie den History-
 *      `rdf:li`-Eintrag als Wall-Clock-ISO und setzt die XRef-Stream-`/ID`
 *      auf `SHA256(subject + new Date())` — beides NICHT über die Embed-
 *      Optionen überschreibbar.
 *
 * Damit ein Re-Render aus dem versiegelten `render_snapshot` den ursprünglich
 * versiegelten `pdf_hash` byte-genau reproduziert (Clobbered-PDF-Restore,
 * Task #1043), normalisieren wir die finalen PDF-Bytes deterministisch:
 *   - Alle obigen Zeitstempel werden auf einen EINMALIG eingefrorenen, im
 *     Snapshot persistierten Erzeugungszeitpunkt gesetzt.
 *   - Die XRef-Stream-`/ID` wird deterministisch aus einem stabilen Seed
 *     (Rechnungsnummer) abgeleitet.
 *
 * GoBD: Diese Funktion verändert ausschließlich Metadaten-Zeitstempel und die
 * Datei-`/ID` — NIEMALS Inhalt, Beträge, Steuersätze oder das eingebettete
 * ZUGFeRD-XML. Alle Ersetzungen sind LÄNGENERHALTEND (gleich lange Tokens),
 * damit weder die `/Length`-Angabe des XMP-Streams noch die Byte-Offsets der
 * XRef-Tabelle/des XRef-Streams verschoben werden.
 */

export interface PdfDeterminismOptions {
  /** Eingefrorener Erzeugungszeitpunkt (ISO-String oder Date). */
  creationDate: string | Date;
  /** Stabiler Seed für die deterministische Datei-`/ID` (z.B. Rechnungsnummer). */
  idSeed: string;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/**
 * Ersetzt in den finalen PDF-Bytes alle nicht-deterministischen Zeitstempel
 * und die Datei-`/ID` durch längengleiche, aus `opts` abgeleitete Werte.
 *
 * latin1 (ISO-8859-1) bildet jedes Byte 0–255 verlustfrei 1:1 auf einen
 * Codepoint ab und zurück — der String-Round-Trip ist also byte-exakt, auch
 * über komprimierte Binär-Streams hinweg.
 */
export function normalizePdfDeterminism(
  buffer: Buffer,
  opts: PdfDeterminismOptions,
): Buffer {
  const date =
    typeof opts.creationDate === "string"
      ? new Date(opts.creationDate)
      : opts.creationDate;
  if (Number.isNaN(date.getTime())) {
    // Defensiv: ungültiges Datum → Bytes unverändert lassen (kein Crash im
    // Persist-/Restore-Pfad).
    return buffer;
  }

  const Y = date.getUTCFullYear();
  const Mo = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const H = pad(date.getUTCHours());
  const Mi = pad(date.getUTCMinutes());
  const S = pad(date.getUTCSeconds());

  // Chromium-Info-Dict-Format: D:YYYYMMDDHHMMSS (14 Ziffern), Suffix bleibt.
  const pdfDigits = `${Y}${Mo}${D}${H}${Mi}${S}`;
  // XMP-ISO mit Millisekunden (immer 24 Zeichen, wie von node-zugferd emittiert).
  const isoMs = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}.000Z`;

  let s = buffer.toString("latin1");

  // (1) Info-Dict-Zeitstempel: nur die 14 Ziffern nach `(D:` ersetzen
  //     (Präfix `(D:` und Zeitzonen-Suffix bleiben → längenerhaltend).
  s = s.replace(
    /(\/(?:CreationDate|ModDate)\s*\(D:)(\d{14})/g,
    (_m, prefix: string) => `${prefix}${pdfDigits}`,
  );

  // (2) XMP-Zeitstempel: exakt 24-Zeichen-Millis-ISO → exakt 24-Zeichen isoMs
  //     (längenerhaltend, daher /Length des XMP-Streams unverändert).
  s = s.replace(
    /(<(?:xmp:CreateDate|xmp:ModifyDate|xmp:MetadataDate|rdf:li)>)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(<\/)/g,
    (_m, open: string, close: string) => `${open}${isoMs}${close}`,
  );

  // (3) Datei-/ID: `/ID [ <hexA> <hexB> ]` → deterministische Hex gleicher
  //     Länge (XRef-Stream-Offset-erhaltend).
  s = s.replace(
    /(\/ID\s*\[\s*<)([0-9a-fA-F]+)(>\s*<)([0-9a-fA-F]+)(>)/g,
    (_m, a: string, h1: string, b: string, h2: string, c: string) => {
      const det = (slot: string, len: number) =>
        crypto
          .createHash("sha256")
          .update(`${opts.idSeed}:${slot}`)
          .digest("hex")
          .repeat(Math.ceil(len / 64))
          .slice(0, len);
      return `${a}${det("0", h1.length)}${b}${det("1", h2.length)}${c}`;
    },
  );

  return Buffer.from(s, "latin1");
}
