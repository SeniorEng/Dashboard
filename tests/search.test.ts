import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

const createdCustomerIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try {
      await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));
    } catch {}
  }
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

  it("SUCH-1.6 – Versichertennummer-Suche (Task #403) findet Kunden und liefert hint", async () => {
    const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
    expect(provRes.status).toBe(200);
    const insuranceProviderId = provRes.data[0].id;

    const vnr = "Z" + String(Math.floor(100000000 + Math.random() * 900000000));
    const createRes = await apiPost<any>("/api/admin/customers", {
      vorname: "QS-VnrSearch",
      nachname: "Test-" + uniqueId(),
      geburtsdatum: "1940-01-15",
      strasse: "Teststraße",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      insurance: { providerId: insuranceProviderId, versichertennummer: vnr, validFrom: "2024-01-01" },
      budgets: { entlastungsbetrag45b: 125, verhinderungspflege39: 0, pflegesachleistungen36: 0, validFrom: "2024-01-01" },
    });
    expect(createRes.status).toBe(201);
    createdCustomerIds.push(createRes.data.id);

    const searchRes = await apiGet<any[]>(`/api/search?q=${encodeURIComponent(vnr)}`);
    expect(searchRes.status).toBe(200);
    const hit = searchRes.data.find((r: any) => r.type === "customer" && r.id === createRes.data.id);
    expect(hit).toBeDefined();
    expect(hit.hint).toBeDefined();
    expect(String(hit.hint)).toContain(vnr);
  });
});
