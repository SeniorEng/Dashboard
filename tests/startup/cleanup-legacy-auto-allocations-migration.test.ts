// Task #1409 — Integrationstest für die gegatete Migration
// `cleanup-legacy-auto-allocations-1409` (FK-Null-dann-Delete).
//
// Verifiziert über den UNVERÄNDERTEN Runner-Pfad (Guard, Ledger, Conservation-
// Pre-/Post-Check), dass die Migration:
//   1. aktive `monthly_auto`/`yearly_auto`-Allocation-Zeilen hart löscht (→ 0),
//   2. genau EINEN Ledger-Eintrag schreibt (exactly-once),
//   3. die referenzierenden GoBD-Buchungen NICHT löscht, sondern nur ihren
//      internen FK-Zeiger nullt (`allocation_id IS NULL`), alle übrigen
//      Buchungs-Felder unverändert (GoBD append-only),
//   4. die §45b-Verfügbarkeit invariant lässt (Conservation-Δ=0).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { cleanupLegacyAutoAllocations } from "../../server/startup/cleanup-legacy-auto-allocations-migration";
import { runGuardedBudgetMigration } from "../../server/startup/budget-migration-runner";
import { readUnifiedBudgetAvailability } from "../../server/storage/budget/unified-reader";
import { createTestCustomer, cleanupCustomer } from "../test-utils";

const MIGRATION_NAME = "cleanup-legacy-auto-allocations-1409";

// Ein gemeinsamer Anker (Monatsgrenzen-Falle vermeiden) — fester Mitte-Jahr-Tag.
const YEAR = new Date().getFullYear();
const ANCHOR = `${YEAR}-06-15`;
const YEAR_START = `${YEAR}-01-01`;

async function clearLedger(): Promise<void> {
  await db.execute(
    sql`DELETE FROM budget_migrations WHERE name = ${MIGRATION_NAME}`,
  );
}

let customerId: number;

beforeEach(async () => {
  await clearLedger();
  const customer = await createTestCustomer({ pflegegrad: 3 });
  customerId = customer.id as number;
});

afterEach(async () => {
  await clearLedger();
  await cleanupCustomer(customerId);
});

describe("cleanup-legacy-auto-allocations-1409 (Task #1409)", () => {
  it("nullt FK-Zeiger der GoBD-Buchungen und hard-löscht die Auto-Zeilen — Conservation-Δ=0", async () => {
    // --- Fixtures -----------------------------------------------------------
    // §45b aktiv + materialisierter Startwert (initial_balance) als reale
    // projizierte Allocation. Auto-Zeilen werden von den Readern ignoriert.
    await db.insert(customerBudgetTypeSettings).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      enabled: true,
      priority: 1,
      validFrom: YEAR_START,
    });
    const [initialBalance] = await db
      .insert(budgetAllocations)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: YEAR,
        month: 6,
        amountCents: 13100,
        source: "initial_balance",
        validFrom: `${YEAR}-06-01`,
      })
      .returning({ id: budgetAllocations.id });

    // Aktive Altlast-Auto-Zeilen, auf die GoBD-Buchungen zeigen.
    const [monthlyAuto] = await db
      .insert(budgetAllocations)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: YEAR,
        month: 6,
        amountCents: 13100,
        source: "monthly_auto",
        validFrom: YEAR_START,
      })
      .returning({ id: budgetAllocations.id });
    const [yearlyAuto] = await db
      .insert(budgetAllocations)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        year: YEAR,
        month: null,
        amountCents: 12500,
        source: "yearly_auto",
        validFrom: YEAR_START,
      })
      .returning({ id: budgetAllocations.id });

    // Referenzierende Buchungen (consumption + reversal), auf die Auto-Zeilen
    // verlinkt. Diese sind GoBD-immutable und dürfen NIE gelöscht werden.
    const [consumption1] = await db
      .insert(budgetTransactions)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: ANCHOR,
        transactionType: "consumption",
        amountCents: -5000,
        allocationId: monthlyAuto.id,
      })
      .returning({ id: budgetTransactions.id });
    const [consumption2] = await db
      .insert(budgetTransactions)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: ANCHOR,
        transactionType: "consumption",
        amountCents: -3000,
        allocationId: yearlyAuto.id,
      })
      .returning({ id: budgetTransactions.id });
    const [reversal1] = await db
      .insert(budgetTransactions)
      .values({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: ANCHOR,
        transactionType: "reversal",
        amountCents: 5000,
        allocationId: monthlyAuto.id,
        reversedTransactionId: consumption1.id,
      })
      .returning({ id: budgetTransactions.id });

    const refIds = [consumption1.id, consumption2.id, reversal1.id];

    // --- Baseline: §45b-Verfügbarkeit VOR der Migration ---------------------
    const before = await readUnifiedBudgetAvailability(customerId, ANCHOR);
    const before45b = before.pots.entlastungsbetrag_45b;

    // --- Migration über den unveränderten Runner-Pfad -----------------------
    const outcome = await runGuardedBudgetMigration({
      name: MIGRATION_NAME,
      migrate: cleanupLegacyAutoAllocations,
    });
    expect(outcome).toBe("applied");

    // (2) genau EIN Ledger-Eintrag.
    const ledger = await db.execute(
      sql`SELECT count(*)::int AS c FROM budget_migrations WHERE name = ${MIGRATION_NAME}`,
    );
    const ledgerRows = (ledger as { rows?: Array<{ c: number }> }).rows ?? [];
    expect(ledgerRows[0]?.c ?? 0).toBe(1);

    // (1) keine aktiven Auto-Zeilen mehr.
    const remainingAuto = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(
        and(
          eq(budgetAllocations.customerId, customerId),
          inArray(budgetAllocations.source, ["monthly_auto", "yearly_auto"]),
          isNull(budgetAllocations.deletedAt),
        ),
      );
    expect(remainingAuto.length).toBe(0);

    // initial_balance bleibt unangetastet.
    const ibStill = await db
      .select({ id: budgetAllocations.id })
      .from(budgetAllocations)
      .where(eq(budgetAllocations.id, initialBalance.id));
    expect(ibStill.length).toBe(1);

    // (3) referenzierende Buchungen existieren WEITERHIN, allocation_id genullt,
    //     übrige Felder unverändert.
    const afterTx = await db
      .select({
        id: budgetTransactions.id,
        allocationId: budgetTransactions.allocationId,
        transactionType: budgetTransactions.transactionType,
        amountCents: budgetTransactions.amountCents,
        transactionDate: budgetTransactions.transactionDate,
        reversedTransactionId: budgetTransactions.reversedTransactionId,
      })
      .from(budgetTransactions)
      .where(inArray(budgetTransactions.id, refIds))
      .orderBy(asc(budgetTransactions.id));
    expect(afterTx.length).toBe(3);
    for (const t of afterTx) {
      expect(t.allocationId).toBeNull();
    }
    const c1 = afterTx.find((t) => t.id === consumption1.id)!;
    expect(c1.amountCents).toBe(-5000);
    expect(c1.transactionType).toBe("consumption");
    expect(c1.transactionDate).toBe(ANCHOR);
    const r1 = afterTx.find((t) => t.id === reversal1.id)!;
    expect(r1.amountCents).toBe(5000);
    expect(r1.transactionType).toBe("reversal");
    expect(r1.reversedTransactionId).toBe(consumption1.id);

    // (4) §45b-Verfügbarkeit invariant (Conservation-Δ=0). Das Löschen der
    //     Auto-Zeilen + Nullen der FK ändert weder Allocation noch Netto-Konsum.
    const after = await readUnifiedBudgetAvailability(customerId, ANCHOR);
    const after45b = after.pots.entlastungsbetrag_45b;
    expect(after45b.availableCents).toBe(before45b.availableCents);
    expect(after45b.allocatedCents).toBe(before45b.allocatedCents);
    expect(after45b.consumedNetCents).toBe(before45b.consumedNetCents);
  });

  it("idempotent: ohne aktive Auto-Zeilen ist die Migration ein No-Op (changed=0)", async () => {
    const summary = await cleanupLegacyAutoAllocations(db as never);
    expect(summary.changed).toBe(0);
  });
});
