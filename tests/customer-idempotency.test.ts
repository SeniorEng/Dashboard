import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import { customerCreationIdempotencyKeys } from "../shared/schema/idempotency";
import { apiGet, apiPost, getAuthCookie, uniqueId } from "./test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let insuranceProviderId: number;
const createdCustomerIds: number[] = [];
const idempotencyKeysToCleanup: string[] = [];

beforeAll(async () => {
  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  expect(provRes.status).toBe(200);
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  if (createdCustomerIds.length > 0) {
    try {
      await db.update(customers).set({ deletedAt: new Date() }).where(inArray(customers.id, createdCustomerIds));
    } catch {}
  }
  if (idempotencyKeysToCleanup.length > 0) {
    try {
      await db.delete(customerCreationIdempotencyKeys).where(inArray(customerCreationIdempotencyKeys.idempotencyKey, idempotencyKeysToCleanup));
    } catch {}
  }
});

function newCustomerPayload(overrides: Record<string, any> = {}) {
  return {
    vorname: "Idem-" + uniqueId().slice(0, 6),
    nachname: "Test-" + uniqueId(),
    geburtsdatum: "1942-03-04",
    strasse: "Idemstraße",
    nr: "7",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
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

async function postCustomerWithIdem(idemKey: string | null, body: unknown): Promise<{ status: number; data: any }> {
  const auth = await getAuthCookie();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
    "x-csrf-token": auth.csrfToken,
  };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await fetch(`${BASE_URL}/api/admin/customers`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe("Task #376 – Idempotency & Recent-Duplicate-Heuristik", () => {
  it("IDEM-1 – gleicher Key + gleicher Payload liefert dieselbe ID (kein Duplikat)", async () => {
    const key = `test-idem-${uniqueId()}`;
    idempotencyKeysToCleanup.push(key);
    const payload = newCustomerPayload();

    const first = await postCustomerWithIdem(key, payload);
    expect(first.status).toBe(201);
    expect(first.data.id).toBeDefined();
    createdCustomerIds.push(first.data.id);

    // Lost-response Simulation: zweiter POST mit identischem Key+Payload.
    const second = await postCustomerWithIdem(key, payload);
    expect(second.status).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.idempotent).toBe(true);
  });

  it("IDEM-1b – zwei parallele POSTs mit gleichem Key+Payload erzeugen genau einen Kunden (atomare Reservierung)", async () => {
    const key = `test-idem-${uniqueId()}`;
    idempotencyKeysToCleanup.push(key);
    const payload = newCustomerPayload();

    const [a, b] = await Promise.all([
      postCustomerWithIdem(key, payload),
      postCustomerWithIdem(key, payload),
    ]);

    // Beide Antworten müssen erfolgreich (200/201) und auf denselben
    // Kundendatensatz verweisen. Damit ist nachgewiesen, dass die atomare
    // Reservierung den klassischen Lookup-Then-Insert-Race ausschließt.
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    expect(a.data.id).toBeDefined();
    expect(a.data.id).toBe(b.data.id);
    createdCustomerIds.push(a.data.id);

    // Zusätzliche DB-Verifikation: Es darf keinen zweiten Datensatz mit
    // identischen Stammdaten + Geburtsdatum geben.
    const dupCount = await db.select().from(customers).where(
      eq(customers.geburtsdatum, payload.geburtsdatum),
    );
    const matching = dupCount.filter(c =>
      c.vorname === payload.vorname && c.nachname === payload.nachname && c.deletedAt === null,
    );
    expect(matching.length).toBe(1);
  });

  it("IDEM-2 – gleicher Key + abweichender Payload liefert 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const key = `test-idem-${uniqueId()}`;
    idempotencyKeysToCleanup.push(key);
    const payload = newCustomerPayload();

    const first = await postCustomerWithIdem(key, payload);
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);

    const divergent = await postCustomerWithIdem(key, { ...payload, strasse: "Anderestraße" });
    expect(divergent.status).toBe(409);
    expect(divergent.data.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("RECENT-1 – skipDuplicateCheck ohne acknowledgeRecentDuplicate liefert 409 RECENT_DUPLICATE_WARNING (10-Min-Heuristik)", async () => {
    const baseNachname = "Recent-" + uniqueId();
    const first = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({ vorname: "RecentDup", nachname: baseNachname }),
    );
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);

    const second = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({
        vorname: "RecentDup",
        nachname: baseNachname,
        skipDuplicateCheck: true,
      }),
    );
    expect(second.status).toBe(409);
    expect(second.data.code).toBe("RECENT_DUPLICATE_WARNING");
    expect(Array.isArray(second.data.details?.duplicates)).toBe(true);
    const dup = second.data.details.duplicates[0];
    expect(typeof dup.createdAt).toBe("string");
    expect(typeof dup.ageMs).toBe("number");
    expect(dup.ageMs).toBeLessThan(10 * 60 * 1000);
  });

  it("RECENT-2 – skipDuplicateCheck + acknowledgeRecentDuplicate erlaubt erneute Anlage trotz 10-Min-Treffer", async () => {
    const baseNachname = "RecentAck-" + uniqueId();
    const first = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({ vorname: "RecentAck", nachname: baseNachname }),
    );
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);

    const second = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({
        vorname: "RecentAck",
        nachname: baseNachname,
        skipDuplicateCheck: true,
        acknowledgeRecentDuplicate: true,
      }),
    );
    expect(second.status).toBe(201);
    createdCustomerIds.push(second.data.id);
    expect(second.data.id).not.toBe(first.data.id);
  });
});

describe("Task #376 – Doppelkunden-Report (read-only)", () => {
  it("REPORT-1 – /admin/customers/duplicates listet nicht-soft-gelöschte Namensduplikate", async () => {
    const baseNachname = "ReportDup-" + uniqueId();
    const a = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({ vorname: "ReportDup", nachname: baseNachname }),
    );
    expect(a.status).toBe(201);
    createdCustomerIds.push(a.data.id);

    const b = await apiPost<any>(
      "/api/admin/customers",
      newCustomerPayload({
        vorname: "ReportDup",
        nachname: baseNachname,
        skipDuplicateCheck: true,
        acknowledgeRecentDuplicate: true,
      }),
    );
    expect(b.status).toBe(201);
    createdCustomerIds.push(b.data.id);

    const auth = await getAuthCookie();
    const res = await fetch(`${BASE_URL}/api/admin/customers/duplicates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
        "x-csrf-token": auth.csrfToken,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const groups: Array<{ key: string; customers: Array<{ id: number }> }> = json.groups || json.data?.groups || json;
    const arr = Array.isArray(groups) ? groups : [];
    const matched = arr.find(g => (g.customers || []).some(c => c.id === a.data.id) && (g.customers || []).some(c => c.id === b.data.id));
    expect(matched).toBeDefined();
  });
});
