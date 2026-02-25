import { db } from "../server/lib/db";
import { budgetAllocations, budgetTransactions, customerBudgets, customerBudgetPreferences } from "../shared/schema/budget";
import { customers } from "../shared/schema/customers";
import { eq, sql } from "drizzle-orm";
import { budgetLedgerStorage } from "../server/storage/budget-ledger";
import * as fs from "fs";

const TEST_CUSTOMER_PREFIX = "__BUDGET_TEST__";
const RESULTS_FILE = "scripts/budget-test-reference.json";

interface TestResult {
  scenario: string;
  summary45b: any;
  summary45a: any;
  summary39_42a: any;
  timing_ms: number;
}

async function cleanup(customerIds: number[]) {
  for (const id of customerIds) {
    await db.delete(budgetTransactions).where(eq(budgetTransactions.customerId, id));
    await db.delete(budgetAllocations).where(eq(budgetAllocations.customerId, id));
    await db.delete(customerBudgets).where(eq(customerBudgets.customerId, id));
    await db.delete(customerBudgetPreferences).where(eq(customerBudgetPreferences.customerId, id));
    await db.delete(customers).where(eq(customers.id, id));
  }
}

async function createTestCustomer(suffix: string, pflegegrad: number = 3): Promise<number> {
  const [c] = await db.insert(customers).values({
    name: `${TEST_CUSTOMER_PREFIX} ${suffix}`,
    vorname: TEST_CUSTOMER_PREFIX,
    nachname: suffix,
    status: "aktiv",
    pflegegrad,
    address: "Teststr. 1, 12345 Teststadt",
    strasse: "Teststr. 1",
    plz: "12345",
    stadt: "Teststadt",
  }).returning();
  return c.id;
}

async function setupBudgetConfig(customerId: number, opts: {
  entlastungsbetrag45b?: number;
  pflegesachleistungen36?: number;
  verhinderungspflege39?: number;
  budgetStartDate?: string;
  monthlyLimitCents?: number | null;
}) {
  await db.insert(customerBudgets).values({
    customerId,
    entlastungsbetrag45b: opts.entlastungsbetrag45b ?? 13100,
    pflegesachleistungen36: opts.pflegesachleistungen36 ?? 59880,
    verhinderungspflege39: opts.verhinderungspflege39 ?? 353900,
    validFrom: opts.budgetStartDate ?? "2025-01-01",
  });

  await db.insert(customerBudgetPreferences).values({
    customerId,
    budgetStartDate: opts.budgetStartDate ?? "2025-01-01",
    monthlyLimitCents: opts.monthlyLimitCents ?? null,
  });
}

async function insertAllocation(customerId: number, data: {
  budgetType: string;
  year: number;
  month?: number | null;
  amountCents: number;
  source: string;
  validFrom: string;
  expiresAt?: string | null;
}): Promise<number> {
  const [a] = await db.insert(budgetAllocations).values({
    customerId,
    budgetType: data.budgetType,
    year: data.year,
    month: data.month ?? null,
    amountCents: data.amountCents,
    source: data.source,
    validFrom: data.validFrom,
    expiresAt: data.expiresAt ?? null,
  }).returning();
  return a.id;
}

async function insertTransaction(customerId: number, data: {
  budgetType: string;
  transactionDate: string;
  transactionType: string;
  amountCents: number;
  allocationId?: number | null;
  appointmentId?: number | null;
}) {
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: data.budgetType,
    transactionDate: data.transactionDate,
    transactionType: data.transactionType,
    amountCents: data.amountCents,
    allocationId: data.allocationId ?? null,
    appointmentId: data.appointmentId ?? null,
  });
}

async function getSummaries(customerId: number) {
  const start = performance.now();
  const result = await budgetLedgerStorage.getAllBudgetSummaries(customerId);
  const timing_ms = Math.round(performance.now() - start);
  return { ...result, timing_ms };
}

async function runScenario(name: string, fn: () => Promise<{ customerId: number }>): Promise<{ result: TestResult; customerId: number }> {
  console.log(`  Running: ${name}...`);
  const { customerId } = await fn();
  const { entlastungsbetrag45b, umwandlung45a, ersatzpflege39_42a, timing_ms } = await getSummaries(customerId);
  const result: TestResult = {
    scenario: name,
    summary45b: entlastungsbetrag45b,
    summary45a: umwandlung45a,
    summary39_42a: ersatzpflege39_42a,
    timing_ms,
  };
  console.log(`    45b: allocated=${entlastungsbetrag45b.totalAllocatedCents}, used=${entlastungsbetrag45b.totalUsedCents}, available=${entlastungsbetrag45b.availableCents}, carryover=${entlastungsbetrag45b.carryoverCents}`);
  console.log(`    45a: allocated=${umwandlung45a.currentMonthAllocatedCents}, used=${umwandlung45a.currentMonthUsedCents}, available=${umwandlung45a.currentMonthAvailableCents}`);
  console.log(`    39/42a: allocated=${ersatzpflege39_42a.currentYearAllocatedCents}, used=${ersatzpflege39_42a.currentYearUsedCents}, available=${ersatzpflege39_42a.currentYearAvailableCents}`);
  console.log(`    timing: ${timing_ms}ms`);
  return { result, customerId };
}

async function main() {
  console.log("=== Budget Summary Test Suite ===\n");
  const customerIds: number[] = [];
  const results: TestResult[] = [];

  try {
    // --- Scenario 1: New customer, first month, simple consumption ---
    const s1 = await runScenario("S01: Neuer Kunde, erster Monat, einfacher Verbrauch", async () => {
      const customerId = await createTestCustomer("S01");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-02-01" });
      const allocId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -5000, allocationId: allocId,
      });
      return { customerId };
    });
    results.push(s1.result);

    // --- Scenario 2: Multiple months filled, partial consumption ---
    const s2 = await runScenario("S02: Mehrere Monate aufgefüllt, Teilverbrauch", async () => {
      const customerId = await createTestCustomer("S02");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01" });
      const a1 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 1,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-01-01",
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-01-15",
        transactionType: "consumption", amountCents: -8000, allocationId: a1,
      });
      return { customerId };
    });
    results.push(s2.result);

    // --- Scenario 3: Exactly exhausted month (0€ remaining) ---
    const s3 = await runScenario("S03: Exakt aufgebrauchter Monat (0€ übrig)", async () => {
      const customerId = await createTestCustomer("S03");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-02-01" });
      const allocId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-05",
        transactionType: "consumption", amountCents: -8000, allocationId: allocId,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-20",
        transactionType: "consumption", amountCents: -5100, allocationId: allocId,
      });
      return { customerId };
    });
    results.push(s3.result);

    // --- Scenario 4: Carryover from previous year ---
    const s4 = await runScenario("S04: Vorjahresrest wird übertragen", async () => {
      const customerId = await createTestCustomer("S04");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2025-01-01" });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2025, month: null,
        amountCents: 50000, source: "carryover", validFrom: "2026-01-01",
        expiresAt: "2026-06-30",
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      return { customerId };
    });
    results.push(s4.result);

    // --- Scenario 5: Carryover expires June 30 ---
    const s5 = await runScenario("S05: Übertrag verfällt am 30.06.", async () => {
      const customerId = await createTestCustomer("S05");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2025-01-01" });
      const coId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2024, month: null,
        amountCents: 30000, source: "carryover", validFrom: "2025-01-01",
        expiresAt: "2025-06-30",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2025-06-30",
        transactionType: "write_off", amountCents: -30000, allocationId: coId,
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      return { customerId };
    });
    results.push(s5.result);

    // --- Scenario 6: Partially consumed carryover + expiry of rest ---
    const s6 = await runScenario("S06: Teilweise verbrauchter Übertrag + Verfall", async () => {
      const customerId = await createTestCustomer("S06");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2025-01-01" });
      const coId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2024, month: null,
        amountCents: 40000, source: "carryover", validFrom: "2025-01-01",
        expiresAt: "2025-06-30",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2025-03-15",
        transactionType: "consumption", amountCents: -15000, allocationId: coId,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2025-06-30",
        transactionType: "write_off", amountCents: -25000, allocationId: coId,
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      return { customerId };
    });
    results.push(s6.result);

    // --- Scenario 7: FIFO - oldest money consumed first ---
    const s7 = await runScenario("S07: FIFO - ältestes Geld zuerst verbraucht", async () => {
      const customerId = await createTestCustomer("S07");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01" });
      const a1 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 1,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-01-01",
      });
      const a2 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -13100, allocationId: a1,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-15",
        transactionType: "consumption", amountCents: -5000, allocationId: a2,
      });
      return { customerId };
    });
    results.push(s7.result);

    // --- Scenario 8: Consumption split across allocations ---
    const s8 = await runScenario("S08: Verbrauch über mehrere Allokationen (Splitting)", async () => {
      const customerId = await createTestCustomer("S08");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01" });
      const a1 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 1,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-01-01",
      });
      const a2 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -10000, allocationId: a1,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -8000, allocationId: a2,
      });
      return { customerId };
    });
    results.push(s8.result);

    // --- Scenario 9: 45a exhausted → cascade to 45b ---
    const s9 = await runScenario("S09: 45a aufgebraucht → fällt auf 45b", async () => {
      const customerId = await createTestCustomer("S09");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01", pflegesachleistungen36: 59880 });
      const a45a = await insertAllocation(customerId, {
        budgetType: "umwandlung_45a", year: 2026, month: 2,
        amountCents: 59880, source: "monthly_auto", validFrom: "2026-02-01",
        expiresAt: "2026-02-28",
      });
      const a45b = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "umwandlung_45a", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -59880, allocationId: a45a,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-15",
        transactionType: "consumption", amountCents: -5000, allocationId: a45b,
      });
      return { customerId };
    });
    results.push(s9.result);

    // --- Scenario 10: All 3 pots consumed sequentially ---
    const s10 = await runScenario("S10: Alle 3 Töpfe nacheinander verbraucht", async () => {
      const customerId = await createTestCustomer("S10");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, {
        budgetStartDate: "2026-01-01",
        pflegesachleistungen36: 59880,
        verhinderungspflege39: 353900,
      });
      const a45a = await insertAllocation(customerId, {
        budgetType: "umwandlung_45a", year: 2026, month: 2,
        amountCents: 59880, source: "monthly_auto", validFrom: "2026-02-01",
        expiresAt: "2026-02-28",
      });
      const a45b = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      const a39 = await insertAllocation(customerId, {
        budgetType: "ersatzpflege_39_42a", year: 2026, month: null,
        amountCents: 353900, source: "yearly_auto", validFrom: "2026-01-01",
        expiresAt: "2026-12-31",
      });
      await insertTransaction(customerId, {
        budgetType: "umwandlung_45a", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -59880, allocationId: a45a,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-12",
        transactionType: "consumption", amountCents: -13100, allocationId: a45b,
      });
      await insertTransaction(customerId, {
        budgetType: "ersatzpflege_39_42a", transactionDate: "2026-02-14",
        transactionType: "consumption", amountCents: -20000, allocationId: a39,
      });
      return { customerId };
    });
    results.push(s10.result);

    // --- Scenario 11: Empty month (no appointments) ---
    const s11 = await runScenario("S11: Leerer Monat (keine Termine)", async () => {
      const customerId = await createTestCustomer("S11");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01" });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 1,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-01-01",
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      return { customerId };
    });
    results.push(s11.result);

    // --- Scenario 12: Reversal restores budget ---
    const s12 = await runScenario("S12: Storno → Budget wieder verfügbar", async () => {
      const customerId = await createTestCustomer("S12");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-02-01" });
      const allocId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -7500, allocationId: allocId,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-12",
        transactionType: "reversal", amountCents: 7500, allocationId: allocId,
      });
      return { customerId };
    });
    results.push(s12.result);

    // --- Scenario 13: Manual adjustment ---
    const s13 = await runScenario("S13: Manual adjustment (positive + negative)", async () => {
      const customerId = await createTestCustomer("S13");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-02-01" });
      const allocId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-05",
        transactionType: "consumption", amountCents: -10000, allocationId: allocId,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "manual_adjustment", amountCents: -2000,
      });
      return { customerId };
    });
    results.push(s13.result);

    // --- Scenario 14: Monthly limit with carryover ---
    const s14 = await runScenario("S14: Monatslimit bei 45b mit Übertrag", async () => {
      const customerId = await createTestCustomer("S14");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, {
        budgetStartDate: "2025-01-01",
        monthlyLimitCents: 8000,
      });
      await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2025, month: null,
        amountCents: 30000, source: "carryover", validFrom: "2026-01-01",
        expiresAt: "2026-06-30",
      });
      const a2 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -6000, allocationId: a2,
      });
      return { customerId };
    });
    results.push(s14.result);

    // --- Scenario 15: 45a only current month matters ---
    const s15 = await runScenario("S15: 45a - nur aktueller Monat zählt", async () => {
      const customerId = await createTestCustomer("S15");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, {
        budgetStartDate: "2026-01-01",
        pflegesachleistungen36: 59880,
      });
      await insertAllocation(customerId, {
        budgetType: "umwandlung_45a", year: 2026, month: 1,
        amountCents: 59880, source: "monthly_auto", validFrom: "2026-01-01",
        expiresAt: "2026-01-31",
      });
      const a2 = await insertAllocation(customerId, {
        budgetType: "umwandlung_45a", year: 2026, month: 2,
        amountCents: 59880, source: "monthly_auto", validFrom: "2026-02-01",
        expiresAt: "2026-02-28",
      });
      await insertTransaction(customerId, {
        budgetType: "umwandlung_45a", transactionDate: "2026-02-15",
        transactionType: "consumption", amountCents: -20000, allocationId: a2,
      });
      return { customerId };
    });
    results.push(s15.result);

    // --- Scenario 16: 39/42a yearly budget partial use ---
    const s16 = await runScenario("S16: §39/42a Jahresbudget Teilverbrauch", async () => {
      const customerId = await createTestCustomer("S16");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, {
        budgetStartDate: "2026-01-01",
        verhinderungspflege39: 353900,
      });
      const aY = await insertAllocation(customerId, {
        budgetType: "ersatzpflege_39_42a", year: 2026, month: null,
        amountCents: 353900, source: "yearly_auto", validFrom: "2026-01-01",
        expiresAt: "2026-12-31",
      });
      await insertTransaction(customerId, {
        budgetType: "ersatzpflege_39_42a", transactionDate: "2026-01-15",
        transactionType: "consumption", amountCents: -100000, allocationId: aY,
      });
      await insertTransaction(customerId, {
        budgetType: "ersatzpflege_39_42a", transactionDate: "2026-02-20",
        transactionType: "consumption", amountCents: -50000, allocationId: aY,
      });
      return { customerId };
    });
    results.push(s16.result);

    // --- Scenario 17: Mixed transaction types ---
    const s17 = await runScenario("S17: Gemischte Transaktionstypen (consumption + write_off + reversal + manual)", async () => {
      const customerId = await createTestCustomer("S17");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2026-01-01" });
      const a1 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 1,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-01-01",
      });
      const a2 = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-01-10",
        transactionType: "consumption", amountCents: -8000, allocationId: a1,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-01-12",
        transactionType: "reversal", amountCents: 3000,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-05",
        transactionType: "consumption", amountCents: -4000, allocationId: a2,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "manual_adjustment", amountCents: -1500,
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-15",
        transactionType: "write_off", amountCents: -500,
      });
      return { customerId };
    });
    results.push(s17.result);

    // --- Scenario 18: Zero budget (PG1, no 45a) ---
    const s18 = await runScenario("S18: Pflegegrad 1 (keine 45a)", async () => {
      const customerId = await createTestCustomer("S18", 1);
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, {
        budgetStartDate: "2026-02-01",
        pflegesachleistungen36: 0,
        verhinderungspflege39: 0,
      });
      const allocId = await insertAllocation(customerId, {
        budgetType: "entlastungsbetrag_45b", year: 2026, month: 2,
        amountCents: 13100, source: "monthly_auto", validFrom: "2026-02-01",
      });
      await insertTransaction(customerId, {
        budgetType: "entlastungsbetrag_45b", transactionDate: "2026-02-10",
        transactionType: "consumption", amountCents: -3000, allocationId: allocId,
      });
      return { customerId };
    });
    results.push(s18.result);

    // --- Scenario 19: High volume (36 months × 20 transactions) ---
    const s19 = await runScenario("S19: Volumen-Test (36 Monate × 20 Buchungen = 720 Transaktionen)", async () => {
      const customerId = await createTestCustomer("S19");
      customerIds.push(customerId);
      await setupBudgetConfig(customerId, { budgetStartDate: "2024-01-01" });

      for (let monthOffset = 0; monthOffset < 36; monthOffset++) {
        const year = 2024 + Math.floor((monthOffset) / 12);
        const month = (monthOffset % 12) + 1;
        const validFrom = `${year}-${String(month).padStart(2, '0')}-01`;

        const allocId = await insertAllocation(customerId, {
          budgetType: "entlastungsbetrag_45b", year, month,
          amountCents: 13100, source: "monthly_auto", validFrom,
        });

        for (let t = 0; t < 20; t++) {
          const day = Math.min(1 + t, 28);
          const txDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          await insertTransaction(customerId, {
            budgetType: "entlastungsbetrag_45b", transactionDate: txDate,
            transactionType: "consumption", amountCents: -Math.round(13100 / 20),
            allocationId: allocId,
          });
        }
      }
      return { customerId };
    });
    results.push(s19.result);

    const isCompare = process.argv.includes("--compare");

    if (isCompare && fs.existsSync(RESULTS_FILE)) {
      const reference = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
      console.log(`\n=== VERGLEICH mit Referenz (${reference.version}) ===\n`);
      let totalDiffs = 0;

      for (let i = 0; i < results.length; i++) {
        const current = results[i];
        const ref = reference.scenarios[i];
        if (!ref) { console.log(`  ${current.scenario}: KEIN REFERENZWERT`); totalDiffs++; continue; }

        const diffs: string[] = [];
        for (const key of ["totalAllocatedCents", "totalUsedCents", "availableCents", "carryoverCents", "carryoverExpiresAt", "currentYearAllocatedCents", "monthlyLimitCents", "currentMonthUsedCents"] as const) {
          if (current.summary45b[key] !== ref.summary45b[key]) {
            diffs.push(`45b.${key}: ${ref.summary45b[key]} → ${current.summary45b[key]}`);
          }
        }
        for (const key of ["monthlyBudgetCents", "currentMonthAllocatedCents", "currentMonthUsedCents", "currentMonthAvailableCents"] as const) {
          if (current.summary45a[key] !== ref.summary45a[key]) {
            diffs.push(`45a.${key}: ${ref.summary45a[key]} → ${current.summary45a[key]}`);
          }
        }
        for (const key of ["yearlyBudgetCents", "currentYearAllocatedCents", "currentYearUsedCents", "currentYearAvailableCents"] as const) {
          if (current.summary39_42a[key] !== ref.summary39_42a[key]) {
            diffs.push(`39/42a.${key}: ${ref.summary39_42a[key]} → ${current.summary39_42a[key]}`);
          }
        }

        if (diffs.length > 0) {
          console.log(`  ✗ ${current.scenario}`);
          for (const d of diffs) console.log(`      ${d}`);
          totalDiffs += diffs.length;
        } else {
          const speedup = ref.timing_ms > 0 ? `(${ref.timing_ms}ms → ${current.timing_ms}ms)` : "";
          console.log(`  ✓ ${current.scenario} ${speedup}`);
        }
      }

      console.log(`\n${totalDiffs === 0 ? "✓ ALLE SZENARIEN IDENTISCH" : `✗ ${totalDiffs} ABWEICHUNGEN GEFUNDEN`}`);
    } else {
      const output = {
        generatedAt: new Date().toISOString(),
        version: "js-aggregation",
        scenarios: results,
      };
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));
      console.log(`\n✓ ${results.length} Szenarien durchgeführt`);
      console.log(`✓ Referenzdaten gespeichert in ${RESULTS_FILE}`);
    }

  } finally {
    console.log("\nBereinige Testdaten...");
    await cleanup(customerIds);
    console.log("✓ Testdaten bereinigt");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("FEHLER:", err);
  process.exit(1);
});
