/**
 * Signature transport normalization.
 *
 * The published app sits behind the Replit/Google edge WAF. That edge inspects
 * request bodies and returns a hard HTML `403` (before the request ever reaches
 * Express) whenever the body contains a `data:image/...;base64,` data-URI — it
 * treats the `data:` scheme as a potential injected payload. Digital signatures
 * are the only place in CareConnect that send an image inside a JSON body, so
 * every "Unterschrift bestätigen" request was being blocked at the edge.
 *
 * Fix: on the client we strip the `data:image/...;base64,` prefix from signature
 * fields right before the request leaves the browser (so the body only contains
 * raw base64, which the WAF passes), and on the server we restore the full data
 * URL at ingestion — before any validation, hashing, storage or PDF rendering.
 * The persisted format, integrity hash and PDF output are therefore unchanged.
 *
 * Both directions key off the same explicit field-name allow-list, so unrelated
 * payloads are never touched.
 */

export const SIGNATURE_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const SIGNATURE_DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i;

/**
 * JSON field names that carry a signature image as a base64 data URL. Kept as an
 * explicit allow-list (not a fuzzy key match) so e.g. `signatureHash` or other
 * fields are never rewritten.
 */
const SIGNATURE_FIELD_KEYS: ReadonlySet<string> = new Set([
  "signatureData",
  "customerSignatureData",
  "employeeSignatureData",
]);

export function isSignatureFieldKey(key: string): boolean {
  return SIGNATURE_FIELD_KEYS.has(key);
}

/** Client → server: remove the `data:image/...;base64,` prefix, yielding raw base64. */
export function stripSignatureDataUrlPrefix(value: string): string {
  return typeof value === "string" ? value.replace(SIGNATURE_DATA_URL_RE, "") : value;
}

/**
 * Server ingestion: rebuild a full PNG data URL from raw base64. Values that are
 * already a data URL (legacy clients / internal callers) and empty/missing
 * values pass through untouched so existing validation still reports them.
 */
export function normalizeSignatureToDataUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  if (SIGNATURE_DATA_URL_RE.test(value)) return value;
  return SIGNATURE_PNG_DATA_URL_PREFIX + value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type TransformMode = "strip" | "restore";

/**
 * Recursively walk a JSON-serializable structure and transform every signature
 * field. Only plain objects and arrays are traversed; Dates, class instances and
 * other non-plain values are returned untouched to avoid corrupting bodies.
 */
export function transformSignatureFields<T>(input: T, mode: TransformMode): T {
  const fn = mode === "strip" ? stripSignatureDataUrlPrefix : normalizeSignatureToDataUrl;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = typeof val === "string" && isSignatureFieldKey(key) ? fn(val) : walk(val);
      }
      return out;
    }
    return value;
  };

  return walk(input) as T;
}
