/**
 * Edge-WAF signature transport (client strip ↔ server restore).
 *
 * The published edge WAF hard-blocks any request body that contains a
 * `data:image/...;base64,` URI. The client strips that prefix before sending and
 * the server rebuilds the full data URL at ingestion. These tests pin that the
 * round-trip is lossless and that only signature fields are touched.
 */
import { describe, it, expect } from "vitest";
import {
  SIGNATURE_PNG_DATA_URL_PREFIX,
  stripSignatureDataUrlPrefix,
  normalizeSignatureToDataUrl,
  transformSignatureFields,
  isSignatureFieldKey,
} from "@shared/utils/signature-transport";

const RAW_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAUA"; // arbitrary base64 stub
const DATA_URL = SIGNATURE_PNG_DATA_URL_PREFIX + RAW_B64;

describe("stripSignatureDataUrlPrefix", () => {
  it("removes a png data URL prefix", () => {
    expect(stripSignatureDataUrlPrefix(DATA_URL)).toBe(RAW_B64);
  });

  it("removes jpeg/webp prefixes too", () => {
    expect(stripSignatureDataUrlPrefix("data:image/jpeg;base64," + RAW_B64)).toBe(RAW_B64);
    expect(stripSignatureDataUrlPrefix("data:image/webp;base64," + RAW_B64)).toBe(RAW_B64);
  });

  it("leaves raw base64 untouched", () => {
    expect(stripSignatureDataUrlPrefix(RAW_B64)).toBe(RAW_B64);
  });

  it("produces a body free of the WAF-triggering `data:` token", () => {
    expect(stripSignatureDataUrlPrefix(DATA_URL)).not.toContain("data:");
  });
});

describe("normalizeSignatureToDataUrl", () => {
  it("prepends the png prefix to raw base64", () => {
    expect(normalizeSignatureToDataUrl(RAW_B64)).toBe(DATA_URL);
  });

  it("leaves an existing data URL unchanged (backward compatible)", () => {
    expect(normalizeSignatureToDataUrl(DATA_URL)).toBe(DATA_URL);
    expect(normalizeSignatureToDataUrl("data:image/jpeg;base64," + RAW_B64)).toBe(
      "data:image/jpeg;base64," + RAW_B64,
    );
  });

  it("passes empty values through so downstream validation can reject them", () => {
    expect(normalizeSignatureToDataUrl("")).toBe("");
  });
});

describe("round trip strip → restore is lossless", () => {
  it("client strip then server restore yields the original data URL", () => {
    expect(normalizeSignatureToDataUrl(stripSignatureDataUrlPrefix(DATA_URL))).toBe(DATA_URL);
  });
});

describe("isSignatureFieldKey", () => {
  it("matches only the signature image fields", () => {
    expect(isSignatureFieldKey("signatureData")).toBe(true);
    expect(isSignatureFieldKey("customerSignatureData")).toBe(true);
    expect(isSignatureFieldKey("employeeSignatureData")).toBe(true);
    expect(isSignatureFieldKey("signatureHash")).toBe(false);
    expect(isSignatureFieldKey("signingLocation")).toBe(false);
  });
});

describe("transformSignatureFields", () => {
  it("strips top-level signature fields and leaves others intact", () => {
    const out = transformSignatureFields(
      { signatureData: DATA_URL, signerType: "employee", signingLocation: "Berlin" },
      "strip",
    );
    expect(out).toEqual({ signatureData: RAW_B64, signerType: "employee", signingLocation: "Berlin" });
  });

  it("handles nested arrays of signatures (customer wizard payload)", () => {
    const stripped = transformSignatureFields(
      { signatures: [{ templateSlug: "a", customerSignatureData: DATA_URL }], signingLocation: null },
      "strip",
    );
    expect(stripped.signatures[0].customerSignatureData).toBe(RAW_B64);

    const restored = transformSignatureFields(stripped, "restore");
    expect(restored.signatures[0].customerSignatureData).toBe(DATA_URL);
  });

  it("restores both customer and employee signature fields", () => {
    const restored = transformSignatureFields(
      { customerSignatureData: RAW_B64, employeeSignatureData: RAW_B64 },
      "restore",
    );
    expect(restored.customerSignatureData).toBe(DATA_URL);
    expect(restored.employeeSignatureData).toBe(DATA_URL);
  });

  it("does not rewrite a signatureHash field", () => {
    const out = transformSignatureFields({ signatureHash: "data:image/png;base64,XYZ" }, "strip");
    expect(out.signatureHash).toBe("data:image/png;base64,XYZ");
  });

  it("leaves null signature fields and non-plain values untouched", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const out = transformSignatureFields(
      { signatureData: null, when: date, items: [1, 2, 3] },
      "restore",
    );
    expect(out.signatureData).toBeNull();
    expect(out.when).toBe(date);
    expect(out.items).toEqual([1, 2, 3]);
  });
});
