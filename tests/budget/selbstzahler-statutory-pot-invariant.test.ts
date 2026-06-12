import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { customerBudgetTypeSettings } from "@shared/schema";
import {
  upsertBudgetTypeSettings,
  SelbstzahlerStatutoryPotError,
} from "../../server/storage/budget/preferences-storage";
import {
  apiGet,
  apiPut,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

// Task #1233 — Invarianten-/Regressions-Test: Selbstzahler dürfen NIE einen
// gesetzlichen Pflegekassen-Topf (§45b Entlastungsbetrag, §45a
// Umwandlungsanspruch, §39/§42a Ersatzpflege) mit `enabled=true` bekommen.
//
// Diese Töpfe sind Pflegekassenleistungen (SGB XI); wer privat zahlt, hat
// keinen Anspruch. Die fachliche Regel wird hier auf BEIDEN Schreibebenen
// gepinnt — Defense-in-Depth, damit die Invariante nicht nur an der Route hängt:
//
//   1. Route-Pfad   PUT /:customerId/type-settings → 409
//      BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER (Gate `rejectBudgetIntent`).
//   2. Storage-Pfad upsertBudgetTypeSettings (direkter Aufruf, der die Route
//      umgeht) → wirft SelbstzahlerStatutoryPotError (Gate im Storage).
//
// In beiden Fällen wird zusätzlich asserted, dass KEINE persistierte
// enabled-Zeile zurückbleibt. Deaktivieren bleibt immer erlaubt (Rückbau von
// Prod-Altlasten wie Kunde 41), und der dokumentierte Korrektur-/Seed-Escape
// (`allowStatutoryForSelbstzahler`) bleibt funktionsfähig.

const STATUTORY_POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

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

describe("Task #1233 — Selbstzahler dürfen keinen gesetzlichen Topf aktivieren (Invariante)", () => {
  const createdIds: number[] = [];

  afterAll(async () => {
    for (const id of createdIds) await cleanupCustomer(id);
  });

  async function makeSelbstzahler(): Promise<number> {
    const c = await createTestCustomer({
      billingType: "selbstzahler",
      acceptsPrivatePayment: false,
    });
    const id = c.id as number;
    createdIds.push(id);
    return id;
  }

  describe("Route-Pfad PUT /:customerId/type-settings", () => {
    for (const pot of STATUTORY_POTS) {
      it(`lehnt enabled=${pot} für Selbstzahler mit 409 ab und persistiert keine Zeile`, async () => {
        const customerId = await makeSelbstzahler();

        const res = await apiPut<any>(`/api/budget/${customerId}/type-settings`, {
          settings: [
            { budgetType: pot, enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
          ],
        });

        expect(res.status).toBe(409);
        expect(res.data?.code).toBe("BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER");
        expect(await enabledRowCount(customerId, pot)).toBe(0);
      });
    }
  });

  describe("Storage-Pfad upsertBudgetTypeSettings (umgeht die Route)", () => {
    for (const pot of STATUTORY_POTS) {
      it(`wirft beim direkten Aktivieren von ${pot} für Selbstzahler und persistiert keine Zeile`, async () => {
        const customerId = await makeSelbstzahler();

        await expect(
          upsertBudgetTypeSettings(customerId, [
            { budgetType: pot, enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null },
          ]),
        ).rejects.toBeInstanceOf(SelbstzahlerStatutoryPotError);

        expect(await enabledRowCount(customerId, pot)).toBe(0);
      });
    }

    it("wirft auch, wenn ein gesetzlicher Topf zusammen mit erlaubten Töpfen kommt", async () => {
      const customerId = await makeSelbstzahler();

      let caught: unknown = null;
      try {
        await upsertBudgetTypeSettings(customerId, [
          { budgetType: "selbstzahler", enabled: true, priority: 1, monthlyLimitCents: null },
          { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: null },
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SelbstzahlerStatutoryPotError);
      expect((caught as SelbstzahlerStatutoryPotError).code).toBe(
        "BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER",
      );
      expect(await enabledRowCount(customerId, "umwandlung_45a")).toBe(0);
    });
  });

  describe("erlaubte Pfade bleiben unberührt", () => {
    it("Deaktivieren (enabled=false) eines gesetzlichen Topfes ist für Selbstzahler erlaubt", async () => {
      const customerId = await makeSelbstzahler();

      // Kein Throw — ein reiner Deaktivier-Payload muss immer durchgehen.
      await upsertBudgetTypeSettings(customerId, [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null },
      ]);

      const res = await apiGet<Array<{ budgetType: string; enabled: boolean }>>(
        `/api/budget/${customerId}/type-settings`,
      );
      expect(res.status).toBe(200);
      const row = res.data.find(r => r.budgetType === "entlastungsbetrag_45b");
      expect(row?.enabled).toBe(false);
    });

    it("Korrektur-/Seed-Escape allowStatutoryForSelbstzahler erlaubt das Seeden einer Altlast", async () => {
      const customerId = await makeSelbstzahler();

      await upsertBudgetTypeSettings(
        customerId,
        [{ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, validFrom: "2024-06-15" }],
        undefined,
        undefined,
        { allowStatutoryForSelbstzahler: true },
      );

      expect(await enabledRowCount(customerId, "entlastungsbetrag_45b")).toBeGreaterThanOrEqual(1);
    });

    it("Pflegekasse (gesetzlich) darf einen gesetzlichen Topf direkt über den Storage aktivieren", async () => {
      const c = await createTestCustomer({
        billingType: "pflegekasse_gesetzlich",
        pflegegrad: 3,
      });
      const customerId = c.id as number;
      createdIds.push(customerId);

      await upsertBudgetTypeSettings(customerId, [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      ]);

      expect(await enabledRowCount(customerId, "entlastungsbetrag_45b")).toBeGreaterThanOrEqual(1);
    });
  });
});
