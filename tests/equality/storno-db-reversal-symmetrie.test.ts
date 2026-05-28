/**
 * Task #781 — DB-backed Storno-Symmetrie über den ECHTEN Reversal-Pfad.
 *
 * Die reine Property-Suite `tests/equality/storno-symmetrie.test.ts` beweist,
 * dass die Per-Topf-Split-Arithmetik (`shared/domain/budget-invoice-split.ts`)
 * bei Storno + identischer Neuanlage exakt aufgeht. Sie fasst aber NIE den
 * realen DB-Reversal-Pfad `reverseBudgetTransaction`
 * (`server/storage/budget/transaction-storage.ts`) an — genau die Funktion,
 * die `performStorno` (`server/routes/billing.ts`) für jeden Consumption-Tx
 * eines stornierten Rechnungs-Termins aufruft. Ein Regress dort (z. B. eine
 * vergessene Service-Spalte beim Negieren) würde durch die pure Suite
 * rutschen.
 *
 * Dieser Test spiegelt den Budget-Reversal-Teil von `performStorno` 1:1
 * (Consumption-Tx je `appointmentId` laden → `reverseBudgetTransaction`) gegen
 * den geseedeten Test-Server und prüft die Storno-Symmetrie auf Datenbank-
 * Ebene:
 *
 *   1. Multi-Topf-Konsumtion buchen (§45b knapp → Cascade nach §45a), inkl.
 *      Reise- UND Kunden-Kilometer, damit die travel-/customerKilometers-
 *      Spalten mit abgedeckt sind.
 *   2. Pre-Storno-Aggregat je (Topf, Allocation, Kunde) über JEDE
 *      `budget_transactions`-Spalte (alle Minuten-, Cent- und km-Service-
 *      Felder, nicht nur amountCents) snapshotten.
 *   3. Storno: alle Consumption-Tx des Termins via `reverseBudgetTransaction`
 *      zurückbuchen (= performStorno-Pfad).
 *   4. Identische Buchung neu anlegen.
 *
 * Invariante: Σ(consumption₁) + Σ(reversal) + Σ(consumption₂) muss je Topf,
 * Allocation und Kunde für JEDE Spalte exakt wieder dem Pre-Storno-Aggregat
 * entsprechen — denn reversal = −consumption₁ und consumption₂ = consumption₁.
 * Vergisst der Reversal-Pfad eine Spalte zu negieren, kippt das Aggregat.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions, type BudgetTransaction } from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { createConsumptionTransaction } from "../../server/storage/budget/consumption-engine";
import { budgetLedgerStorage } from "../../server/storage/budget-ledger";
import { apiPost, createTestCustomer, getAuthCookie, runCleanup } from "../test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

async function actorId(): Promise<number> {
  const rows = await db.execute(/* sql */ `SELECT id FROM users ORDER BY id ASC LIMIT 1`);
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  if (!r[0]) throw new Error("Kein User für Audit-Akteur verfügbar");
  return r[0].id;
}

const NUMERIC_COLUMNS = [
  "amountCents",
  "hauswirtschaftMinutes",
  "hauswirtschaftCents",
  "alltagsbegleitungMinutes",
  "alltagsbegleitungCents",
  "travelKilometers",
  "travelCents",
  "customerKilometers",
  "customerKilometersCents",
] as const;

type ColumnSums = Record<(typeof NUMERIC_COLUMNS)[number], number>;

function zeroSums(): ColumnSums {
  return Object.fromEntries(NUMERIC_COLUMNS.map((c) => [c, 0])) as ColumnSums;
}

function addInto(target: ColumnSums, tx: BudgetTransaction): void {
  for (const col of NUMERIC_COLUMNS) {
    target[col] += Number(tx[col] ?? 0) || 0;
  }
}

interface Aggregate {
  perCustomer: ColumnSums;
  perPot: Map<string, ColumnSums>;
  perAllocation: Map<number, ColumnSums>;
}

/**
 * Aggregiert die übergebenen Transaktionen je Kunde, je Topf (`budgetType`)
 * und je Allocation (`allocationId`) über alle numerischen Service-Spalten.
 */
function aggregate(txs: BudgetTransaction[]): Aggregate {
  const perCustomer = zeroSums();
  const perPot = new Map<string, ColumnSums>();
  const perAllocation = new Map<number, ColumnSums>();

  for (const tx of txs) {
    addInto(perCustomer, tx);

    const potKey = tx.budgetType;
    if (!perPot.has(potKey)) perPot.set(potKey, zeroSums());
    addInto(perPot.get(potKey)!, tx);

    const allocKey = tx.allocationId ?? -1;
    if (!perAllocation.has(allocKey)) perAllocation.set(allocKey, zeroSums());
    addInto(perAllocation.get(allocKey)!, tx);
  }

  return { perCustomer, perPot, perAllocation };
}

async function allTxs(customerId: number): Promise<BudgetTransaction[]> {
  return db.select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, customerId));
}

/**
 * Spiegelt den Budget-Reversal-Teil von `performStorno`
 * (server/routes/billing.ts, ~Zeile 1810): pro Termin alle Consumption-Tx
 * laden und über `reverseBudgetTransaction` (via budgetLedgerStorage)
 * zurückbuchen.
 */
async function performStornoReversal(appointmentId: number, userId: number): Promise<void> {
  const txs = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
  for (const t of txs) {
    await budgetLedgerStorage.reverseBudgetTransaction(t.id, userId);
  }
}

async function bookConsumption(customerId: number, appointmentId: number, userId: number) {
  const today = todayISO();
  return createConsumptionTransaction({
    customerId,
    appointmentId,
    transactionDate: today,
    hauswirtschaftMinutes: 240,
    alltagsbegleitungMinutes: 60,
    travelKilometers: 18,
    customerKilometers: 7,
    userId,
  });
}

function expectSumsEqual(actual: ColumnSums, expected: ColumnSums, label: string): void {
  for (const col of NUMERIC_COLUMNS) {
    expect(actual[col], `${label} — Spalte ${col}`).toBe(expected[col]);
  }
}

describe("Task #781 — DB-Reversal Storno-Symmetrie je Topf/Allocation/Kunde", () => {
  it("Cascade-Buchung (§45b → §45a) mit km: Storno + identische Neuanlage stellt jede Spalte je Topf/Allocation/Kunde wieder her", async () => {
    const c = await createTestCustomer({
      vorname: "T781-DB-Reversal",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    const customerId = c.id as number;
    const userId = await actorId();
    const today = todayISO();

    // §45b knapp → Cascade muss in §45a überlaufen (Multi-Topf-Konsumtion).
    await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 31840 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, yearlyLimitCents: null },
    ], undefined, userId);
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 4000,
      carryoverAmountCents: 0,
      budgetStartDate: today,
    });
    await apiPost<any>(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 31840,
      carryoverAmountCents: 0,
      budgetStartDate: today,
    });

    const [appt] = await db.insert(appointments).values({
      customerId, date: today, scheduledStart: "09:00", status: "completed",
      appointmentType: "Kundentermin", durationPromised: 300,
      createdByUserId: userId, assignedEmployeeId: userId,
    }).returning({ id: appointments.id });
    const appointmentId = appt.id;

    // 1) Multi-Topf-Buchung.
    await bookConsumption(customerId, appointmentId, userId);

    // Sicherstellen, dass es wirklich eine Cascade über >1 Topf ist und km
    // tatsächlich gebucht wurden — sonst wäre der Test wertlos.
    const afterBooking = await allTxs(customerId);
    const consumptions = afterBooking.filter((t) => t.transactionType === "consumption");
    const distinctPots = new Set(consumptions.map((t) => t.budgetType));
    expect(distinctPots.size, "Buchung muss über mehrere Töpfe kaskadieren").toBeGreaterThanOrEqual(2);
    const totalTravelKm = consumptions.reduce((s, t) => s + (Number(t.travelKilometers ?? 0) || 0), 0);
    const totalCustomerKm = consumptions.reduce((s, t) => s + (Number(t.customerKilometers ?? 0) || 0), 0);
    expect(totalTravelKm, "Reise-km müssen gebucht sein").toBeGreaterThan(0);
    expect(totalCustomerKm, "Kunden-km müssen gebucht sein").toBeGreaterThan(0);

    // 2) Pre-Storno-Aggregat snapshotten (nur die Erst-Buchung).
    const pre = aggregate(afterBooking);

    // 3) Storno über den echten Reversal-Pfad (performStorno-Budget-Teil).
    await performStornoReversal(appointmentId, userId);

    // 4) Identische Buchung neu anlegen (auf demselben Termin — getrennte
    //    Consumption-Tx, da die Vorgänger storniert sind).
    await bookConsumption(customerId, appointmentId, userId);

    // Invariante: Σ(consumption₁) + Σ(reversal) + Σ(consumption₂) == Σ(consumption₁)
    // je Topf, Allocation und Kunde, für JEDE Spalte.
    const finalTxs = await allTxs(customerId);
    const post = aggregate(finalTxs);

    // Kunde gesamt.
    expectSumsEqual(post.perCustomer, pre.perCustomer, "perCustomer");

    // Je Topf — exakt dieselben Topf-Keys vor/nach.
    expect([...post.perPot.keys()].sort()).toEqual([...pre.perPot.keys()].sort());
    for (const [pot, expected] of pre.perPot) {
      const actual = post.perPot.get(pot);
      expect(actual, `Topf ${pot} fehlt nach Storno+Neuanlage`).toBeDefined();
      expectSumsEqual(actual!, expected, `perPot[${pot}]`);
    }

    // Je Allocation — Re-Booking füllt nach Storno dieselben Allocations
    // in derselben FIFO-Reihenfolge wieder auf.
    expect([...post.perAllocation.keys()].sort((a, b) => a - b))
      .toEqual([...pre.perAllocation.keys()].sort((a, b) => a - b));
    for (const [alloc, expected] of pre.perAllocation) {
      const actual = post.perAllocation.get(alloc);
      expect(actual, `Allocation ${alloc} fehlt nach Storno+Neuanlage`).toBeDefined();
      expectSumsEqual(actual!, expected, `perAllocation[${alloc}]`);
    }
  }, 120_000);
});
