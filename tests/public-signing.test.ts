import { describe, it, expect } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

async function publicGet<T = unknown>(path: string): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}${path}`);
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

async function publicPost<T = unknown>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data: data as T };
}

describe("SIGN-1: Öffentliche Unterschrift – Token-Validierung", () => {
  it("SIGN-1.1 – Ungültiger Token liefert 404", async () => {
    const res = await publicGet<any>("/api/public/sign/invalid-token-12345abcdef");
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("NOT_FOUND");
  });

  it("SIGN-1.2 – Zufälliger Token liefert 404", async () => {
    const res = await publicGet<any>("/api/public/sign/abc123def456");
    expect(res.status).toBe(404);
  });
});

describe("SIGN-2: Öffentliche Unterschrift – Speichern", () => {
  it("SIGN-2.1 – POST mit ungültigem Token wird abgelehnt", async () => {
    const res = await publicPost<any>("/api/public/sign/invalid-token-12345abcdef", {
      signatureData: "data:image/png;base64,test",
    });
    expect(res.status).toBe(404);
  });

  it("SIGN-2.2 – POST ohne Daten mit ungültigem Token wird abgelehnt", async () => {
    const res = await publicPost<any>("/api/public/sign/invalid-token-12345abcdef", {});
    expect(res.status).toBe(404);
  });
});
