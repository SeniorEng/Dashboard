import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations } from "@shared/schema";
import {
  createBudgetAllocation,
  upsertInitialBalanceAllocation,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import { SelbstzahlerStatutoryPotError } from "../../server/storage/budget/preferences-storage";
import { createTestCustomer, cleanupCustomer } from "../test-utils";

// Task #1234 — Invarianten-/Regressions-Test (Schwester zu Task #1233 auf dem
// type-settings-Pfad): Selbstzahler dürfen NIE Geld aus einem gesetzlichen
// Pflegekassen-Topf (§45b/§45a/§39+§42a) bekommen — auch nicht über die
// Allokations-/Startwert-Schreibpfade im Storage, die eine künftige Route oder
// ein Skript umgehen könnte.
//
// Gepinnt werden alle drei direkten Allokations-Writer:
//   1. upsertInitialBalanceAllocation (Startwert)
//   2. createBudgetAllocation         (roher Allocation-CRUD, z.B. Carryover-Zeile)
//   3. upsertCarryoverAllocation      (§45b-Restguthaben)
//
// In jedem Fall: Throw + KEINE persistierte Zeile. Der dokumentierte
// Korrektur-/Seed-Escape (`allowStatutoryForSelbstzahler`) bleibt funktionsfähig,
// und Pflegekasse-Kunden (anspruchsberechtigt) können weiterhin direkt seeden.

const STATUTORY_POTS = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

const CURRENT_YEAR = new Date().getFullYear();

async function allocationRowCount(customerId: number, budgetType: string): Promise<number> {
  const rows = await db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, budgetType),
      ),
    );
  return rows.length;
}

describe("Task #1234 — Selbstzahler dürfen keinen gesetzlichen Topf über den Allocation-Storage befüllen", () => {
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

  describe("upsertInitialBalanceAllocation (Startwert)", () => {
    for (const pot of STATUTORY_POTS) {
      it(`wirft beim direkten Seeden eines ${pot}-Startwerts für Selbstzahler und persistiert keine Zeile`, async () => {
        const customerId = await makeSelbstzahler();

        await expect(
          upsertInitialBalanceAllocation({
            customerId,
            budgetType: pot,
            year: CURRENT_YEAR,
            month: 3,
            amountCents: 10000,
            validFrom: `${CURRENT_YEAR}-03-01`,
            expiresAt: null,
            notes: "T1234-IB",
          }),
        ).rejects.toBeInstanceOf(SelbstzahlerStatutoryPotError);

        expect(await allocationRowCount(customerId, pot)).toBe(0);
      });
    }
  });

  describe("createBudgetAllocation (roher CRUD)", () => {
    for (const pot of STATUTORY_POTS) {
      it(`wirft beim direkten Anlegen einer ${pot}-Allokation für Selbstzahler und persistiert keine Zeile`, async () => {
        const customerId = await makeSelbstzahler();

        await expect(
          createBudgetAllocation({
            customerId,
            budgetType: pot,
            year: CURRENT_YEAR,
            month: null,
            amountCents: 5000,
            source: "manual_adjustment",
            validFrom: `${CURRENT_YEAR}-01-01`,
            expiresAt: null,
            notes: "T1234-CBA",
          }),
        ).rejects.toBeInstanceOf(SelbstzahlerStatutoryPotError);

        expect(await allocationRowCount(customerId, pot)).toBe(0);
      });
    }
  });

  describe("upsertCarryoverAllocation (§45b-Restguthaben)", () => {
    it("wirft beim direkten Anlegen eines §45b-Carryovers für Selbstzahler und persistiert keine Zeile", async () => {
      const customerId = await makeSelbstzahler();

      await expect(
        upsertCarryoverAllocation({
          customerId,
          budgetType: "entlastungsbetrag_45b",
          sourceYear: CURRENT_YEAR - 1,
          amountCents: 13100,
          notes: "T1234-CO",
        }),
      ).rejects.toBeInstanceOf(SelbstzahlerStatutoryPotError);

      expect(await allocationRowCount(customerId, "entlastungsbetrag_45b")).toBe(0);
    });
  });

  describe("erlaubte Pfade bleiben unberührt", () => {
    it("Korrektur-/Seed-Escape allowStatutoryForSelbstzahler erlaubt das Seeden einer Altlast", async () => {
      const customerId = await makeSelbstzahler();

      await upsertInitialBalanceAllocation(
        {
          customerId,
          budgetType: "entlastungsbetrag_45b",
          year: CURRENT_YEAR,
          month: 3,
          amountCents: 10000,
          validFrom: `${CURRENT_YEAR}-03-01`,
          expiresAt: null,
          notes: "T1234-IB-escape",
        },
        undefined,
        undefined,
        { allowStatutoryForSelbstzahler: true },
      );

      expect(
        await allocationRowCount(customerId, "entlastungsbetrag_45b"),
      ).toBeGreaterThanOrEqual(1);
    });

    it("Pflegekasse (gesetzlich) darf einen gesetzlichen Startwert direkt über den Storage anlegen", async () => {
      const c = await createTestCustomer({
        billingType: "pflegekasse_gesetzlich",
        pflegegrad: 3,
      });
      const customerId = c.id as number;
      createdIds.push(customerId);

      await upsertInitialBalanceAllocation({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: CURRENT_YEAR,
        month: 3,
        amountCents: 10000,
        validFrom: `${CURRENT_YEAR}-03-01`,
        expiresAt: null,
        notes: "T1234-IB-pflegekasse",
      });

      expect(
        await allocationRowCount(customerId, "entlastungsbetrag_45b"),
      ).toBeGreaterThanOrEqual(1);
    });

    it("Selbstzahler-Topf (nicht gesetzlich) bleibt über createBudgetAllocation erlaubt", async () => {
      const customerId = await makeSelbstzahler();

      const alloc = await createBudgetAllocation({
        customerId,
        budgetType: "selbstzahler",
        year: CURRENT_YEAR,
        month: null,
        amountCents: 5000,
        source: "manual_adjustment",
        validFrom: `${CURRENT_YEAR}-01-01`,
        expiresAt: null,
        notes: "T1234-CBA-selbstzahler",
      });

      expect(alloc.id).toBeGreaterThan(0);
      expect(await allocationRowCount(customerId, "selbstzahler")).toBeGreaterThanOrEqual(1);
    });
  });
});
