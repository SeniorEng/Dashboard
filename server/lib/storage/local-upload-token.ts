import { createHmac, timingSafeEqual } from "crypto";

/**
 * Task #1840 — Kurzlebiger HMAC-signierter Token für lokale Upload-URLs.
 *
 * Der `local`-Storage-Treiber kann keine (GCS-)Presigned-URLs ausstellen. Als
 * Ersatz gibt `createUploadUrl` eine relative App-URL
 * `/api/uploads/local/<objectId>?token=<token>` aus, auf die der Browser das
 * Objekt direkt per PUT lädt. Dieser Token signiert `{objectId, exp}` mit einem
 * Server-Secret und bildet damit dasselbe Capability-Modell wie eine
 * Presigned-URL ab: nur wer den (unfälschbaren, kurzlebigen) Token besitzt, darf
 * genau dieses eine Upload-Objekt schreiben. Ausgestellt wird der Token nur über
 * den auth+CSRF-geschützten `/api/uploads/request-url`-Endpoint.
 *
 * Domain-separiert vom Twilio-Callback-Token über ein eigenes HMAC-Label.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — großzügig für einen Datei-Upload
const HMAC_LABEL = "local-upload-v1";

interface UploadPayload {
  objectId: string;
  exp: number; // ms since epoch
}

export interface VerifyUploadResult {
  ok: boolean;
  objectId?: string;
  reason?: "missing" | "malformed" | "bad_signature" | "expired";
}

function getSecret(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY (64-hex) wird für lokale Upload-Token benötigt.");
  }
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(HMAC_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signLocalUploadToken(
  payload: { objectId: string },
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): string {
  const full: UploadPayload = { objectId: payload.objectId, exp: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = b64url(createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyLocalUploadToken(
  token: string | undefined | null,
  now: number = Date.now(),
): VerifyUploadResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: Buffer;
  try {
    expected = createHmac("sha256", getSecret()).update(body).digest();
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  let actual: Buffer;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: UploadPayload;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed?.objectId !== "string" || typeof parsed?.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, objectId: parsed.objectId };
}
