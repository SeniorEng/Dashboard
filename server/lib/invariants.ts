/**
 * Task #1237 (Phase 0.1) — Read-only Invarianten-Suite.
 *
 * Dieses Modul bündelt drei read-only Konsistenz-Checks über den Budget-Ledger,
 * die Termin-Buchungen und den Rechnungs-Nummernkreis. Es ist die gemeinsame
 * SSoT für den CI-Integrationstest UND den SuperAdmin-Report-Endpoint
 * (`GET /api/admin/invariants-report`).
 *
 * GARANTIEN:
 *  - NUR LESEN (ausschließlich SELECT). Keine Mutation, kein Auto-Fix.
 *  - WIRFT NICHT. Jeder Check liefert ein strukturiertes Ergebnis zurück; der
 *    Aufrufer entscheidet über die Reaktion (Test = assert, Endpoint = JSON).
 *  - Akzeptiert einen `DbOrTx`-Executor wie `budget-conservation.ts`, sodass die
 *    Checks gegen die DB ODER eine offene Transaktion laufen können.
 *
 * Jeder Check spiegelt die Transaktionstyp-Semantik der jeweiligen Reader exakt
 * wider (statt naiver `SUM === reader`-Vergleiche mit 0-Toleranz):
 *  - `manual_adjustment` erzeugt bewusst eine bekannte Schatten-Drift zwischen
 *    Ledger-Summe und Karten-Anzeige (Phase-6-Thema) und wird NICHT „übermalt".
 *  - `write_off` zählt in der Topf-/Allocation-Sicht als „used", NICHT in der
 *    Fenster-Cap-Sicht (Asymmetrie). Check 1 nutzt deshalb den bestehenden
 *    No-Overdraw-Verifier statt einer eigenen Cap-Mathematik.
 *  - §45b ist ein Jahrestopf mit Projektion; die FIFO-vs-Unified-Gleichheit
 *    wird über den bestehenden Reader geprüft, nicht nachgerechnet.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import {
  appointments,
  auditLog,
  budgetAllocations,
  budgetTransactions,
  invoices,
} from "@shared/schema";
import { checkBudgetConservation } from "./budget-conservation";
import { appointmentDocumentedAndSignedCondition } from "./appointment-signed";
import { readBudget45bFifoBreakdown } from "../storage/budget/fifo-breakdown";

// ---------------------------------------------------------------------------
// Check 1 — Budget-Ledger-Konsistenz pro (Kunde × Topf)
// ---------------------------------------------------------------------------

export interface ReversalChainViolation {
  reversalTransactionId: number;
  customerId: number;
  budgetType: string;
  reversedTransactionId: number | null;
  reason:
    | "unlinked"
    | "dangling"
    | "customer_mismatch"
    | "pot_mismatch"
    | "over_reversal";
  detail: string;
}

export interface FifoUnifiedViolation {
  customerId: number;
  field: "allocated" | "consumed" | "planned" | "available";
  potsSumCents: number;
  totalCents: number;
}

export interface BudgetLedgerConsistencyResult {
  ok: boolean;
  /** Layer 1 — No-Overdraw (wiederverwendeter Conservation-Verifier). */
  conservation: {
    checkedPairs: number;
    /** `${customerId}|${budgetType}` aller überzogenen Töpfe. */
    overdrawnKeys: string[];
    crossViolations: number;
    crossDetails: string[];
  };
  /** Layer 2 — Storno-Ketten-Integrität (neu; das was L1-Clamp verschluckt). */
  reversalChain: {
    checkedReversals: number;
    violations: ReversalChainViolation[];
  };
  /** Layer 3 — FIFO-Breakdown vs. Unified-Totals (Konstruktions-Stolperdraht). */
  fifoUnified: {
    checkedCustomers: number;
    violations: FifoUnifiedViolation[];
  };
  violationCount: number;
}

/**
 * Storno-Ketten-Integrität: `budget_transactions.reversedTransactionId` hat
 * KEINEN FK. Jede `reversal`-Zeile MUSS daher auf eine existierende Original-
 * Transaktion DESSELBEN Kunden + Topfes zeigen und darf den Originalbetrag nicht
 * überschreiten. Der partielle Unique-Index begrenzt bereits ≤1 Storno pro
 * Original; eine einzelne Über-Stornierung (|reversal| > |original|) bleibt aber
 * möglich und wird vom L1-Clamp (`Math.max(0, …)`) verschluckt — hier sichtbar.
 */
async function checkReversalChains(
  exec: DbOrTx,
): Promise<{ checked: number; violations: ReversalChainViolation[] }> {
  const reversals = await exec
    .select({
      id: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.transactionType, "reversal"));

  const refIds = Array.from(
    new Set(
      reversals
        .map((r) => r.reversedTransactionId)
        .filter((x): x is number => x !== null),
    ),
  );

  const originals = refIds.length
    ? await exec
        .select({
          id: budgetTransactions.id,
          customerId: budgetTransactions.customerId,
          budgetType: budgetTransactions.budgetType,
          amountCents: budgetTransactions.amountCents,
        })
        .from(budgetTransactions)
        .where(inArray(budgetTransactions.id, refIds))
    : [];
  const origMap = new Map(originals.map((o) => [o.id, o]));

  const violations: ReversalChainViolation[] = [];
  for (const r of reversals) {
    const base = {
      reversalTransactionId: r.id,
      customerId: r.customerId,
      budgetType: r.budgetType,
      reversedTransactionId: r.reversedTransactionId,
    };
    if (r.reversedTransactionId === null) {
      violations.push({
        ...base,
        reason: "unlinked",
        detail: `Storno #${r.id} hat keine reversedTransactionId (unverknüpft)`,
      });
      continue;
    }
    const orig = origMap.get(r.reversedTransactionId);
    if (!orig) {
      violations.push({
        ...base,
        reason: "dangling",
        detail: `Storno #${r.id} verweist auf nicht existierende Transaktion #${r.reversedTransactionId}`,
      });
      continue;
    }
    if (orig.customerId !== r.customerId) {
      violations.push({
        ...base,
        reason: "customer_mismatch",
        detail: `Storno #${r.id} (Kunde ${r.customerId}) storniert Transaktion #${orig.id} eines anderen Kunden ${orig.customerId}`,
      });
      continue;
    }
    if (orig.budgetType !== r.budgetType) {
      violations.push({
        ...base,
        reason: "pot_mismatch",
        detail: `Storno #${r.id} (Topf ${r.budgetType}) storniert Transaktion #${orig.id} aus Topf ${orig.budgetType}`,
      });
      continue;
    }
    if (Math.abs(r.amountCents) > Math.abs(orig.amountCents)) {
      violations.push({
        ...base,
        reason: "over_reversal",
        detail: `Storno #${r.id} storniert ${Math.abs(r.amountCents)} Cent, Original #${orig.id} hat nur ${Math.abs(orig.amountCents)} Cent`,
      });
    }
  }

  return { checked: reversals.length, violations };
}

/**
 * FIFO-Breakdown muss zu den Unified-Totals summieren (Σ pots === Totals). Das
 * ist heute konstruktiv erfüllt (der Breakdown leitet seine Totals aus dem
 * Unified-Reader ab) — der Check bleibt als billiger Regressions-Stolperdraht
 * gegen künftige Änderungen am Breakdown-Splitting bestehen.
 */
async function checkFifoUnifiedEquality(
  exec: DbOrTx,
): Promise<{ checked: number; violations: FifoUnifiedViolation[] }> {
  const customers = await exec
    .select({ customerId: budgetAllocations.customerId })
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        isNull(budgetAllocations.deletedAt),
      ),
    )
    .groupBy(budgetAllocations.customerId);

  const violations: FifoUnifiedViolation[] = [];
  for (const c of customers) {
    const b = await readBudget45bFifoBreakdown(c.customerId);
    const sums = {
      allocated: b.pots.reduce((s, p) => s + p.allocatedCents, 0),
      consumed: b.pots.reduce((s, p) => s + p.consumedCents, 0),
      planned: b.pots.reduce((s, p) => s + p.plannedCents, 0),
      available: b.pots.reduce((s, p) => s + p.remainingCents, 0),
    };
    const totals = {
      allocated: b.totalAllocatedCents,
      consumed: b.totalConsumedCents,
      planned: b.totalPlannedCents,
      available: b.totalAvailableCents,
    };
    (["allocated", "consumed", "planned", "available"] as const).forEach(
      (field) => {
        if (sums[field] !== totals[field]) {
          violations.push({
            customerId: c.customerId,
            field,
            potsSumCents: sums[field],
            totalCents: totals[field],
          });
        }
      },
    );
  }

  return { checked: customers.length, violations };
}

export async function checkBudgetLedgerConsistency(
  exec: DbOrTx,
): Promise<BudgetLedgerConsistencyResult> {
  const conservation = await checkBudgetConservation(exec);
  const reversal = await checkReversalChains(exec);
  const fifo = await checkFifoUnifiedEquality(exec);

  const violationCount =
    conservation.potViolationKeys.length +
    conservation.crossViolations +
    reversal.violations.length +
    fifo.violations.length;

  return {
    ok: violationCount === 0,
    conservation: {
      checkedPairs: conservation.checkedPairs,
      overdrawnKeys: conservation.potViolationKeys,
      crossViolations: conservation.crossViolations,
      crossDetails: conservation.crossDetails,
    },
    reversalChain: {
      checkedReversals: reversal.checked,
      violations: reversal.violations,
    },
    fifoUnified: {
      checkedCustomers: fifo.checked,
      violations: fifo.violations,
    },
    violationCount,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — Buchungs-Vollständigkeit pro Termin
// ---------------------------------------------------------------------------

export interface LegSumViolation {
  transactionId: number;
  customerId: number;
  budgetType: string;
  amountCents: number;
  legSumCents: number;
}

export interface OverReversedAppointmentViolation {
  customerId: number;
  appointmentId: number;
  consumedCents: number;
  reversedCents: number;
}

export interface OrphanConsumptionViolation {
  transactionId: number;
  customerId: number;
  budgetType: string;
  amountCents: number;
}

export interface BookingCompletenessResult {
  ok: boolean;
  /** HARD — Σ(Bein-Cents) ≠ |amountCents| obwohl mindestens ein Bein gesetzt. */
  legSumMismatches: LegSumViolation[];
  /** HARD — pro Termin netto storniert mehr als konsumiert (Netto < 0). */
  overReversedAppointments: OverReversedAppointmentViolation[];
  /** HARD — consumption ohne Termin UND ohne Import-Batch (verwaiste Buchung). */
  orphanConsumptions: OrphanConsumptionViolation[];
  warnings: {
    /** SOFT — dokumentiert & unterschrieben, aber ohne Netto-Buchung. */
    documentedWithoutBooking: Array<{ customerId: number; appointmentId: number }>;
  };
  violationCount: number;
}

export async function checkBookingCompleteness(
  exec: DbOrTx,
): Promise<BookingCompletenessResult> {
  // (a) Bein-Summen-Integrität: das Subtract-last-Pattern der Consumption-Engine
  // garantiert Σ(legs) === |amount|, sobald mindestens ein Bein gesetzt ist.
  const legSumRows = await exec
    .select({
      transactionId: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
      legSumCents: sql<number>`(COALESCE(${budgetTransactions.hauswirtschaftCents}, 0) + COALESCE(${budgetTransactions.alltagsbegleitungCents}, 0) + COALESCE(${budgetTransactions.travelCents}, 0) + COALESCE(${budgetTransactions.customerKilometersCents}, 0))::int`,
    })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.transactionType, "consumption"),
        sql`(${budgetTransactions.hauswirtschaftCents} IS NOT NULL OR ${budgetTransactions.alltagsbegleitungCents} IS NOT NULL OR ${budgetTransactions.travelCents} IS NOT NULL OR ${budgetTransactions.customerKilometersCents} IS NOT NULL)`,
        sql`(COALESCE(${budgetTransactions.hauswirtschaftCents}, 0) + COALESCE(${budgetTransactions.alltagsbegleitungCents}, 0) + COALESCE(${budgetTransactions.travelCents}, 0) + COALESCE(${budgetTransactions.customerKilometersCents}, 0)) <> ABS(${budgetTransactions.amountCents})`,
      ),
    );
  const legSumMismatches: LegSumViolation[] = legSumRows.map((r) => ({
    transactionId: r.transactionId,
    customerId: r.customerId,
    budgetType: r.budgetType,
    amountCents: r.amountCents,
    legSumCents: Number(r.legSumCents),
  }));

  // (b) Netto-Buchung pro Termin ≥ 0: Stornos dürfen den Konsum eines Termins
  // nicht ins Negative ziehen. Über alle Töpfe des Termins aggregiert.
  const perAppt = await exec
    .select({
      customerId: budgetTransactions.customerId,
      appointmentId: budgetTransactions.appointmentId,
      consumedCents: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} = 'consumption'), 0)::int`,
      reversedCents: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} = 'reversal'), 0)::int`,
    })
    .from(budgetTransactions)
    .where(sql`${budgetTransactions.appointmentId} IS NOT NULL`)
    .groupBy(budgetTransactions.customerId, budgetTransactions.appointmentId);
  const overReversedAppointments: OverReversedAppointmentViolation[] = perAppt
    .filter((r) => Number(r.reversedCents) > Number(r.consumedCents))
    .map((r) => ({
      customerId: r.customerId,
      appointmentId: r.appointmentId as number,
      consumedCents: Number(r.consumedCents),
      reversedCents: Number(r.reversedCents),
    }));

  // (c) Verwaiste Consumption: kein Termin UND kein Import-Batch. Reguläre
  // Cascade-Folgetöpfe tragen denselben appointmentId; legitime termin-lose
  // Buchungen stammen ausschließlich aus Importen (importBatchId gesetzt).
  const orphanRows = await exec
    .select({
      transactionId: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.transactionType, "consumption"),
        isNull(budgetTransactions.appointmentId),
        isNull(budgetTransactions.importBatchId),
      ),
    );
  const orphanConsumptions: OrphanConsumptionViolation[] = orphanRows.map(
    (r) => ({
      transactionId: r.transactionId,
      customerId: r.customerId,
      budgetType: r.budgetType,
      amountCents: r.amountCents,
    }),
  );

  // SOFT — dokumentiert & unterschrieben (SSoT-Prädikat), aber ohne jegliche
  // Netto-Consumption gebucht. Kann legitim sein (No-Show, vollständig
  // storniert) — daher nur Warnung, kein CI-Bruch.
  const documentedUnbooked = await exec
    .select({
      customerId: appointments.customerId,
      appointmentId: appointments.id,
    })
    .from(appointments)
    .where(
      and(
        isNull(appointments.deletedAt),
        appointmentDocumentedAndSignedCondition(),
        sql`NOT EXISTS (SELECT 1 FROM ${budgetTransactions} bt WHERE bt.appointment_id = ${appointments.id} AND bt.transaction_type = 'consumption')`,
      ),
    );
  const documentedWithoutBooking = documentedUnbooked
    .filter(
      (r): r is { customerId: number; appointmentId: number } =>
        r.customerId !== null,
    )
    .map((r) => ({
      customerId: r.customerId,
      appointmentId: r.appointmentId,
    }));

  const violationCount =
    legSumMismatches.length +
    overReversedAppointments.length +
    orphanConsumptions.length;

  return {
    ok: violationCount === 0,
    legSumMismatches,
    overReversedAppointments,
    orphanConsumptions,
    warnings: { documentedWithoutBooking },
    violationCount,
  };
}

// ---------------------------------------------------------------------------
// Check 3 — Rechnungs-Nummernkreis-Integrität pro Abrechnungsjahr
// ---------------------------------------------------------------------------

export interface InvoiceDuplicateViolation {
  invoiceNumber: string;
  count: number;
}

export interface InvoiceGapViolation {
  billingYear: number;
  missingNumber: string;
}

export interface StornoMissingViolation {
  invoiceId: number;
  invoiceNumber: string;
  billingYear: number;
}

export interface InvoiceNumberIntegrityResult {
  ok: boolean;
  years: Array<{
    billingYear: number;
    maxSeq: number;
    presentCount: number;
    discardedCount: number;
  }>;
  duplicates: InvoiceDuplicateViolation[];
  gaps: InvoiceGapViolation[];
  stornoMissing: StornoMissingViolation[];
  violationCount: number;
}

const INVOICE_NUMBER_RE = /^RE-(\d{4})-(\d+)$/;

export async function checkInvoiceNumberIntegrity(
  exec: DbOrTx,
): Promise<InvoiceNumberIntegrityResult> {
  const invoiceRows = await exec
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceType: invoices.invoiceType,
      status: invoices.status,
      billingYear: invoices.billingYear,
      stornierteRechnungId: invoices.stornierteRechnungId,
    })
    .from(invoices);

  // Verworfene Entwürfe hinterlassen bewusste, audit-geloggte Lücken.
  const discardedRows = await exec
    .select({
      invoiceNumber: sql<string | null>`${auditLog.metadata}->>'invoiceNumber'`,
    })
    .from(auditLog)
    .where(eq(auditLog.action, "invoice_draft_discarded"));

  // Duplikate (near-structural via Unique-Constraint, defensiv geprüft).
  const numberCounts = new Map<string, number>();
  for (const inv of invoiceRows) {
    numberCounts.set(
      inv.invoiceNumber,
      (numberCounts.get(inv.invoiceNumber) ?? 0) + 1,
    );
  }
  const duplicates: InvoiceDuplicateViolation[] = [];
  for (const [invoiceNumber, count] of numberCounts) {
    if (count > 1) duplicates.push({ invoiceNumber, count });
  }

  // Pro Jahr die vorhandenen + verworfenen Sequenznummern sammeln.
  const presentByYear = new Map<number, Set<number>>();
  const maxByYear = new Map<number, number>();
  for (const inv of invoiceRows) {
    const m = INVOICE_NUMBER_RE.exec(inv.invoiceNumber);
    if (!m) continue;
    const year = inv.billingYear;
    const seq = Number(m[2]);
    if (!presentByYear.has(year)) presentByYear.set(year, new Set());
    presentByYear.get(year)!.add(seq);
    maxByYear.set(year, Math.max(maxByYear.get(year) ?? 0, seq));
  }

  const discardedByYear = new Map<number, Set<number>>();
  for (const d of discardedRows) {
    if (!d.invoiceNumber) continue;
    const m = INVOICE_NUMBER_RE.exec(d.invoiceNumber);
    if (!m) continue;
    const year = Number(m[1]);
    const seq = Number(m[2]);
    if (!discardedByYear.has(year)) discardedByYear.set(year, new Set());
    discardedByYear.get(year)!.add(seq);
  }

  const years: InvoiceNumberIntegrityResult["years"] = [];
  const gaps: InvoiceGapViolation[] = [];
  for (const [year, present] of presentByYear) {
    const discarded = discardedByYear.get(year) ?? new Set<number>();
    const maxSeq = maxByYear.get(year) ?? 0;
    for (let n = 1; n <= maxSeq; n++) {
      if (!present.has(n) && !discarded.has(n)) {
        gaps.push({
          billingYear: year,
          missingNumber: `RE-${year}-${String(n).padStart(4, "0")}`,
        });
      }
    }
    years.push({
      billingYear: year,
      maxSeq,
      presentCount: present.size,
      discardedCount: discarded.size,
    });
  }

  // Storno-Vollständigkeit: jede stornierte Original-Rechnung braucht ≥1
  // Stornorechnung, die per stornierteRechnungId auf sie zeigt.
  const stornoTargets = new Set<number>();
  for (const inv of invoiceRows) {
    if (
      inv.invoiceType === "stornorechnung" &&
      inv.stornierteRechnungId !== null
    ) {
      stornoTargets.add(inv.stornierteRechnungId);
    }
  }
  const stornoMissing: StornoMissingViolation[] = invoiceRows
    .filter(
      (inv) =>
        inv.status === "storniert" &&
        inv.invoiceType !== "stornorechnung" &&
        !stornoTargets.has(inv.id),
    )
    .map((inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      billingYear: inv.billingYear,
    }));

  const violationCount =
    duplicates.length + gaps.length + stornoMissing.length;

  return {
    ok: violationCount === 0,
    years,
    duplicates,
    gaps,
    stornoMissing,
    violationCount,
  };
}

// ---------------------------------------------------------------------------
// Suite-Aggregat
// ---------------------------------------------------------------------------

export interface InvariantSuiteReport {
  ok: boolean;
  generatedAt: string;
  budgetLedger: BudgetLedgerConsistencyResult;
  bookingCompleteness: BookingCompletenessResult;
  invoiceNumbering: InvoiceNumberIntegrityResult;
  totalViolations: number;
}

export async function runInvariantSuite(
  exec: DbOrTx,
): Promise<InvariantSuiteReport> {
  const budgetLedger = await checkBudgetLedgerConsistency(exec);
  const bookingCompleteness = await checkBookingCompleteness(exec);
  const invoiceNumbering = await checkInvoiceNumberIntegrity(exec);

  const totalViolations =
    budgetLedger.violationCount +
    bookingCompleteness.violationCount +
    invoiceNumbering.violationCount;

  return {
    ok: totalViolations === 0,
    generatedAt: new Date().toISOString(),
    budgetLedger,
    bookingCompleteness,
    invoiceNumbering,
    totalViolations,
  };
}
