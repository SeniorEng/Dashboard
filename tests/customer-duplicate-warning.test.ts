import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import {
  apiGet,
  apiPost,
  uniqueId,
} from "./test-utils";

let insuranceProviderId: number;
const createdCustomerIds: number[] = [];

beforeAll(async () => {
  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  expect(provRes.data.length).toBeGreaterThan(0);
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try {
      await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));
    } catch {}
  }
});

function customerPayload(overrides: Record<string, any> = {}) {
  return {
    vorname: "QS-DupTest",
    nachname: "Mustermann-" + uniqueId(),
    geburtsdatum: "1940-01-15",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    budgets: {
      entlastungsbetrag45b: 125,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: "2024-01-01",
    },
    ...overrides,
  };
}

describe("DUP-1: POST /api/admin/customers Duplikat-Warnung", () => {
  const baseNachname = "Mueller-Test-" + uniqueId();
  const baseGeburtsdatum = "1940-01-15";

  it("DUP-1.1 – Kunde wird angelegt, wenn kein Duplikat existiert", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({ vorname: "QS-Erst", nachname: baseNachname, geburtsdatum: baseGeburtsdatum }),
    );
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    createdCustomerIds.push(res.data.id);
  });

  it("DUP-1.2 – Zweiter Kunde mit gleichem Namen liefert 409 DUPLICATE_WARNING", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({ vorname: "QS-Erst", nachname: baseNachname, geburtsdatum: baseGeburtsdatum }),
    );
    expect(res.status).toBe(409);
    expect(res.data).toMatchObject({
      error: "DUPLICATE_WARNING",
      code: "DUPLICATE_WARNING",
    });
    expect(res.data.details).toBeDefined();
    expect(Array.isArray(res.data.details.duplicates)).toBe(true);
    expect(res.data.details.duplicates.length).toBeGreaterThan(0);
  });

  it("DUP-1.3 – Case-Insensitivity: Mueller vs. mueller wird als Duplikat erkannt", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({
        vorname: "qs-erst",
        nachname: baseNachname.toLowerCase(),
        geburtsdatum: baseGeburtsdatum,
      }),
    );
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("DUPLICATE_WARNING");
  });

  it("DUP-1.4 – Mit skipDuplicateCheck + acknowledgeRecentDuplicate wird Kunde trotz Duplikat angelegt", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({
        vorname: "QS-Erst",
        nachname: baseNachname,
        geburtsdatum: baseGeburtsdatum,
        skipDuplicateCheck: true,
        // Task #376: Server verlangt zusätzlich Bestätigung im 10-Min-Fenster.
        acknowledgeRecentDuplicate: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    createdCustomerIds.push(res.data.id);
  });

  it("DUP-1.5 – geburtsdatum-Filter: Gleicher Name + abweichendes Geburtsdatum liefert kein Duplikat", async () => {
    const checkRes = await apiGet<any>(
      `/api/admin/customers/check-duplicate?vorname=${encodeURIComponent("QS-Erst")}&nachname=${encodeURIComponent(baseNachname)}&geburtsdatum=1999-12-31`,
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.duplicates.length).toBe(0);

    const res = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({
        vorname: "QS-Erst",
        nachname: baseNachname,
        geburtsdatum: "1999-12-31",
      }),
    );
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);
  });

  it("DUP-1.6 – deletedAt-Filter: Soft-gelöschter Kunde löst keine Warnung mehr aus", async () => {
    const targetNachname = "Soft-Del-Test-" + uniqueId();
    const createRes = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({ vorname: "QS-Soft", nachname: targetNachname }),
    );
    expect(createRes.status).toBe(201);
    const id = createRes.data.id;
    createdCustomerIds.push(id);

    const dupRes = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({ vorname: "QS-Soft", nachname: targetNachname }),
    );
    expect(dupRes.status).toBe(409);

    await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));

    const checkRes = await apiGet<any>(
      `/api/admin/customers/check-duplicate?vorname=${encodeURIComponent("QS-Soft")}&nachname=${encodeURIComponent(targetNachname)}`,
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.data.duplicates.length).toBe(0);

    const reuseRes = await apiPost<any>(
      "/api/admin/customers",
      customerPayload({ vorname: "QS-Soft", nachname: targetNachname }),
    );
    expect(reuseRes.status).toBe(201);
    createdCustomerIds.push(reuseRes.data.id);
  });
});
