/**
 * Zentraler Helper für Test-Unterschriften (Task #763).
 *
 * Hintergrund: Nach Task #749 prüft `server/lib/signature-validation.ts` nicht
 * mehr nur das Data-URL-Format, sondern dekodiert das PNG, prüft Mindestgröße
 * (≥ 40×20 px), Mindest-Bytecount und ob überhaupt sichtbare Pixel (Alpha > 0)
 * vorhanden sind. Alle Test-Hardcodes wie "iVBORw0KGgo=" (1×1 leeres PNG) sind
 * dadurch hart obsolet.
 *
 * Diese Datei ist die EINZIGE Quelle für Test-Signaturen. Sowohl Vitest-Tests
 * unter `tests/` als auch Playwright-E2E-Tests unter `e2e/` müssen diesen
 * Helper benutzen, damit Verschärfungen der Validator-Regeln nur an einer
 * Stelle nachgezogen werden müssen.
 *
 * KEINE eigenen PNG-Konstanten in Tests — siehe `tests/README.md`.
 */
// @ts-nocheck


import zlib from "node:zlib";

/**
 * Baut ein deterministisches PNG mit gegebener Größe. Wenn `fillAlpha=true`
 * wird Alpha=255 für jedes Pixel gesetzt (also "Tinte auf Leinwand"), sonst
 * bleibt der Canvas vollständig transparent. CRC-Felder werden mit Nullen
 * gefüllt — der Validator prüft nur Chunk-Längen und entpackt IDAT, validiert
 * aber keine CRCs.
 */
export function buildPng(
  width: number,
  height: number,
  fillAlpha: boolean,
): string {
  const bpp = 4;
  const rowSize = 1 + width * bpp;
  const raw = Buffer.alloc(rowSize * height);
  if (fillAlpha) {
    for (let y = 0; y < height; y++) {
      const off = y * rowSize;
      raw[off] = 0;
      for (let x = 0; x < width; x++) {
        const p = off + 1 + x * bpp;
        raw[p + 3] = 255;
      }
    }
  }
  const idat = zlib.deflateSync(raw);
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

let cachedSignature: string | null = null;

/**
 * Liefert eine gültige Test-Unterschrift, die den Server-Validator passiert
 * (>= 40×20 px, RGBA mit Alpha=255, decoded >= 250 Bytes). Wird gecached,
 * damit wiederholte Aufrufe in einem Testlauf nicht jedes Mal deflaten.
 */
export function validSignatureDataUrl(): string {
  if (cachedSignature) return cachedSignature;
  cachedSignature = buildPng(600, 200, true);
  return cachedSignature;
}
