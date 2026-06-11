/**
 * Task #1168 (Audit A) — Budget-Eingaben serverseitig absichern.
 *
 * Die Budget-Audits zeigten, dass §45a-Monatslimits über dem
 * Pflegegrad-Maximum, §39/§42a-Jahreslimits über dem gesetzlichen Maximum
 * (3.539 €) sowie gesetzliche Töpfe für Selbstzahler / Pflegegrad < 2
 * persistiert werden konnten. Diese Suite pinnt die serverseitigen Guards
 * auf BEIDEN Schreibpfaden:
 *
 *   - `PUT  /api/budget/:id/type-settings` (Bestands-Edit)
 *   - `POST /api/admin/customers`          (Kundenanlage / Wizard-Submit)
 *
 * Erwartung nach #1168:
 *   - PUT §39/§42a-Jahreslimit > 3.539 €           → 400 VALIDATION_ERROR
 *   - PUT §45a-Monatslimit  > PG-Maximum            → 400 VALIDATION_ERROR
 *   - PUT §39/§42a enabled bei PG1                  → 409 PFLEGEGRAD
 *   - Create Selbstzahler + §45b                    → 409 SELBSTZAHLER
 *   - Create PG1 + §39/§42a                          → 409 PFLEGEGRAD
 *   - Grenzwerte (exakt am Maximum) bleiben erlaubt → 200
 *   - allocation == overview am §45a-Cap (Lesepfad klemmt konsistent)
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  getAuthCookie,
  runCleanup,
} from "../test-utils";

// §45a-Maximum bei Pflegegrad 2 = 318,40 € (31840 ct), §39/§42a-Jahresmaximum
// = 3.539,00 € (353900 ct). Beträge bewusst als nackte Cent-Literale, damit der
// Test bei einer versehentlichen Limit-Änderung in der Domäne sichtbar bricht.
const MAX_45A_PG2_CENTS = 31840;
const MAX_39_42A_YEARLY_CENTS = 353900;

// EIN Datums-Anker (Monatsanfang) — vermeidet die Monatsgrenzen-Falle der
// Wegwerf-DB (Anker für validFrom der Create-Budget-Payload).
const now = new Date();
const MONTH_START = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

/**
 * Voller Create-Payload für `POST /api/admin/customers` inkl. Budget-Block.
 * Im Gegensatz zu `createTestCustomer` wird der Status NICHT geprüft, damit
 * Ablehnungen (409/400) assertbar bleiben.
 */
function buildCreatePayload(overrides: Record<string, unknown> = {}) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  return {
    vorname: "T1168",
    nachname: `Auto_${suffix}`,
    geburtsdatum: "1940-01-15",
    email: `t1168-${suffix}@test.local`,
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    telefon: "+4917600000000",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    budgets: {
      entlastungsbetrag45b: 0,
      verhinderungspflege39: 0,
      pflegesachleistungen36: 0,
      validFrom: MONTH_START,
    },
    ...overrides,
  };
}

describe("Task #1168 — PUT type-settings: statutorische Limits", () => {
  it("§39/§42a-Jahreslimit über 3.539 € → 400 VALIDATION_ERROR", async () => {
    const c = await createTestCustomer({ vorname: "T1168-39-over", pflegegrad: 3, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 500000 },
        ],
      });
      expect(res.status, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.data?.error).toBe("VALIDATION_ERROR");
      expect(res.data?.message).toMatch(/3\.539/);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("§45a-Monatslimit über dem Pflegegrad-Maximum → 400 VALIDATION_ERROR", async () => {
    const c = await createTestCustomer({ vorname: "T1168-45a-over", pflegegrad: 2, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: 50000 },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });
      expect(res.status, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.data?.error).toBe("VALIDATION_ERROR");
      expect(res.data?.message).toMatch(/Pflegegrad\s*2/);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("§39/§42a enabled bei Pflegegrad 1 → 409 PFLEGEGRAD", async () => {
    const c = await createTestCustomer({ vorname: "T1168-39-pg1", pflegegrad: 1, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: 100000 },
        ],
      });
      expect(res.status, `expected 409, got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("§39/§42a-Jahreslimit exakt am Maximum (3.539 €) → 200", async () => {
    const c = await createTestCustomer({ vorname: "T1168-39-max", pflegegrad: 3, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: false, monthlyLimitCents: null },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: true, yearlyLimitCents: MAX_39_42A_YEARLY_CENTS },
        ],
      });
      expect(res.status, `expected 200, got ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("§45a-Monatslimit exakt am Pflegegrad-Maximum → 200", async () => {
    const c = await createTestCustomer({ vorname: "T1168-45a-max", pflegegrad: 2, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: MAX_45A_PG2_CENTS },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });
      expect(res.status, `expected 200, got ${res.status} ${JSON.stringify(res.data)}`).toBe(200);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);
});

describe("Task #1168 — Create-Pfad: Selbstzahler-/Pflegegrad-Block", () => {
  it("Selbstzahler + §45b im Create-Payload → 409 SELBSTZAHLER", async () => {
    let customerId: number | undefined;
    try {
      const res = await apiPost<any>("/api/admin/customers", buildCreatePayload({
        billingType: "selbstzahler",
        acceptsPrivatePayment: true,
        budgets: { entlastungsbetrag45b: 13100, verhinderungspflege39: 0, pflegesachleistungen36: 0, validFrom: MONTH_START },
      }));
      customerId = res.data?.id;
      expect(res.status, `expected 409, got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("Pflegegrad 1 + §39/§42a im Create-Payload → 409 PFLEGEGRAD", async () => {
    let customerId: number | undefined;
    try {
      const res = await apiPost<any>("/api/admin/customers", buildCreatePayload({
        pflegegrad: 1,
        budgets: { entlastungsbetrag45b: 0, verhinderungspflege39: 100000, pflegesachleistungen36: 0, validFrom: MONTH_START },
      }));
      customerId = res.data?.id;
      expect(res.status, `expected 409, got ${res.status} ${JSON.stringify(res.data)}`).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);

  it("Pflegegrad 2 + §45a über PG-Maximum im Create-Payload → 400", async () => {
    let customerId: number | undefined;
    try {
      const res = await apiPost<any>("/api/admin/customers", buildCreatePayload({
        pflegegrad: 2,
        budgets: { entlastungsbetrag45b: 0, verhinderungspflege39: 0, pflegesachleistungen36: 50000, validFrom: MONTH_START },
      }));
      customerId = res.data?.id;
      expect(res.status, `expected 400, got ${res.status} ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.data?.error).toBe("VALIDATION_ERROR");
      expect(res.data?.message).toMatch(/Pflegegrad\s*2/);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);
});

describe("Task #1168 — Lesepfad: allocation == overview am §45a-Cap", () => {
  it("§45a am Pflegegrad-Maximum → Overview zeigt geklemmten, konsistenten Topf", async () => {
    const c = await createTestCustomer({ vorname: "T1168-overview", pflegegrad: 2, billingType: "pflegekasse_gesetzlich" });
    const customerId = c.id as number;
    try {
      const put = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
        settings: [
          { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", priority: 2, enabled: true, monthlyLimitCents: MAX_45A_PG2_CENTS },
          { budgetType: "ersatzpflege_39_42a", priority: 3, enabled: false, yearlyLimitCents: null },
        ],
      });
      expect(put.status, `setup PUT expected 200, got ${put.status} ${JSON.stringify(put.data)}`).toBe(200);

      const ov = await apiGet<any>(`/api/budget/${customerId}/overview`);
      expect(ov.status, `overview expected 200, got ${ov.status} ${JSON.stringify(ov.data)}`).toBe(200);
      const a45 = ov.data?.umwandlung45a;
      expect(a45, "umwandlung45a fehlt in der Overview").toBeTruthy();
      // Monatsbudget ist auf das PG-Maximum geklemmt (SSoT, kein Über-Limit).
      expect(a45.monthlyBudgetCents).toBe(MAX_45A_PG2_CENTS);
      // Nichts gebucht → verfügbar == zugeteilt - verbraucht (interne Konsistenz)
      // und zugeteilt darf das geklemmte Cap nie überschreiten.
      expect(a45.currentMonthUsedCents).toBe(0);
      expect(a45.currentMonthAvailableCents).toBe(a45.currentMonthAllocatedCents - a45.currentMonthUsedCents);
      expect(a45.currentMonthAllocatedCents).toBeLessThanOrEqual(a45.monthlyBudgetCents);
    } finally {
      await cleanupCustomer(customerId);
    }
  }, 60_000);
});
