import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  getAuthCookie,
} from "./test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

describe("SUCH-1: Globale Suche", () => {
  it("SUCH-1.1 – Suche mit gültigem Query liefert Ergebnisse", async () => {
    const res = await apiGet<any[]>("/api/search?q=test");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("SUCH-1.2 – Zu kurze Suche liefert leeres Array", async () => {
    const res = await apiGet<any[]>("/api/search?q=a");
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it("SUCH-1.3 – Leere Suche liefert leeres Array", async () => {
    const res = await apiGet<any[]>("/api/search?q=");
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it("SUCH-1.4 – Suchergebnisse haben korrekte Struktur", async () => {
    const res = await apiGet<any[]>("/api/search?q=test");
    expect(res.status).toBe(200);
    if (res.data.length > 0) {
      const result = res.data[0];
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("subtitle");
      expect(result).toHaveProperty("href");
      expect(["customer", "appointment"]).toContain(result.type);
    }
  });

  it("SUCH-1.5 – Sonderzeichen werden korrekt verarbeitet", async () => {
    const res = await apiGet<any[]>("/api/search?q=Müller");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
