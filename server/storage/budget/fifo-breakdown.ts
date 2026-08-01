/**
 * Task #1129 — §45b FIFO-Aufschlüsselung (rein lesend, read-only Visualisierung).
 *
 * Liefert die §45b-Verfügbarkeit in der FIFO-Reihenfolge auf ZWEI Töpfe
 * aufgeschlüsselt:
 *   1. `carryover`     — Vorjahres-Übertrag (verfällt zum `carryoverExpiresAt`).
 *   2. `current_year`  — laufendes Jahr (monatlicher Auto-Anspruch + Startwert).
 *
 * Jeder Topf wird in seine Zustände zerlegt:
 *   consumed (billed + documented + other) · planned (aktive Hard-Holds) · free.
 *
 * WICHTIG — keine parallele Verfügbarkeits-Mathematik (Task #874 I1): Die
 * Summen A (allocated), C (consumedNet), H (holds) und V (available) kommen
 * AUSSCHLIESSLICH aus `readUnifiedBudgetAvailability` (dem EINEN Reader). Diese
 * Funktion verteilt diese Summen nur FIFO-konform auf die beiden Töpfe und
 * klassifiziert den Konsum nach Termin-Zustand. Es gilt per Konstruktion:
 *   Σ pots.allocatedCents === A,  Σ pots.consumedCents === C,
 *   Σ pots.remainingCents === V.
 * (`C` == Karten-`totalUsedCents` exakt, solange kein `manual_adjustment`
 *  existiert — die bekannte manual_adjustment-Schatten-Drift ist Phase-6-Thema
 *  und wird hier bewusst NICHT übermalt.)
 */
import { budgetAllocations, budgetTransactions, invoiceLineItems, invoices, appointments } from "@shared/schema";
import { and, eq, gte, lte, or, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { appointmentsRepo, budgetAllocationsRepo } from "../../repos";
import { todayISO } from "@shared/utils/datetime";
import { readUnifiedBudgetAvailability } from "./unified-reader";
import { activeInvoiceCondition } from "../../lib/appointment-invoiced";

export type Budget45bFifoPotType = "carryover" | "current_year";

export interface Budget45bFifoPot {
  potType: Budget45bFifoPotType;
  allocatedCents: number;
  consumedCents: number;
  consumedBilledCents: number;
  consumedDocumentedCents: number;
  consumedOtherCents: number;
  plannedCents: number;
  remainingCents: number;
}

export interface Budget45bFifoBreakdown {
  /** FIFO-Reihenfolge: Übertrag zuerst, dann laufendes Jahr. */
  pots: Budget45bFifoPot[];
  /** Verfallsdatum des frühesten Übertrags (null wenn kein Übertrag). */
  carryoverExpiresAt: string | null;
  /** Reconciliation-Summen (== unified Reader bzw. Karten-Zahlen). */
  totalAllocatedCents: number;
  totalConsumedCents: number;
  totalPlannedCents: number;
  totalAvailableCents: number;
}

type ConsumedStates = { billed: number; documented: number };

export async function readBudget45bFifoBreakdown(
  customerId: number,
  asOfDate: string = todayISO(),
): Promise<Budget45bFifoBreakdown> {
  // ---- 1) Summen aus dem EINEN Verfügbarkeits-Reader (SSoT) ----
  const unified = await readUnifiedBudgetAvailability(customerId, asOfDate);
  const pot = unified.pots.entlastungsbetrag_45b;
  const A = pot.allocatedCents;
  const C = pot.consumedNetCents;
  const H = pot.holdsActiveCents;
  const V = pot.availableCents;

  // ---- 2) Übertrags-Allocations (identischer Filter wie FIFO-Engine) ----
  const carryoverAllocations = await budgetAllocationsRepo
    .selectColumnsFrom({ id: budgetAllocations.id, amountCents: budgetAllocations.amountCents, expiresAt: budgetAllocations.expiresAt })
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      lte(budgetAllocations.validFrom, asOfDate),
      or(isNull(budgetAllocations.expiresAt), gte(budgetAllocations.expiresAt, asOfDate)),
    ));

  const carryoverIds = carryoverAllocations.map(a => a.id);
  const allocatedCarry = carryoverAllocations.reduce((s, a) => s + a.amountCents, 0);
  const carryoverExpiresAt = carryoverAllocations
    .map(a => a.expiresAt)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null;

  // ---- 3) Übertrags-Konsum (FIFO via allocation_id, per-Allocation gekappt) ----
  // availableCarry == getAvailableCarryoverCents(...) (gleiche Mathematik).
  let availableCarry = 0;
  if (carryoverIds.length > 0) {
    const [consumed, reversed] = await Promise.all([
      db.select({
        allocationId: budgetTransactions.allocationId,
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        inArray(budgetTransactions.allocationId, carryoverIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      )).groupBy(budgetTransactions.allocationId),
      db.select({
        allocationId: budgetTransactions.allocationId,
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        inArray(budgetTransactions.allocationId, carryoverIds),
        eq(budgetTransactions.transactionType, "reversal"),
      )).groupBy(budgetTransactions.allocationId),
    ]);
    const consumedMap = new Map(consumed.map(c => [c.allocationId, Number(c.total)]));
    const reversalMap = new Map(reversed.map(r => [r.allocationId, Number(r.total)]));
    for (const alloc of carryoverAllocations) {
      const used = consumedMap.get(alloc.id) ?? 0;
      const rev = reversalMap.get(alloc.id) ?? 0;
      availableCarry += Math.max(0, alloc.amountCents - Math.max(0, used - rev));
    }
  }

  // ---- 4) FIFO-Verteilung von Konsum / Holds / Frei auf beide Töpfe ----
  const consumedCarry = Math.max(0, allocatedCarry - availableCarry);
  const consumedCur = C - consumedCarry;

  const holdsCarry = Math.min(H, availableCarry);
  const holdsCur = H - holdsCarry;

  const freeCarry = Math.min(Math.max(0, availableCarry - holdsCarry), V);
  const freeCur = V - freeCarry;

  const allocatedCur = A - allocatedCarry;

  // ---- 5) Konsum nach Termin-Zustand zerlegen (billed / documented) ----
  const [billedSet, documentedSet] = await Promise.all([
    loadBilledAppointmentIds(customerId),
    loadDocumentedAppointmentIds(customerId),
  ]);

  const stateByPot = await classifyConsumedByState(customerId, asOfDate, new Set(carryoverIds), billedSet, documentedSet);

  const carryStates = splitConsumed(consumedCarry, stateByPot.carryover);
  const curStates = splitConsumed(consumedCur, stateByPot.current);

  const pots: Budget45bFifoPot[] = [
    {
      potType: "carryover",
      allocatedCents: allocatedCarry,
      consumedCents: consumedCarry,
      consumedBilledCents: carryStates.billed,
      consumedDocumentedCents: carryStates.documented,
      consumedOtherCents: carryStates.other,
      plannedCents: holdsCarry,
      remainingCents: freeCarry,
    },
    {
      potType: "current_year",
      allocatedCents: allocatedCur,
      consumedCents: consumedCur,
      consumedBilledCents: curStates.billed,
      consumedDocumentedCents: curStates.documented,
      consumedOtherCents: curStates.other,
      plannedCents: holdsCur,
      remainingCents: freeCur,
    },
  ];

  return {
    pots,
    carryoverExpiresAt,
    totalAllocatedCents: A,
    totalConsumedCents: C,
    totalPlannedCents: H,
    totalAvailableCents: V,
  };
}

function splitConsumed(consumedTotal: number, states: ConsumedStates): { billed: number; documented: number; other: number } {
  const billed = Math.max(0, states.billed);
  const documented = Math.max(0, states.documented);
  // `other` ist der ausgleichende Rest, damit billed + documented + other
  // IMMER exakt `consumedTotal` ergibt (write_off, Importe ohne Termin-Status …).
  const other = consumedTotal - billed - documented;
  return { billed, documented, other };
}

async function loadBilledAppointmentIds(customerId: number): Promise<Set<number>> {
  const rows = await db
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .where(and(
      // Kunden-Scope zusätzlich; „aktiv" kommt aus der SSoT
      // `activeInvoiceCondition` (server/lib/appointment-invoiced.ts).
      eq(invoices.customerId, customerId),
      activeInvoiceCondition(),
    ));
  return new Set(rows.map(r => r.appointmentId).filter((id): id is number => id !== null));
}

async function loadDocumentedAppointmentIds(customerId: number): Promise<Set<number>> {
  const rows = await appointmentsRepo
    .selectColumnsFrom({ id: appointments.id })
    .where(and(
      eq(appointments.customerId, customerId),
      isNull(appointments.deletedAt),
      eq(appointments.status, "completed"),
      sql`${appointments.signatureData} IS NOT NULL`,
    ));
  return new Set(rows.map(r => r.id));
}

async function classifyConsumedByState(
  customerId: number,
  asOfDate: string,
  carryoverIdSet: Set<number>,
  billedSet: Set<number>,
  documentedSet: Set<number>,
): Promise<{ carryover: ConsumedStates; current: ConsumedStates }> {
  const txns = await db
    .select({
      appointmentId: budgetTransactions.appointmentId,
      allocationId: budgetTransactions.allocationId,
      transactionType: budgetTransactions.transactionType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off', 'reversal')`,
      lte(budgetTransactions.transactionDate, asOfDate),
    ));

  const result = {
    carryover: { billed: 0, documented: 0 },
    current: { billed: 0, documented: 0 },
  };

  for (const t of txns) {
    const apptId = t.appointmentId;
    let state: keyof ConsumedStates | null = null;
    if (apptId !== null && billedSet.has(apptId)) state = "billed";
    else if (apptId !== null && documentedSet.has(apptId)) state = "documented";
    if (state === null) continue; // alles andere fließt in `other` (Rest)

    const potKey = t.allocationId !== null && carryoverIdSet.has(t.allocationId) ? "carryover" : "current";
    const signed = t.transactionType === "reversal" ? -Math.abs(t.amountCents) : Math.abs(t.amountCents);
    result[potKey][state] += signed;
  }

  return result;
}
