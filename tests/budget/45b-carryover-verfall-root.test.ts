import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetAllocations, budgetTransactions, customerCareLevelHistory } from "@shared/schema";
import { createTestCustomer, cleanupCustomer } from "../test-utils";
import {
  syncCarryoverAndExpiry,
  calculateAllocatedCents,
  upsertCarryoverAllocation,
} from "../../server/storage/budget/allocation-storage";
import { upsertBudgetTypeSettings } from "../../server/storage/budget/preferences-storage";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";

// Task #1392 — §45b-Carryover-Verfall Root-Fix.
//
// Diese Suite sichert die ZWEI Bugfixes ab:
//   Bug 1 (Chaining): ein hereingerollter Übertrag (Quelljahr Y) darf NICHT
//     erneut in den Folgejahres-Übertrag wandern (würde rechtswidrig über den
//     30.06.(Y+1) hinaus überleben).
//   Bug 2 (Kopplung Startwert↔Übertrag): ein abgelaufener/staler Übertrag darf
//     einen gültigen Startwert nicht verdrängen; Übertrag + Startwert desselben
//     Quelljahrs zählen genau EINMAL.
//
// Alle Lese-Asserts gehen durch den EINEN Verfügbarkeits-SSoT
// (`readUnifiedBudgetAvailability`) bzw. `calculateAllocatedCents` — keine
// zweite Budget-Mathematik im Test.
//
// Property-Tests legen pro Run einen API-Customer an (~3–4s); auf
// budget_allocations liegt ein GoBD-Immutability-Trigger (kein DELETE), darum
// frischer Kunde statt Re-Seed. RUNS daher bewusst moderat (Spec: "30–50 mit
// Kommentar"). Seed=42 in tests/setup.ts pinnt die Reproduzierbarkeit.
const RUNS = 25;

const curYear = new Date().getFullYear();
// Stichtag im 1. Halbjahr ⇒ expiryFloorAnchorYear = ibFloorYear = curYear-1.
// So ist ein Startwert für (curYear-1) im gültigen Fenster, und ein Übertrag mit
// Zieljahr curYear (Quelljahr curYear-1) ist noch nicht verfallen.
const asOfDate = `${curYear}-04-15`;

// §45b-Anker weit in der Zukunft ⇒ KEINE Monatsaufstockung im Lesefenster.
// `allocatedCents` reflektiert dann ausschließlich Startwert + Übertrag, sodass
// die Supersession-Invarianten isoliert prüfbar sind (vgl. P4 in properties).
const FAR_FUTURE_PG_SINCE = "2099-01-01";

async function makeCustomer45b(pgSince: string): Promise<number> {
  const c = await createTestCustomer({
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
    pflegegradSeit: pgSince,
  });
  const id = c.id as number;
  await upsertBudgetTypeSettings(id, [
    {
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      monthlyLimitCents: null,
      yearlyLimitCents: null,
      validFrom: null,
      validTo: null,
    },
  ]);
  return id;
}

async function insertAllocation(row: {
  customerId: number;
  year: number;
  source: "initial_balance" | "carryover";
  amountCents: number;
  validFrom: string;
  expiresAt: string | null;
  month?: number | null;
}): Promise<void> {
  await db.insert(budgetAllocations).values({
    customerId: row.customerId,
    budgetType: "entlastungsbetrag_45b",
    year: row.year,
    month: row.month ?? null,
    amountCents: row.amountCents,
    source: row.source,
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    notes: `Test #1392 ${row.source} ${row.year}`,
  });
}

async function read45bAllocatedCents(customerId: number): Promise<number> {
  const result = await readUnifiedBudgetAvailability(customerId, asOfDate);
  return result.pots.entlastungsbetrag_45b.allocatedCents;
}

describe("§45b Carryover-Verfall Root-Fix (Task #1392)", () => {
  // ---- Bug 2, Invariante (b): Übertrag + Startwert desselben Quelljahrs ----
  // Ein GÜLTIGER Übertrag (Zieljahr curYear, Quelljahr curYear-1) kondensiert
  // bereits das Restguthaben aus curYear-1. Ein zusätzlicher Startwert für
  // curYear-1 (= dasselbe Quelljahr) wird per IB-Supersession herausgerechnet,
  // damit NICHT doppelt gezählt wird: allocated == nur der Übertrag.
  it("P1 — gültiger Übertrag + Startwert desselben Quelljahrs zählen genau EINMAL", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_00, max: 131_00 }),
        fc.integer({ min: 1_00, max: 131_00 }),
        async (carryoverCents, ibCents) => {
          const id = await makeCustomer45b(FAR_FUTURE_PG_SINCE);
          try {
            // Gültiger Übertrag: Zieljahr curYear, Fenster 01.01–30.06 curYear.
            await insertAllocation({
              customerId: id,
              year: curYear,
              source: "carryover",
              amountCents: carryoverCents,
              validFrom: `${curYear}-01-01`,
              expiresAt: `${curYear}-06-30`,
            });
            // Startwert für das Quelljahr curYear-1 (= year-1 des Übertrags).
            await insertAllocation({
              customerId: id,
              year: curYear - 1,
              source: "initial_balance",
              amountCents: ibCents,
              validFrom: `${curYear - 1}-01-01`,
              expiresAt: null,
              month: 1,
            });

            const allocated = await read45bAllocatedCents(id);
            // Genau EINMAL: nur der Übertrag, der Startwert ist superseded.
            expect(allocated).toBe(carryoverCents);
            // Explizit KEINE Doppelzählung.
            expect(allocated).not.toBe(carryoverCents + ibCents);
          } finally {
            await cleanupCustomer(id);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // ---- Bug 2, Invariante (a): abgelaufener Übertrag verdrängt keinen IB ----
  // Ein VERFALLENER Übertrag (Zieljahr curYear-1, Fenster bis 30.06 curYear-1,
  // < asOfDate) darf den gültigen Startwert für curYear-1 NICHT verdrängen und
  // selbst nichts mehr beitragen: allocated == nur der Startwert.
  it("P2 — abgelaufener Übertrag verdrängt keinen gültigen Startwert", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_00, max: 131_00 }),
        fc.integer({ min: 1_00, max: 131_00 }),
        async (expiredCarryoverCents, ibCents) => {
          const id = await makeCustomer45b(FAR_FUTURE_PG_SINCE);
          try {
            // Abgelaufener Übertrag: Zieljahr curYear-1, verfällt 30.06 curYear-1
            // (< asOfDate) ⇒ carryoverCounted == false.
            await insertAllocation({
              customerId: id,
              year: curYear - 1,
              source: "carryover",
              amountCents: expiredCarryoverCents,
              validFrom: `${curYear - 1}-01-01`,
              expiresAt: `${curYear - 1}-06-30`,
            });
            // Gültiger Startwert für curYear-1 (year >= ibFloorYear=curYear-1,
            // validFrom <= asOfDate) ⇒ darf NICHT verdrängt werden.
            await insertAllocation({
              customerId: id,
              year: curYear - 1,
              source: "initial_balance",
              amountCents: ibCents,
              validFrom: `${curYear - 1}-01-01`,
              expiresAt: null,
              month: 1,
            });

            const allocated = await read45bAllocatedCents(id);
            // Nur der gültige Startwert; abgelaufener Übertrag trägt 0 bei.
            expect(allocated).toBe(ibCents);
            expect(allocated).not.toBe(ibCents + expiredCarryoverCents);
          } finally {
            await cleanupCustomer(id);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // ---- Bug 1: kein Carryover-Chaining ----
  // Ein in curYear-1 hereingerollter Übertrag (Quelljahr curYear-2) darf NICHT
  // in den curYear-Übertrag weitergerollt werden. Der curYear-Übertrag enthält
  // ausschließlich das EIGENE Restguthaben von curYear-1 (Monatsaufstockung),
  // und der hereingerollte Übertrag verfällt per processExpiredCarryover.
  it("regressiert NICHT in Carryover-Chaining (Quelljahr-Y-Rest taucht nicht in Y+2 auf)", async () => {
    // Kein Pflegegrad-Anker ⇒ §45b-Anker fällt auf das Übertrags-validFrom
    // (curYear-1), damit ensureYearlyCarryover45b das Jahr curYear-1 überhaupt
    // verarbeitet (mit Pflege-Historie würde der Anker auf curYear gebodet).
    const id = await makeCustomer45b("2024-01-01");
    try {
      await db
        .delete(customerCareLevelHistory)
        .where(eq(customerCareLevelHistory.customerId, id));

      // Hereingerollter Übertrag in curYear-1 (Quelljahr curYear-2).
      const chainedCents = 88_00;
      await upsertCarryoverAllocation({
        customerId: id,
        budgetType: "entlastungsbetrag_45b",
        sourceYear: curYear - 2,
        amountCents: chainedCents,
      });

      // Eigenes Jahresguthaben curYear-1 = reine Monatsaufstockung (kein IB,
      // kein Verbrauch). Das ist der Betrag, der KORREKT weiterrollen darf.
      const ownYearCents = await calculateAllocatedCents(
        id,
        "entlastungsbetrag_45b",
        { year: curYear - 1 },
      );
      expect(ownYearCents).toBeGreaterThan(0);

      await syncCarryoverAndExpiry(id);

      // Der in curYear angelegte Übertrag enthält NUR das eigene Restguthaben,
      // NICHT den hereingerollten Betrag (kein Chaining).
      const newCarryovers = await db
        .select()
        .from(budgetAllocations)
        .where(
          and(
            eq(budgetAllocations.customerId, id),
            eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
            eq(budgetAllocations.source, "carryover"),
            eq(budgetAllocations.year, curYear),
            isNull(budgetAllocations.deletedAt),
          ),
        );
      expect(newCarryovers).toHaveLength(1);
      expect(newCarryovers[0].amountCents).toBe(ownYearCents);
      expect(newCarryovers[0].amountCents).not.toBe(ownYearCents + chainedCents);

      // Der hereingerollte Übertrag (curYear-1, bereits verfallen) wird als
      // write_off ausgebucht statt weitergerollt.
      const chainedRow = await db
        .select()
        .from(budgetAllocations)
        .where(
          and(
            eq(budgetAllocations.customerId, id),
            eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
            eq(budgetAllocations.source, "carryover"),
            eq(budgetAllocations.year, curYear - 1),
            isNull(budgetAllocations.deletedAt),
          ),
        );
      expect(chainedRow).toHaveLength(1);

      const writeOffs = await db
        .select()
        .from(budgetTransactions)
        .where(
          and(
            eq(budgetTransactions.customerId, id),
            eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
            eq(budgetTransactions.transactionType, "write_off"),
            eq(budgetTransactions.allocationId, chainedRow[0].id),
          ),
        );
      expect(writeOffs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupCustomer(id);
    }
  });
});
