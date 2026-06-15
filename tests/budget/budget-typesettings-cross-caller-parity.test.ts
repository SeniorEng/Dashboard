/**
 * Task #1282 (Phase 2 / 2.3) — Cross-Caller-Intent-Paritätstest.
 *
 * Budget-Type-Settings haben GENAU EINEN Schreibpfad: die SSoT in
 * `server/storage/budget/preferences-storage.ts` (`upsertBudgetTypeSettings`
 * bzw. `ensureBudgetTypeEnabledInPlace`). Mehrere Produktions-Request-Caller
 * speisen IN diese SSoT ein und teilen sich dieselben reinen Validatoren —
 * es gibt KEINE zweite/abweichende Validierungsschicht je Caller:
 *
 *   - Pfad A: `PUT /api/budget/:customerId/type-settings`
 *             (rejectBudgetIntent + validate45a/39_42aAmount + §45b-Max).
 *   - Pfad B: `POST /api/admin/customers` mit `budgets`
 *             (validateSelbstzahlerBudget + validatePflegegradBudget +
 *              validate45a/39_42aAmount, VOR createCustomerRelatedData).
 *   - Pfad C: `POST /api/budget/:customerId/initial-budget` → `applyInitialBudget`
 *             (validateSelbstzahlerBudget + validatePflegegradBudget; aktiviert
 *              §45a/§39 idempotent über DIESELBE SSoT `ensureBudgetTypeEnabledInPlace`).
 *             Hinweis: Dieser Caller SETZT keine Topf-Limits (reines Enable +
 *             initial_balance), prüft also NICHT die §45a/§39-Maxima — diese
 *             gehören ausschließlich zum Limit-setzenden Intent (Pfad A/B).
 *
 * Dieser Test pinnt, dass die Pfade bei IDENTISCHEM Intent
 *   (a) bei gültigem Input DENSELBEN persistierten DB-Zustand erzeugen
 *       (Pfad A/B volle Limit-Parität; Pfad C Enable-Parität via SSoT) und
 *   (b) bei ungültigem Intent IDENTISCH ablehnen und NICHTS persistieren —
 * d. h. KEINE zweite/abweichende Validierungsschicht. Geprüft:
 *   - Selbstzahler-Block (§45b/§45a/§39-§42a)
 *   - Pflegegrad-Gates (§45a + §39/§42a erst ab PG≥2)
 *   - gesetzliche Maxima (§45b 131€/Monat, §45a per-PG, §39/§42a 3.539€/Jahr)
 *
 * Alle Beträge sind Integer-Cents. Pot-/Cap-Logik wird NICHT berührt.
 */
import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import {
  BUDGET_45B_MAX_MONTHLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
  BUDGET_39_42A_MAX_YEARLY_CENTS,
} from "@shared/domain/budgets";
import {
  apiPost,
  apiPut,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

const STATUTORY_POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

/** Aktive (enabled) Type-Settings-Zeilen eines Kunden, normalisiert für den Vergleich. */
async function activeTypeSettings(customerId: number) {
  const rows = await db
    .select()
    .from(customerBudgetTypeSettings)
    .where(
      and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.enabled, true),
      ),
    );
  return rows
    .map((r) => ({
      budgetType: r.budgetType,
      enabled: r.enabled,
      priority: r.priority,
      monthlyLimitCents: r.monthlyLimitCents,
      yearlyLimitCents: r.yearlyLimitCents,
    }))
    .sort((a, b) => a.budgetType.localeCompare(b.budgetType));
}

async function enabledRowCount(customerId: number, budgetType: string): Promise<number> {
  const rows = await db
    .select()
    .from(customerBudgetTypeSettings)
    .where(
      and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, budgetType),
        eq(customerBudgetTypeSettings.enabled, true),
      ),
    );
  return rows.length;
}

describe("Task #1282 — Cross-Caller-Intent-Parität Budget-Type-Settings", () => {
  const createdIds: number[] = [];
  const track = (id: number) => {
    createdIds.push(id);
    return id;
  };

  afterAll(async () => {
    for (const id of createdIds) await cleanupCustomer(id);
  });

  // -------------------------------------------------------------------------
  // (a) Positiv-Parität: gültiger Intent → identischer DB-Zustand
  // -------------------------------------------------------------------------
  it("gültiger Intent: PUT-Route und POST-Customers-Create erzeugen denselben DB-Zustand", async () => {
    const pg = 3;
    const yr = new Date().getFullYear();
    const ydate = `${yr}-01-01`;
    const limit45a = BUDGET_45A_MAX_BY_PFLEGEGRAD[pg]; // exakt am Cap, gültig
    const yearly39 = BUDGET_39_42A_MAX_YEARLY_CENTS; // exakt am Cap, gültig

    // Pfad A — bestehender Kunde, dann PUT type-settings.
    const a = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: pg });
    const idA = track(a.id as number);
    const putRes = await apiPut<any>(`/api/budget/${idA}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: limit45a, yearlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null, yearlyLimitCents: yearly39 },
      ],
    });
    expect(putRes.status).toBe(200);

    // Pfad B — Anlage MIT budgets (mappt auf §45b enable, §45a monthly, §39 yearly).
    const bRes = await apiPost<any>("/api/admin/customers", {
      vorname: "Parity",
      nachname: `B_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      geburtsdatum: "1940-01-15",
      email: `parity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      strasse: "Teststraße",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      telefon: "+4917600000000",
      pflegegrad: pg,
      pflegegradSeit: ydate,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      budgets: {
        // §45b-Eurobetrag dient nur als Enable-Signal (monthlyLimit bleibt null);
        // der konkrete Wert ist für die Type-Settings-Parität irrelevant.
        entlastungsbetrag45b: 5000,
        pflegesachleistungen36: limit45a,
        verhinderungspflege39: yearly39,
        validFrom: ydate,
      },
    });
    expect(bRes.status).toBe(201);
    const idB = track(bRes.data.id as number);

    const stateA = await activeTypeSettings(idA);
    const stateB = await activeTypeSettings(idB);
    expect(stateB).toEqual(stateA);
    // Sanity: alle drei Töpfe aktiv, §45b ohne Monats-Cap, §45a monatlich, §39 jährlich.
    expect(stateA).toEqual([
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
      { budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, monthlyLimitCents: null, yearlyLimitCents: yearly39 },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: limit45a, yearlyLimitCents: null },
    ]);
  });

  // -------------------------------------------------------------------------
  // (b1) Reject-Parität: Selbstzahler darf keinen gesetzlichen Topf aktivieren
  // -------------------------------------------------------------------------
  describe("Selbstzahler-Block — beide Pfade lehnen ab, nichts persistiert", () => {
    for (const pot of STATUTORY_POTS) {
      it(`PUT-Route lehnt ${pot} für Selbstzahler ab (409, 0 Zeilen)`, async () => {
        const c = await createTestCustomer({ billingType: "selbstzahler", acceptsPrivatePayment: false });
        const id = track(c.id as number);
        const res = await apiPut<any>(`/api/budget/${id}/type-settings`, {
          settings: [{ budgetType: pot, enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null }],
        });
        expect(res.status).toBe(409);
        expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
        expect(await enabledRowCount(id, pot)).toBe(0);
      });
    }

    it("POST-Customers-Create lehnt einen gesetzlichen Topf für Selbstzahler ab und legt keinen Kunden mit aktivem Topf an", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "Reject",
        nachname: `SZ_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        geburtsdatum: "1940-01-15",
        email: `reject-sz-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
        strasse: "Teststraße",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: 3,
        pflegegradSeit: "2024-01-01",
        billingType: "selbstzahler",
        acceptsPrivatePayment: false,
        budgets: { entlastungsbetrag45b: 5000, pflegesachleistungen36: 0, verhinderungspflege39: 0, validFrom: "2024-01-01" },
      });
      expect(res.status).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
      // Falls (defensiv) doch ein Kunde entstand: er darf KEINEN aktiven gesetzlichen Topf haben.
      if (res.data?.id) {
        const id = track(res.data.id as number);
        expect(await enabledRowCount(id, "entlastungsbetrag_45b")).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (b2) Reject-Parität: Pflegegrad-Gate (§45a + §39/§42a erst ab PG≥2)
  // -------------------------------------------------------------------------
  describe("Pflegegrad-Gate (PG1) — §45a/§42a beide Pfade lehnen ab", () => {
    it("PUT-Route lehnt §45a für PG1 ab und persistiert keine Zeile", async () => {
      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 1 });
      const id = track(c.id as number);
      const res = await apiPut<any>(`/api/budget/${id}/type-settings`, {
        settings: [{ budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: 10000, yearlyLimitCents: null }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await enabledRowCount(id, "umwandlung_45a")).toBe(0);
    });

    it("POST-Customers-Create lehnt §45a-Betrag für PG1 ab", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "Reject",
        nachname: `PG1_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        geburtsdatum: "1940-01-15",
        email: `reject-pg1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
        strasse: "Teststraße",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: 1,
        pflegegradSeit: "2024-01-01",
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        budgets: { entlastungsbetrag45b: 0, pflegesachleistungen36: 10000, verhinderungspflege39: 0, validFrom: "2024-01-01" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      if (res.data?.id) {
        const id = track(res.data.id as number);
        expect(await enabledRowCount(id, "umwandlung_45a")).toBe(0);
      }
    });

    it("PUT-Route lehnt §39/§42a für PG1 ab und persistiert keine Zeile", async () => {
      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 1 });
      const id = track(c.id as number);
      const res = await apiPut<any>(`/api/budget/${id}/type-settings`, {
        settings: [{ budgetType: "ersatzpflege_39_42a", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: 100000 }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await enabledRowCount(id, "ersatzpflege_39_42a")).toBe(0);
    });

    it("POST-Customers-Create lehnt §39/§42a-Betrag für PG1 ab", async () => {
      const res = await apiPost<any>("/api/admin/customers", {
        vorname: "Reject",
        nachname: `PG1b_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        geburtsdatum: "1940-01-15",
        email: `reject-pg1b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
        strasse: "Teststraße",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: 1,
        pflegegradSeit: "2024-01-01",
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        budgets: { entlastungsbetrag45b: 0, pflegesachleistungen36: 0, verhinderungspflege39: 100000, validFrom: "2024-01-01" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      if (res.data?.id) {
        const id = track(res.data.id as number);
        expect(await enabledRowCount(id, "ersatzpflege_39_42a")).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (b3) Reject-Parität: gesetzliche Maxima
  // -------------------------------------------------------------------------
  describe("Gesetzliche Maxima — über-Cap-Beträge werden abgelehnt", () => {
    it("PUT-Route lehnt §45b > 131€/Monat ab (0 Zeilen)", async () => {
      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
      const id = track(c.id as number);
      const res = await apiPut<any>(`/api/budget/${id}/type-settings`, {
        settings: [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: BUDGET_45B_MAX_MONTHLY_CENTS + 1, yearlyLimitCents: null }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await enabledRowCount(id, "entlastungsbetrag_45b")).toBe(0);
    });

    it("§45a über per-PG-Cap: PUT-Route und POST-Create lehnen identisch ab", async () => {
      const pg = 3;
      const overCap = BUDGET_45A_MAX_BY_PFLEGEGRAD[pg] + 1;

      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: pg });
      const id = track(c.id as number);
      const putRes = await apiPut<any>(`/api/budget/${id}/type-settings`, {
        settings: [{ budgetType: "umwandlung_45a", enabled: true, priority: 1, monthlyLimitCents: overCap, yearlyLimitCents: null }],
      });
      expect(putRes.status).toBeGreaterThanOrEqual(400);
      expect(putRes.status).toBeLessThan(500);
      expect(await enabledRowCount(id, "umwandlung_45a")).toBe(0);

      const postRes = await apiPost<any>("/api/admin/customers", {
        vorname: "Reject",
        nachname: `45A_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        geburtsdatum: "1940-01-15",
        email: `reject-45a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
        strasse: "Teststraße",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: pg,
        pflegegradSeit: "2024-01-01",
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        budgets: { entlastungsbetrag45b: 0, pflegesachleistungen36: overCap, verhinderungspflege39: 0, validFrom: "2024-01-01" },
      });
      expect(postRes.status).toBeGreaterThanOrEqual(400);
      expect(postRes.status).toBeLessThan(500);
      if (postRes.data?.id) {
        const idB = track(postRes.data.id as number);
        expect(await enabledRowCount(idB, "umwandlung_45a")).toBe(0);
      }
    });

    it("§39/§42a über 3.539€/Jahr: PUT-Route und POST-Create lehnen identisch ab", async () => {
      const overCap = BUDGET_39_42A_MAX_YEARLY_CENTS + 1;

      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
      const id = track(c.id as number);
      const putRes = await apiPut<any>(`/api/budget/${id}/type-settings`, {
        settings: [{ budgetType: "ersatzpflege_39_42a", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: overCap }],
      });
      expect(putRes.status).toBeGreaterThanOrEqual(400);
      expect(putRes.status).toBeLessThan(500);
      expect(await enabledRowCount(id, "ersatzpflege_39_42a")).toBe(0);

      const postRes = await apiPost<any>("/api/admin/customers", {
        vorname: "Reject",
        nachname: `39A_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        geburtsdatum: "1940-01-15",
        email: `reject-39a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
        strasse: "Teststraße",
        nr: "1",
        plz: "10115",
        stadt: "Berlin",
        telefon: "+4917600000000",
        pflegegrad: 3,
        pflegegradSeit: "2024-01-01",
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        budgets: { entlastungsbetrag45b: 0, pflegesachleistungen36: 0, verhinderungspflege39: overCap, validFrom: "2024-01-01" },
      });
      expect(postRes.status).toBeGreaterThanOrEqual(400);
      expect(postRes.status).toBeLessThan(500);
      if (postRes.data?.id) {
        const idB = track(postRes.data.id as number);
        expect(await enabledRowCount(idB, "ersatzpflege_39_42a")).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (c) Pfad C — `POST /:customerId/initial-budget` (`applyInitialBudget`)
  //     teilt sich SSoT + Validatoren mit Pfad A/B. Dieser Caller SETZT keine
  //     Limits (reines Enable + initial_balance), daher nur Enable-/Reject-
  //     Parität — die §45a/§39-Maxima gehören zum Limit-Intent (Pfad A/B).
  // -------------------------------------------------------------------------
  describe("Pfad C — initial-budget aktiviert über DIESELBE SSoT und teilt die Validatoren", () => {
    it("gültig: §45a-Startbudget aktiviert den Topf via SSoT (enabled, ohne Limit)", async () => {
      const yr = new Date().getFullYear();
      const ydate = `${yr}-01-01`;
      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 3 });
      const id = track(c.id as number);

      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 10000,
        budgetStartDate: ydate,
      });
      expect(res.status).toBe(201);

      // Enable-Parität: genau EINE aktive §45a-Zeile, von der SSoT geschrieben.
      // `ensureBudgetTypeEnabledInPlace` setzt KEINE Limits (reines Enable).
      const rows = await activeTypeSettings(id);
      const s45a = rows.find((r) => r.budgetType === "umwandlung_45a");
      expect(s45a, "§45a-Type-Setting fehlt (kein SSoT-Schreibvorgang)").toBeTruthy();
      expect(s45a!.enabled).toBe(true);
      expect(s45a!.monthlyLimitCents).toBeNull();
      expect(s45a!.yearlyLimitCents).toBeNull();
      expect(await enabledRowCount(id, "umwandlung_45a")).toBe(1);
    });

    it("Reject-Parität: Selbstzahler-Startbudget §45a → 409 (gleicher Code, 0 Zeilen)", async () => {
      const yr = new Date().getFullYear();
      const c = await createTestCustomer({ billingType: "selbstzahler", acceptsPrivatePayment: false });
      const id = track(c.id as number);

      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 10000,
        budgetStartDate: `${yr}-01-01`,
      });
      // Identisch zu Pfad A/B: derselbe geteilte Validator → 409 + derselbe Code.
      expect(res.status).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
      expect(await enabledRowCount(id, "umwandlung_45a")).toBe(0);
    });

    it("Reject-Parität: §45a-Startbudget für PG1 → 409 (gleicher Code, 0 Zeilen)", async () => {
      const yr = new Date().getFullYear();
      const c = await createTestCustomer({ billingType: "pflegekasse_gesetzlich", pflegegrad: 1 });
      const id = track(c.id as number);

      const res = await apiPost<any>(`/api/budget/${id}/initial-budget`, {
        budgetType: "umwandlung_45a",
        currentMonthAmountCents: 10000,
        budgetStartDate: `${yr}-01-01`,
      });
      // Identisch zu Pfad A/B: PG-Gate ab PG≥2 → 409 + derselbe Code.
      expect(res.status).toBe(409);
      expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD");
      expect(await enabledRowCount(id, "umwandlung_45a")).toBe(0);
    });
  });
});
