import { describe, it, expect, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import {
  apiGet,
  apiPost,
  apiPut,
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

  // Task #1225 — Bestands-Altlast (selbstzahler mit persistierter, offener
  // §45b-`enabled=true`-Zeile) muss sich über die reguläre Route deaktivieren
  // lassen. Die Zeile wird direkt über die Storage-Schicht geseedet, weil der
  // Route-Schreib-Gate (validateSelbstzahlerBudget) das Anlegen einer
  // §45b-Zeile für Selbstzahler hart blockt — genau diese Konstellation
  // existiert aber als Altbestand in Prod (Kunde 41).
  it("Selbstzahler mit persistierter enabled-§45b-Zeile lässt sich deaktivieren (200, append-only)", async () => {
    const c = await createTestCustomer({
      billingType: "selbstzahler",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    createdIds.push(customerId);

    // Altlast seeden: offene, bereits seit einem vergangenen Stichtag in Kraft
    // befindliche §45b-Zeile (enabled=true) — bypassed den Route-Schreib-Gate.
    // Ein vergangenes `validFrom` spiegelt die echte Prod-Altlast (Kunde 41)
    // und erzwingt beim Deaktivieren den GoBD-Transitions-Pfad (Vorgänger
    // schließen + neue Zeile), nicht den Same-Day-In-Place-Pfad.
    await upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, validFrom: "2024-06-15" },
    ], undefined, undefined, { allowStatutoryForSelbstzahler: true });

    const before = await apiGet<TypeSetting[]>(`/api/budget/${customerId}/type-settings`);
    expect(before.status).toBe(200);
    expect(enabledOf(before.data, "entlastungsbetrag_45b")).toBe(true);

    // Deaktivier-Payload über die reguläre Route.
    const put = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null },
      ],
    });
    expect(put.status).toBe(200);

    const after = await apiGet<TypeSetting[]>(`/api/budget/${customerId}/type-settings`);
    expect(after.status).toBe(200);
    expect(enabledOf(after.data, "entlastungsbetrag_45b")).toBe(false);

    // Append-only-Garantie: die ursprüngliche enabled=true-Zeile bleibt
    // erhalten (kein rohes UPDATE/DELETE), sie wird nur über `validTo`
    // geschlossen; daneben existiert die neue enabled=false-Zeile.
    const rows = await db
      .select()
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.customerId, customerId))
      .orderBy(asc(customerBudgetTypeSettings.id))
      .then(r => r.filter(x => x.budgetType === "entlastungsbetrag_45b"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some(r => r.enabled === true && r.validTo != null)).toBe(true);
    const open = rows.filter(r => r.validTo == null);
    expect(open).toHaveLength(1);
    expect(open[0].enabled).toBe(false);
  });

  // Task #1225 — eigentliche Prod-Regression: ein reiner Deaktivier-Payload
  // (alle Töpfe enabled:false) auf eine NICHT existierende Kunden-ID lief
  // früher blind in den Append-/Insert-Pfad und löste eine FK-Verletzung (500)
  // aus. Erwartung jetzt: sauberer 404 „Kunde nicht gefunden", kein 500.
  it("Deaktivier-Payload auf nicht existierenden Kunden → 404, nicht 500", async () => {
    const nonExistentId = 999_000_000 + Math.floor(Math.random() * 1_000_000);
    const put = await apiPut<any>(`/api/budget/${nonExistentId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
      ],
    });
    expect(put.status).toBe(404);
    expect(put.data?.error).toBe("NOT_FOUND");
  });
});
