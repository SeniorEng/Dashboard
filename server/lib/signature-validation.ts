import zlib from "node:zlib";

const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+=*)$/;

export const MIN_SIGNATURE_WIDTH_PX = 40;
export const MIN_SIGNATURE_HEIGHT_PX = 20;
export const MIN_SIGNATURE_INK_BYTES = 50;
export const MIN_SIGNATURE_DECODED_BYTES = 250;
export const MAX_SIGNATURE_BYTES = 5 * 1024 * 1024;

export type SignatureValidationResult =
  | { ok: true; mime: "png" | "jpeg" | "webp"; widthPx?: number; heightPx?: number; decodedBytes: number; inkBytes?: number }
  | { ok: false; reason: string; code: SignatureValidationErrorCode };

export type SignatureValidationErrorCode =
  | "invalid_data_url"
  | "too_large"
  | "decode_failed"
  | "not_png_magic"
  | "too_small_dimensions"
  | "empty_canvas"
  | "too_small_payload";

function parsePngChunks(buf: Buffer): { width: number; height: number; idatBytes: Buffer } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
      buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a) {
    return null;
  }
  let off = 8;
  let width = 0;
  let height = 0;
  const idatChunks: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    if (type === "IHDR" && len >= 8) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
    } else if (type === "IDAT") {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4;
  }
  if (!width || !height) return null;
  return { width, height, idatBytes: Buffer.concat(idatChunks) };
}

function countNonZeroBytes(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) count++;
  return count;
}

/**
 * Task #749 — Validates a base64 data URL signature image to detect
 * "signed but visually empty" canvases (mini-canvas race, accidental tap
 * without a stroke, fully transparent buffer). The goal is to prevent a
 * monthly_service_records row from being promoted to status=completed
 * with a customerSignatureData that renders as a blank <img> in the
 * Leistungsnachweis PDF — that PDF would be legally invalid for
 * §45b-Abtretungserklärung.
 *
 * For PNG (the format react-signature-canvas produces): decodes IHDR for
 * dimensions, inflates IDAT chunks, and counts non-zero bytes as a proxy
 * for "ink on canvas". A truly empty transparent PNG inflates to mostly
 * zero bytes; a real signature scribble has hundreds of non-zero bytes.
 *
 * For JPEG/WebP: falls back to a payload-size check — JPEG has no
 * transparent canvas concept, so an "empty" white canvas isn't a real
 * failure mode there.
 */
export function analyzeSignatureImage(dataUrl: string): SignatureValidationResult {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { ok: false, reason: "Keine Unterschriftsdaten übertragen.", code: "invalid_data_url" };
  }
  if (dataUrl.length > MAX_SIGNATURE_BYTES) {
    return { ok: false, reason: "Unterschriftsbild ist zu groß (max. 5 MB).", code: "too_large" };
  }
  const trimmed = dataUrl.replace(/\s+/g, "");
  const m = SIGNATURE_DATA_URL_RE.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      reason: "Unterschriftsdaten müssen ein base64-kodiertes PNG-, JPEG- oder WebP-Bild sein.",
      code: "invalid_data_url",
    };
  }
  const mimeRaw = m[1].toLowerCase();
  const mime: "png" | "jpeg" | "webp" = mimeRaw === "jpg" ? "jpeg" : (mimeRaw as "png" | "jpeg" | "webp");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(m[2], "base64");
  } catch {
    return { ok: false, reason: "Unterschriftsbild konnte nicht dekodiert werden.", code: "decode_failed" };
  }
  if (decoded.length < MIN_SIGNATURE_DECODED_BYTES) {
    return {
      ok: false,
      reason: "Die Unterschrift wirkt leer. Bitte erneut unterschreiben.",
      code: "too_small_payload",
    };
  }

  if (mime === "png") {
    if (!(decoded.length >= 8 &&
      decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47)) {
      return { ok: false, reason: "Ungültige PNG-Daten in der Unterschrift.", code: "not_png_magic" };
    }
    const parsed = parsePngChunks(decoded);
    if (!parsed) {
      return { ok: false, reason: "Unterschriftsbild konnte nicht gelesen werden.", code: "decode_failed" };
    }
    if (parsed.width < MIN_SIGNATURE_WIDTH_PX || parsed.height < MIN_SIGNATURE_HEIGHT_PX) {
      return {
        ok: false,
        reason: `Die Unterschriftsfläche ist zu klein (${parsed.width}×${parsed.height} px). Bitte erneut unterschreiben.`,
        code: "too_small_dimensions",
      };
    }
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(parsed.idatBytes);
    } catch {
      // Task #749 — Korrupte/nicht entpackbare IDAT-Daten dürfen NIEMALS
      // als gültige Unterschrift durchgelassen werden. Akzeptanz hier hätte
      // bedeutet, dass ein nicht-renderbares PNG den LN auf `signed` setzt
      // und im PDF wieder als „signed text + empty img"-Drift landet
      // (RE-2026-0010-Klasse). Lieber harter Reject mit klarer Meldung.
      return {
        ok: false,
        reason: "Unterschriftsbild konnte nicht gelesen werden. Bitte erneut unterschreiben.",
        code: "decode_failed",
      };
    }
    const ink = countNonZeroBytes(inflated);
    if (ink < MIN_SIGNATURE_INK_BYTES) {
      return {
        ok: false,
        reason: "Die Unterschrift wirkt leer. Bitte erneut unterschreiben.",
        code: "empty_canvas",
      };
    }
    return {
      ok: true,
      mime,
      widthPx: parsed.width,
      heightPx: parsed.height,
      decodedBytes: decoded.length,
      inkBytes: ink,
    };
  }

  if (mime === "jpeg") {
    if (!(decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff)) {
      return { ok: false, reason: "Ungültige JPEG-Daten in der Unterschrift.", code: "decode_failed" };
    }
  }

  return { ok: true, mime, decodedBytes: decoded.length };
}

/**
 * Lightweight predicate used by the PDF renderer to decide whether a
 * "signed" record actually has a visible signature image. Returns true
 * for any signature that passes `analyzeSignatureImage` — used as a
 * guard against rendering "signed-text + empty <img>" combinations.
 */
export function isSignatureImageMeaningful(dataUrl: string | null | undefined): boolean {
  if (!dataUrl) return false;
  return analyzeSignatureImage(dataUrl).ok;
}
