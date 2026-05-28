import {
  budgetTransactions,
  type BudgetTransaction,
  type InsertBudgetTransaction,
} from "@shared/schema";
import { eq, and, desc, gte, lte, inArray, isNotNull } from "drizzle-orm";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../../lib/db";
import type { DbClient } from "./types";

export async function createBudgetTransaction(transaction: InsertBudgetTransaction, userId?: number): Promise<BudgetTransaction> {
  const result = await db.insert(budgetTransactions).values({
    ...transaction,
    createdByUserId: userId,
  }).returning();
  return result[0];
}

export async function getBudgetTransactions(customerId: number, options?: { year?: number; limit?: number; budgetType?: string }): Promise<BudgetTransaction[]> {
  const conditions = [eq(budgetTransactions.customerId, customerId)];

  if (options?.year) {
    const yearStart = `${options.year}-01-01`;
    const yearEnd = `${options.year}-12-31`;
    conditions.push(gte(budgetTransactions.transactionDate, yearStart));
    conditions.push(lte(budgetTransactions.transactionDate, yearEnd));
  }

  if (options?.budgetType) {
    conditions.push(eq(budgetTransactions.budgetType, options.budgetType));
  }

  let query = db.select()
    .from(budgetTransactions)
    .where(and(...conditions))
    .orderBy(desc(budgetTransactions.transactionDate), desc(budgetTransactions.createdAt));

  if (options?.limit) {
    query = query.limit(options.limit) as typeof query;
  }

  return await query;
}

export async function getTransactionByAppointmentId(appointmentId: number, _tx?: DbClient): Promise<BudgetTransaction | undefined> {
  const d = _tx ?? db;
  // Bestehende Consumption-Buchungen für diesen Termin laden. Stornierte
  // (reversed) Buchungen dürfen den Dup-Check NICHT mehr blockieren — sonst
  // scheitert das Re-Document nach Reopen+Korrektur (UI-Pfad: Termin-Detail
  // → „Zur Korrektur öffnen" → Wizard mit geänderter km/Service-Doku),
  // obwohl die Original-Buchung explizit zurückgenommen wurde.
  const consumptions = await d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption")
    ));
  if (consumptions.length === 0) return undefined;

  const ids = consumptions.map((c) => c.id);
  const reversals = await d.select({ rid: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.transactionType, "reversal"),
      isNotNull(budgetTransactions.reversedTransactionId),
      inArray(budgetTransactions.reversedTransactionId, ids),
    ));
  const reversedIds = new Set(
    reversals.map((r) => r.rid).filter((x): x is number => x != null),
  );
  return consumptions.find((c) => !reversedIds.has(c.id));
}

export async function getTransactionsByAppointmentId(appointmentId: number): Promise<BudgetTransaction[]> {
  return db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption")
    ));
}

export async function reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined> {
  const d = txClient ?? db;
  const original = await d.select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.id, transactionId))
    .limit(1);

  if (!original[0]) return undefined;

  const existingReversal = await d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.reversedTransactionId, transactionId),
      eq(budgetTransactions.transactionType, "reversal")
    ))
    .limit(1);

  if (existingReversal.length > 0) return existingReversal[0];

  // Task #754 (BUG-14 / BUG-10b) — Service-Cent-/Minuten-/km-Spalten der
  // Original-Consumption werden auf die Reversal-Tx GESPIEGELT und dabei
  // vorzeichen-invertiert, damit Σ je Termin/appointmentId für jede
  // Service-Spalte über {consumption + reversal} netto 0 ergibt — analog zur
  // bereits geltenden Konvention für `amountCents` (consumption negativ,
  // reversal positiv). Lexware-Export, §45b-Anzeige und Statistiken summieren
  // diese Spalten; ohne Spiegelung blieben sie auf dem Voll-Wert der
  // ursprünglichen Buchung hängen und der Termin würde nach Storno wie ein
  // vollständig gebuchter Termin aussehen. Drift-Detektor:
  // `tests/equality/storno-summe-null.test.ts`.
  const orig = original[0];
  const negate = (v: number | null | undefined) => (v == null ? null : -v);
  const reversal = await d.insert(budgetTransactions).values({
    customerId: orig.customerId,
    budgetType: orig.budgetType,
    transactionDate: todayISO(),
    transactionType: "reversal",
    amountCents: -orig.amountCents,
    appointmentId: orig.appointmentId,
    allocationId: orig.allocationId,
    reversedTransactionId: transactionId,
    hauswirtschaftMinutes: negate(orig.hauswirtschaftMinutes),
    hauswirtschaftCents: negate(orig.hauswirtschaftCents),
    alltagsbegleitungMinutes: negate(orig.alltagsbegleitungMinutes),
    alltagsbegleitungCents: negate(orig.alltagsbegleitungCents),
    travelKilometers: negate(orig.travelKilometers),
    travelCents: negate(orig.travelCents),
    customerKilometers: negate(orig.customerKilometers),
    customerKilometersCents: negate(orig.customerKilometersCents),
    notes: `Storno von Transaktion #${transactionId}`,
    createdByUserId: userId,
  }).onConflictDoNothing().returning();

  if (reversal.length === 0) {
    const existing = await d.select()
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.reversedTransactionId, transactionId),
        eq(budgetTransactions.transactionType, "reversal")
      ))
      .limit(1);
    return existing[0];
  }

  return reversal[0];
}
