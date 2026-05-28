// Test-Helper: erzeugt ein gültiges, "mit Tinte" gefülltes PNG-Signaturbild,
// das server/lib/signature-validation.ts (Task #749) passiert.
//
// Hintergrund: Die harte Leer-/Korrupt-Unterschriftsprüfung verlangt
// MIN_SIGNATURE_DECODED_BYTES (≥250), Mindest-Dimensionen (40×20 px) und
// genug Non-Zero-Bytes nach dem IDAT-Inflate (≥50). Ein Mini-Stub wie
// "data:image/png;base64,iVBORw0KGgo=" (nur PNG-Magic, 8 Bytes) wird
// deterministisch mit `too_small_payload` abgelehnt — Test-Setups müssen
// daher ein echtes PNG signieren.

import zlib from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // analyzeSignatureImage prüft keine CRC32 → 0 ist ausreichend.
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(0, 0);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
}

/**
 * Baut ein opakes RGBA-PNG (Default 64×40 px) mit gesetzten Alpha-/Farbbytes,
 * sodass sowohl die Größen- als auch die "Tinte vorhanden"-Prüfung greift.
 */
export function makeValidSignatureDataUrl(width = 64, height = 40): string {
  const rowSize = 1 + width * 4; // 1 Filter-Byte + RGBA pro Pixel
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      // Variierende Werte, damit die deflate-Größe sicher über
      // MIN_SIGNATURE_DECODED_BYTES (250) liegt und nicht weg-komprimiert.
      raw[px] = (x * 7 + y * 13) & 0xff; // R
      raw[px + 1] = (x * 31 + y * 17) & 0xff; // G
      raw[px + 2] = (x * 53 + y * 29) & 0xff; // B
      raw[px + 3] = 0xff; // A (opak → garantiert Non-Zero-Tinte)
    }
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Vorgefertigtes gültiges Signaturbild für Test-Fixtures. */
export const VALID_SIGNATURE_DATA_URL = makeValidSignatureDataUrl();
