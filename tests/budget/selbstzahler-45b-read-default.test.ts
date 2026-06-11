import { describe, it, expect, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  createTestCustomer,
  cleanupCustomer,
  uniqueId,
} from "../test-utils";

// BUG-19-Rest — Lese-Default der gesetzlichen Töpfe ist anspruchs-gegated.
//
// Selbstzahler haben KEINEN Anspruch auf §45b/§45a/§39. Auch wenn KEINE
// persistierte type-settings-Zeile existiert, MUSS der Default §45b=false
// liefern (§45a/§39 ohnehin false). Pflegekasse-Kunden (PG≥1) bekommen §45b=true.
//
// Anlage-Pfade: Admin-API, Wizard und Prospect-Konvertierung laufen alle über
// POST /api/admin/customers (Wizard/Prospect füllen dasselbe Formular vor),
// Excel-Import legt KEINE Kunden-Budgets an. Zusätzlich sperrt der
// §45b-Schreib-Gate (`validateSelbstzahlerBudget`) jede Persistierung einer
// §45b-Zeile für Selbstzahler (409). Damit ist der Lese-Default die SSoT für
// alle Pfade; er wird hier end-to-end über Route (type-settings) + Storage
// (overview) gepinnt. Den dritten Lese-Ort (unified-reader) deckt der reine
// Unit-Test `tests/unit/budget-default-statutory-pot-enabled.test.ts` ab — alle
// drei Orte rufen denselben Helper.

type TypeSetting = { budgetType: string; enabled: boolean };

function enabledOf(rows: TypeSetting[], budgetType: string): boolean {
  const row = rows.find((r) => r.budgetType === budgetType);
  if (!row) throw new Error(`type-setting ${budgetType} fehlt in der Response`);
  return row.enabled;
}

describe("BUG-19-Rest — §45b Lese-Default nach billingType (Anlage-Pfade)", () => {
  const createdIds: number[] = [];

  afterAll(async () => {
    for (const id of createdIds) await cleanupCustomer(id);
  });

  it("Selbstzahler ohne budgets → §45b/§45a/§39 alle default-deaktiviert", async () => {
    const c = await createTestCustomer({
      billingType: "selbstzahler",
      acceptsPrivatePayment: false,
    });
    createdIds.push(c.id as number);

    const ts = await apiGet<TypeSetting[]>(`/api/budget/${c.id}/type-settings`);
    expect(ts.status).toBe(200);
    expect(enabledOf(ts.data, "entlastungsbetrag_45b")).toBe(false);
    expect(enabledOf(ts.data, "umwandlung_45a")).toBe(false);
    expect(enabledOf(ts.data, "ersatzpflege_39_42a")).toBe(false);

    // Storage-Lesepfad (overview → getAllBudgetSummariesServed) zieht denselben Gate.
    const ov = await apiGet<any>(`/api/budget/${c.id}/overview`);
    expect(ov.status).toBe(200);
    expect(ov.data.entlastungsbetrag45b.isCurrentlyActive).toBe(false);
  });

  it("Pflegekasse (gesetzlich) PG1 ohne budgets → §45b aktiv, §45a/§39 deaktiviert", async () => {
    const c = await createTestCustomer({
      billingType: "pflegekasse_gesetzlich",
      pflegegrad: 1,
    });
    createdIds.push(c.id as number);

    const ts = await apiGet<TypeSetting[]>(`/api/budget/${c.id}/type-settings`);
    expect(ts.status).toBe(200);
    expect(enabledOf(ts.data, "entlastungsbetrag_45b")).toBe(true);
    expect(enabledOf(ts.data, "umwandlung_45a")).toBe(false);
    expect(enabledOf(ts.data, "ersatzpflege_39_42a")).toBe(false);

    const ov = await apiGet<any>(`/api/budget/${c.id}/overview`);
    expect(ov.status).toBe(200);
    expect(ov.data.entlastungsbetrag45b.isCurrentlyActive).toBe(true);
  });

  it("Selbstzahler mit budgets.entlastungsbetrag45b>0 → 409 (Schreib-Gate)", async () => {
    // Voll valider Create-Payload (gleiche Pflichtfelder wie createTestCustomer),
    // damit NICHT die Zod-Body-Validierung (400) zuschlägt, sondern der
    // Selbstzahler-§45b-Schreib-Gate im Create-Pfad (customers.ts → 409).
    const payload = {
      vorname: "SZ45b",
      nachname: `Reject_${uniqueId()}`,
      geburtsdatum: "1942-03-04",
      email: `sz45b-${uniqueId()}@test.local`,
      strasse: "Teststraße",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      telefon: "+4917600000000",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      acceptsPrivatePayment: true,
      billingType: "selbstzahler",
      // budgets.validFrom ist im Create-Schema Pflicht; ohne käme ein Zod-400
      // statt des fachlichen Selbstzahler-Gates (409).
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2026-01-01",
      },
    };
    const res = await apiPost<any>("/api/admin/customers", payload);
    expect(res.status).toBe(409);
    expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
    if (res.data?.id) createdIds.push(res.data.id);
  });
});
