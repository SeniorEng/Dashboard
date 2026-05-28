import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { customers } from "../shared/schema";
import { apiGet, apiPost, uniqueId, getAuthCookie } from "./test-utils";

// Task #724 (BUG-4) — Reproducer + Vertrag.
//
// `POST /api/admin/customers` legt einen Pflegekasse-Kunden (PG ≥ 2) ohne
// `budgets`-Block an. Die statutorischen Töpfe (§45b/§45a/§39-§42a) werden
// dabei NICHT automatisch initialisiert — der Server signalisiert das aber
// explizit über `budgetSetupRequired: true` + `requiredBudgetTypes`, damit
// API-Konsumenten (Wizard, Skripte, Drittsysteme) ohne String-Parsing
// erkennen, dass noch Folge-Calls (`/initial-budget` + `/type-settings`)
// nötig sind. `GET /api/budget/:id/overview` direkt nach der Anlage liefert
// erwartungsgemäß einen leeren Topf (Smoke-Anchor für die Kombination
// „angelegt + Overview leer").
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let insuranceProviderId: number;
const createdCustomerIds: number[] = [];

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
});

function pflegekassePayload(pflegegrad: number, overrides: Record<string, any> = {}) {
  return {
    billingType: "pflegekasse_gesetzlich",
    vorname: "BudgetMarker",
    nachname: "Test-" + uniqueId(),
    geburtsdatum: "1942-03-04",
    strasse: "Marker-Straße",
    nr: "7",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad,
    pflegegradSeit: "2024-01-01",
    insurance: {
      providerId: insuranceProviderId,
      versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
      validFrom: "2024-01-01",
    },
    ...overrides,
  };
}

describe("Task #724 — Customer-Create Budget-Setup-Marker", () => {
  it("Pflegekasse + PG4 ohne budgets → budgetSetupRequired=true & Overview leer", async () => {
    const res = await apiPost<any>("/api/admin/customers", pflegekassePayload(4));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(true);
    expect(res.data.requiredBudgetTypes).toEqual(
      expect.arrayContaining(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    );

    // Smoke-Anchor: Overview ist tatsächlich leer — die Markierung lügt nicht.
    const overview = await apiGet<any>(`/api/budget/${res.data.id}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.data.entlastungsbetrag45b.totalAllocatedCents).toBe(0);
    expect(overview.data.umwandlung45a.isCurrentlyActive).toBe(false);
  });

  it("Pflegekasse + PG4 mit budgets-Block → budgetSetupRequired=false", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      pflegekassePayload(4, {
        budgets: {
          entlastungsbetrag45b: 13100,
          verhinderungspflege39: 0,
          pflegesachleistungen36: 0,
          validFrom: "2024-01-01",
        },
      }),
    );
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });

  it("Pflegekasse_privat + PG4 ohne budgets → budgetSetupRequired=true (gleicher Vertrag wie gesetzlich)", async () => {
    const res = await apiPost<any>(
      "/api/admin/customers",
      pflegekassePayload(4, { billingType: "pflegekasse_privat" }),
    );
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(true);
    expect(res.data.requiredBudgetTypes).toEqual(
      expect.arrayContaining(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    );
  });

  it("Pflegekasse + PG1 ohne budgets → budgetSetupRequired=false (kein Auto-§45a)", async () => {
    const res = await apiPost<any>("/api/admin/customers", pflegekassePayload(1));
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });

  it("Idempotency-Replay (200 hit) liefert Marker auf Basis des IST-Zustands", async () => {
    // `apiPost` reicht keinen freien Header durch — Idempotency-Key muss
    // direkt über fetch gesetzt werden. Cookie/CSRF kommen aus dem
    // gemeinsamen Helper, damit die Auth-Logik nicht dupliziert wird.
    const auth = await getAuthCookie();
    const idempotencyKey = "task724-replay-" + uniqueId();
    const payload = pflegekassePayload(4);

    const post = async () => {
      const r = await fetch(`${BASE_URL}/api/admin/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
          "x-csrf-token": auth.csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      return { status: r.status, data: (await r.json().catch(() => null)) as any };
    };

    const first = await post();
    expect(first.status).toBe(201);
    createdCustomerIds.push(first.data.id);
    expect(first.data.budgetSetupRequired).toBe(true);

    // Direkter Retry mit gleichem Key + Payload — Server antwortet 200 +
    // idempotent:true, MUSS aber laut Vertrag #724 die Marker-Felder
    // mitliefern (sonst sieht ein retry-fähiger Client die Vertragslücke
    // nicht).
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(replay.data.idempotent).toBe(true);
    expect(replay.data.id).toBe(first.data.id);
    expect(replay.data.budgetSetupRequired).toBe(true);
    expect(replay.data.requiredBudgetTypes).toEqual(
      expect.arrayContaining(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
    );
  });

  it("Selbstzahler ohne budgets → budgetSetupRequired=false (kein Anspruch)", async () => {
    const res = await apiPost<any>("/api/admin/customers", {
      billingType: "selbstzahler",
      vorname: "BudgetMarker",
      nachname: "Selbst-" + uniqueId(),
      strasse: "Marker-Straße",
      nr: "9",
      plz: "10115",
      stadt: "Berlin",
      email: "selbst-" + uniqueId() + "@example.com",
      documentDeliveryMethod: "email",
    });
    expect(res.status).toBe(201);
    createdCustomerIds.push(res.data.id);

    expect(res.data.budgetSetupRequired).toBe(false);
    expect(res.data.requiredBudgetTypes).toEqual([]);
  });
});
