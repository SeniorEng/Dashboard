import { createHmac, timingSafeEqual } from "crypto";

/**
 * Kurzlebiger HMAC-signierter Token für Twilio-Callback-URLs (Task #450).
 *
 * Statt `prospectId=<id>` im Klartext in der Callback-URL zu führen, signiert
 * dieser Helper einen Payload `{prospectId, exp}` mit einem Server-Secret.
 * Eine geleakte URL ist damit nur bis `exp` gültig und kann nicht
 * willkürlich auf andere Prospects umgebogen werden.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h reicht für Twilio-Status-Callbacks
const HMAC_LABEL = "twilio-callback-v1";

interface CallbackPayload {
  prospectId: number;
  exp: number; // ms since epoch
}

export interface VerifyResult {
  ok: boolean;
  prospectId?: number;
  reason?: "missing" | "malformed" | "bad_signature" | "expired";
}

function getSecret(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY (64-hex) wird für Twilio-Callback-Token benötigt.");
  }
  // Domain-separate from raw encryption use by mixing in a label.
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(HMAC_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signCallbackToken(
  payload: { prospectId: number },
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): string {
  const full: CallbackPayload = { prospectId: payload.prospectId, exp: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = b64url(createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyCallbackToken(
  token: string | undefined | null,
  now: number = Date.now(),
): VerifyResult {
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

  let parsed: CallbackPayload;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed?.prospectId !== "number" || typeof parsed?.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, prospectId: parsed.prospectId };
}
