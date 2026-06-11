import {
  budgetTransactions,
  type BudgetTransaction,
  type InsertBudgetTransaction,
} from "@shared/schema";
import { eq, and, desc, gte, lte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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

export async function getTransactionsByAppointmentId(appointmentId: number, txClient?: DbClient): Promise<BudgetTransaction[]> {
  const d = txClient ?? db;
  return d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, appointmentId),
      eq(budgetTransactions.transactionType, "consumption")
    ));
}

/**
 * Task #1170 — explizites Ergebnis des Storno-Pfades, damit der Route-Handler
 * den korrekten Statuscode liefern kann:
 *   - `created`         — neue Reversal-Zeile geschrieben (201).
 *   - `already_reversed`— Transaktion war bereits storniert; KEINE zweite Zeile
 *                         (Idempotenz, 409 statt fälschlich 201).
 *   - `not_reversible`  — Versuch, eine Reversal selbst zu stornieren (400,
 *                         `REVERSAL_NOT_REVERSIBLE`).
 *   - `not_found`       — Transaktion existiert nicht (404).
 */
export type ReverseTransactionOutcome =
  | { status: "created"; reversal: BudgetTransaction }
  | { status: "already_reversed"; reversal: BudgetTransaction }
  | { status: "not_reversible" }
  | { status: "not_found" };

/**
 * Storniert eine Budget-Transaktion und liefert ein strukturiertes Ergebnis.
 * Der dünne Wrapper `reverseBudgetTransaction` (Bestands-Signatur) leitet hier
 * durch und mappt auf `BudgetTransaction | undefined` für die Bulk-Aufrufer.
 */
export async function reverseBudgetTransactionWithOutcome(
  transactionId: number,
  userId?: number,
  txClient?: DbClient,
): Promise<ReverseTransactionOutcome> {
  const d = txClient ?? db;
  const original = await d.select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.id, transactionId))
    .limit(1);

  if (!original[0]) return { status: "not_found" };

  // Task #1170 (BUG-17) — Storno eines Stornos ablehnen. Eine Reversal-Zeile
  // darf nur eine `consumption`/`write_off` zurücknehmen, niemals eine andere
  // `reversal`. Sonst entstünde ohne Termin-Dokumentation Wieder-Verbrauch und
  // die drei Lesepfade (Σ Transaktionen / FIFO-Breakdown / Overview) drifteten
  // auseinander. Drift-Schutz: `tests/equality/45b-fifo-breakdown-consistency.test.ts`,
  // Bestands-Reparatur: `server/scripts/reconcile-reversal-chains.ts`.
  if (original[0].transactionType === "reversal") {
    return { status: "not_reversible" };
  }

  const existingReversal = await d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.reversedTransactionId, transactionId),
      eq(budgetTransactions.transactionType, "reversal")
    ))
    .limit(1);

  if (existingReversal.length > 0) return { status: "already_reversed", reversal: existingReversal[0] };

  // Task #987 — auch NOTE-basierte Waisen-Stornos (`reversed_transaction_id`
  // NULL) für DIESELBE Original-Buchung erkennen. Der Partial-Unique-Index
  // `budget_transactions_reversal_unique_idx` greift nur für GESETZTE Links und
  // übersieht Import-Waisen. Existiert bereits eine verwaiste Storno-Zeile, die
  // diese Original-Buchung referenziert ("Storno … von Transaktion #<id>"),
  // wäre ein zweites (reguläres) Storno die Phantom-Doppel-Gutschrift aus #987
  // — also stattdessen die bestehende Waise zurückgeben statt neu zu buchen.
  const orig0 = original[0];
  const orphanStorno = await d.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, orig0.customerId),
      eq(budgetTransactions.transactionType, "reversal"),
      isNull(budgetTransactions.reversedTransactionId),
      sql`${budgetTransactions.notes} ~ ${`Storno.*Transaktion #${transactionId}(\\D|$)`}`,
    ))
    .limit(1);

  if (orphanStorno.length > 0) return { status: "already_reversed", reversal: orphanStorno[0] };

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
  // Task #963 — Storno-Datum an die Originalbuchung koppeln. Eine Reversal-Zeile
  // MUSS dasselbe `transactionDate` wie die stornierte Consumption tragen, damit
  // sich Verbrauch + Storno in JEDEM Stichtagsfenster (`transactionDate <=
  // asOfDate`) zu null verrechnen — egal, wann das Storno ausgeführt wird.
  // Vorher (`todayISO()`) fiel die Gutschrift bei einem Storno NACH dem
  // Termindatum aus dem Fenster, der Topf wirkte überzogen und ein real
  // dokumentierbarer Termin wurde fälschlich hart geblockt (Anzeige-vs-Buchung-
  // Drift; Übersicht rechnet mit asOfDate=heute und sah das Storno korrekt).
  // Der reale Storno-Zeitpunkt bleibt über `created_at` erhalten. Die anderen
  // Reversal-Pfade (rebook-storage.ts, km-rebook.ts) erben das Original-Datum
  // bereits. Drift-Detektor: `tests/equality/storno-asofdate-window.test.ts`.
  const reversal = await d.insert(budgetTransactions).values({
    customerId: orig.customerId,
    budgetType: orig.budgetType,
    transactionDate: orig.transactionDate,
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
    return { status: "already_reversed", reversal: existing[0] };
  }

  return { status: "created", reversal: reversal[0] };
}

/**
 * Bestands-Signatur (Bulk-Aufrufer): liefert die Reversal-Zeile oder
 * `undefined`. `not_found` UND `not_reversible` werden zu `undefined` —
 * Bulk-Pfade (Termin-Storno, Rechnungs-Storno, Import-Reconcile) stornieren
 * ausschließlich `consumption`-Zeilen und treffen den Reversal-Guard daher nie;
 * der Guard bleibt ein zusätzliches Sicherheitsnetz. Der Statuscode-sensitive
 * Route-Handler nutzt stattdessen `reverseBudgetTransactionWithOutcome`.
 */
export async function reverseBudgetTransaction(transactionId: number, userId?: number, txClient?: DbClient): Promise<BudgetTransaction | undefined> {
  const outcome = await reverseBudgetTransactionWithOutcome(transactionId, userId, txClient);
  if (outcome.status === "created" || outcome.status === "already_reversed") return outcome.reversal;
  return undefined;
}
