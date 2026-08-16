// Task #1785 P4 — §45b-Kürzung: Superadmin-Korrektur EINER ausgestellten
// §45b-Rechnung, wenn die Pflegekasse weniger (Y) gezahlt hat als in Rechnung
// gestellt (X). Der §45b-Verbrauch des Monats wird auf den tatsächlich
// gezahlten Betrag Y reduziert; der Überhang (X−Y) wird in EINEN Ziel-Topf
// umgebucht (§45a / §39+§42a / privat). GoBD-konform als Storno + Neubuchung
// (append-only), Re-Rechnung über denselben `generateInvoiceCore`-Pfad.
//
// SSoT-Disziplin:
//   • „verfügbar?"     → readUnifiedBudgetAvailability / netAvailable45bAt
//   • „Storno?"        → stornoInvoiceCascade
//   • „Startwert?"     → upsertInitialBalanceAllocation (#1812 Re-Baseline)
//   • „Neu-Buchung?"   → rebookNetZeroAppointmentCore (planCascade)
//   • „Neu-Rechnung?"  → generateInvoiceCore (Invoice-per-Pot-Split)
// Es wird KEINE parallele Mathe eingeführt.

import { sql, eq, and, or, gt, inArray } from "drizzle-orm";
import { carryoverExpiresAtFor } from "@shared/domain/budget/expiry-45b";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import { badRequest, notFound } from "../lib/errors";
import { log } from "../lib/log";
import { formatEuroDE } from "@shared/utils/money";
import {
  appointments,
  budgetAllocations,
  qontoTransactions,
  paymentAdviceItems,
} from "@shared/schema";
import { getInvoice, getInvoiceLineItemsTx } from "../storage/billing-storage";
import { stornoInvoiceCascade } from "./invoice-storno";
import { generateInvoiceCore } from "./invoice-calc";
import { upsertInitialBalanceAllocation } from "../storage/budget/allocation-storage";
import { assertRebookAllowed } from "../storage/budget/rebook-guards";
import { appointmentsRepo, budgetAllocationsRepo } from "../repos";
import {
  rebookNetZeroAppointmentCore,
  type RebookPrivatePotOverride,
} from "../storage/budget/rebook-storage";
import { netAvailable45bAt } from "../storage/budget/net-available-45b";
import { schedulePdfPersistInBackground } from "./invoice-pdf-orchestrator";

const BUDGET_TYPE_45B = "entlastungsbetrag_45b";

/** Ziel-Topf, in den der §45b-Überhang (X−Y) umgebucht wird. */
export type Reduce45bTargetPot = "umwandlung_45a" | "ersatzpflege_39_42a" | "private";

export interface Reduce45bInvoiceParams {
  /** Die auszustellende (issued) §45b-Rechnung, die gekürzt wird. */
  readonly rootInvoiceId: number;
  /** Y — was die Kasse tatsächlich gezahlt hat (Integer-Cents, 0 < Y < X). */
  readonly paidCents: number;
  /** Ziel-Topf für den Überhang X−Y. */
  readonly targetPot: Reduce45bTargetPot;
  readonly actor: { userId: number; isSuperAdmin: boolean; ipAddress?: string };
  /** Test-Fault-Injection (durchgereicht an withAudit / generateInvoiceCore). */
  readonly testFaults?: Set<string>;
}

/**
 * Ergebnis der Kürzung. `reissue` und `warnings` werden bewusst SEPARAT vom
 * committeten Storno/Re-Baseline gemeldet: Tx#1 (Storno + §45b-Reset +
 * Neu-Buchung) ist committet, bevor die Re-Rechnung (eigener Audit-/PDF-Pfad)
 * läuft. Scheitert die Re-Rechnung, ist der Ledger bereits korrekt und der
 * Aufruf ist über `POST /billing/generate` (identischer Pfad) wiederholbar.
 */
export interface Reduce45bInvoiceResult {
  readonly customerId: number;
  readonly billingMonth: number;
  readonly billingYear: number;
  readonly paidCents: number;
  readonly invoiceGrossCents: number;
  readonly overflowCents: number;
  readonly targetPot: Reduce45bTargetPot;
  readonly rebooked45bCents: number;
  readonly storno: {
    readonly stornoInvoiceId: number;
    readonly stornoInvoiceNumber: string;
    readonly cascadeStornoIds: number[];
  };
  readonly reissue:
    | { readonly ok: true; readonly invoiceIds: number[]; readonly new45bInvoiceId: number | null; readonly message?: string }
    | { readonly ok: false; readonly error: string };
  readonly warnings: string[];
}

function lastDayOfMonthIso(year: number, month: number): string {
  // month ist 1-basiert; `new Date(Date.UTC(year, month, 0))` = letzter Tag des Monats.
  const d = new Date(Date.UTC(year, month, 0));
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Prüft (read-only), ob der stornierten §45b-Rechnung eine Qonto-Zahlung
 * zugeordnet war — entweder direkt (`qonto_transactions.matched_invoice_id`)
 * oder über eine Sammel-Avis-Position (`payment_advice_items.matched_invoice_id`).
 * Wir mutieren die Qonto-Zuordnung NICHT (konsistent zum normalen Storno-Fluss,
 * der gebundene Zahlungen ebenfalls unangetastet lässt) — die Re-Zuordnung nach
 * dem Versand der neuen Rechnung erfolgt manuell über den bestehenden
 * Qonto-Match-Pfad. Wir melden es lediglich als Warnung.
 */
async function hadBoundQontoPayment(rootInvoiceId: number): Promise<boolean> {
  const [direct] = await db
    .select({ id: qontoTransactions.id })
    .from(qontoTransactions)
    .where(eq(qontoTransactions.matchedInvoiceId, rootInvoiceId))
    .limit(1);
  if (direct) return true;

  const [avis] = await db
    .select({ id: paymentAdviceItems.id })
    .from(paymentAdviceItems)
    .where(eq(paymentAdviceItems.matchedInvoiceId, rootInvoiceId))
    .limit(1);
  return !!avis;
}

/**
 * Kürzt EINE ausgestellte §45b-Rechnung auf den tatsächlich gezahlten
 * Kassenbetrag und routet den Überhang in einen Ziel-Topf um.
 *
 * Ablauf:
 *   Tx#1 (committet, GoBD-append-only, KEIN Render in der Transaktion):
 *     1. Advisory-Lock auf den Kunden (serialisiert Budget-Buchungen).
 *     2. Storno-Kaskade der §45b-Rechnung (Storno-first ⇒ die betroffenen
 *        Termine sind danach nicht mehr „billed" und passieren den
 *        Rebook-Guard OHNE `allowIssuedInvoices`).
 *     3. §45b-Reset: Startwert des Monats = Y (#1812 Re-Baseline — ersetzt
 *        Akkumulation/Carryover ≤ Monat).
 *     4. Rebook-Guard prüfen, dann Termine in AUFSTEIGENDER Datumsreihenfolge
 *        neu buchen (FIFO-Verfügbarkeit wird je Termin as-of dessen Datum
 *        gelesen) mit auf {§45b, Ziel-Topf} beschränkter Cascade.
 *     5. Ledger-Assert: nach der Re-Buchung MUSS der nicht-gefloorte §45b-Saldo
 *        `allocated − consumedNet` (Monatsende, ohne Holds) exakt 0 sein.
 *   Post-Commit (wiederholbar):
 *     6. Storno-PDFs im Hintergrund persistieren.
 *     7. Re-Rechnung via `generateInvoiceCore` (Invoice-per-Pot-Split →
 *        §45b=Y + Ziel-Topf=X−Y). Fehler werden separat gemeldet, nicht geworfen.
 *     8. Qonto-Zahlungshinweis (read-only) für manuelle Re-Zuordnung.
 */
export async function reduceInvoice45bToPaidAmount(
  params: Reduce45bInvoiceParams,
): Promise<Reduce45bInvoiceResult> {
  const { rootInvoiceId, paidCents, targetPot, actor, testFaults } = params;

  // ── Preconditions (read-only) ────────────────────────────────────────────
  const invoice = await getInvoice(rootInvoiceId);
  if (!invoice) throw notFound("Rechnung nicht gefunden.");

  if (invoice.budgetType !== BUDGET_TYPE_45B) {
    throw badRequest("Die §45b-Kürzung ist nur für §45b-Rechnungen möglich.");
  }
  if (invoice.invoiceType === "stornorechnung") {
    throw badRequest("Eine Stornorechnung kann nicht gekürzt werden.");
  }
  if (invoice.status === "storniert" || invoice.status === "entwurf") {
    throw badRequest(
      "Nur eine ausgestellte (nicht stornierte, nicht im Entwurf befindliche) §45b-Rechnung kann gekürzt werden.",
    );
  }

  const invoiceGrossCents = invoice.grossAmountCents;
  if (!Number.isInteger(paidCents)) {
    throw badRequest("Der gezahlte Betrag muss in ganzen Cent angegeben werden.");
  }
  if (paidCents <= 0 || paidCents >= invoiceGrossCents) {
    throw badRequest(
      `Der gezahlte Betrag (${formatEuroDE(paidCents)}) muss größer als 0 und kleiner als der ` +
        `Rechnungsbetrag (${formatEuroDE(invoiceGrossCents)}) sein. Andernfalls ist keine Kürzung nötig.`,
    );
  }

  const customerId = invoice.customerId;
  const billingMonth = invoice.billingMonth;
  const billingYear = invoice.billingYear;
  const overflowCents = invoiceGrossCents - paidCents;
  const firstOfMonthIso = `${billingYear}-${String(billingMonth).padStart(2, "0")}-01`;
  // Frist aus der SSoT (Welle 2) statt Literal.
  const expiresAtIso = carryoverExpiresAtFor(billingYear + 1);
  const endOfMonthIso = lastDayOfMonthIso(billingYear, billingMonth);

  // Precondition: ein SPÄTERER §45b-Startwert (Monat > Abrechnungsmonat) würde
  // durch das #1812-Reset überschrieben/verfälscht → hart ablehnen.
  const laterStartwert = await budgetAllocationsRepo
    .selectColumnsFrom({ id: budgetAllocations.id })
    .where(
      and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, BUDGET_TYPE_45B),
        eq(budgetAllocations.source, "initial_balance"),
        budgetAllocationsRepo.activeOnly(),
        or(
          gt(budgetAllocations.year, billingYear),
          and(eq(budgetAllocations.year, billingYear), gt(budgetAllocations.month, billingMonth)),
        ),
      ),
    )
    .limit(1);
  if (laterStartwert.length > 0) {
    throw badRequest(
      "Es existiert bereits ein späterer §45b-Startwert. Eine Kürzung würde den Budget-Verlauf " +
        "verfälschen. Bitte zuerst die spätere Buchung prüfen.",
    );
  }

  // Ziel-Topf-Konfiguration für die beschränkte Cascade.
  const isPrivateTarget = targetPot === "private";
  const allowedPots = isPrivateTarget ? [BUDGET_TYPE_45B] : [BUDGET_TYPE_45B, targetPot];
  const privatePotOverride: RebookPrivatePotOverride | null = isPrivateTarget
    ? { statutoryExcluded: false, noteKind: "privatzahlung" }
    : null;

  // ── Tx#1: Storno + §45b-Reset + Neu-Buchung (committet, kein Render) ───────
  const tx1 = await withAudit(async (tx, audit) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`,
    );

    // (2) Storno-first: die §45b-Rechnung + Geschwister desselben Laufs stornieren.
    const storno = await stornoInvoiceCascade(tx, audit, {
      rootInvoiceId,
      cascadeRun: true,
      userId: actor.userId,
      ipAddress: actor.ipAddress,
      auditMetadataExtra: {
        reason: "§45b-Kürzung auf gezahlten Kassenbetrag",
        paidCents,
        invoiceGrossCents,
        overflowCents,
        targetPot,
        task: "#1785",
      },
    });

    // (3) §45b-Reset: Startwert des Monats = Y (#1812 Re-Baseline).
    await upsertInitialBalanceAllocation(
      {
        customerId,
        budgetType: BUDGET_TYPE_45B,
        year: billingYear,
        month: billingMonth,
        amountCents: paidCents,
        validFrom: firstOfMonthIso,
        expiresAt: expiresAtIso,
        notes: "§45b-Kürzung: Startwert = gezahlter Kassenbetrag (Task #1785)",
      },
      actor.userId,
      tx,
    );

    // Termine der stornierten §45b-Rechnung ermitteln.
    const lineItems = await getInvoiceLineItemsTx(tx, rootInvoiceId);
    const apptIds = Array.from(
      new Set(
        lineItems
          .map((li) => li.appointmentId)
          .filter((id): id is number => id != null),
      ),
    );
    if (apptIds.length === 0) {
      throw badRequest(
        "Die §45b-Rechnung enthält keine terminbezogenen Positionen; eine Kürzung ist nicht möglich.",
      );
    }

    // (4) Rebook-Guard (Storno-first ⇒ KEIN allowIssuedInvoices nötig).
    await assertRebookAllowed(
      apptIds,
      { userId: actor.userId, isSuperAdmin: actor.isSuperAdmin },
      tx,
    );

    // Termine in AUFSTEIGENDER Datumsreihenfolge neu buchen — die FIFO-
    // Verfügbarkeit wird je Termin as-of dessen Datum gelesen, daher muss die
    // Reihenfolge chronologisch sein, sonst driftet die Zuteilung.
    const apptRows = await appointmentsRepo
      .selectColumnsFrom({ id: appointments.id, date: appointments.date }, tx)
      .where(inArray(appointments.id, apptIds));
    const orderedApptIds = apptRows
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((r) => r.id);

    let rebooked45bCents = 0;
    for (const appointmentId of orderedApptIds) {
      const { rebooked, cascade } = await rebookNetZeroAppointmentCore(tx, {
        customerId,
        appointmentId,
        userId: actor.userId,
        overflowRestriction: { allowedPots },
        privatePotOverride,
      });
      if (rebooked && cascade) {
        for (const b of cascade.breakdown) {
          if (b.budgetType === BUDGET_TYPE_45B) rebooked45bCents += b.consumedCents;
        }
      }
    }

    // (5) Ledger-Assert: nach der Re-Buchung MUSS der nicht-gefloorte §45b-Saldo
    // (allocated − consumedNet, Monatsende, Holds ignoriert) exakt 0 sein.
    // Prüft NICHT „Σ === Y" (spröde), sondern die Ledger-Invariante direkt aus
    // der EINEN §45b-Verfügbarkeits-SSoT. ≠0 ⇒ weitere §45b-Buchungen im Monat
    // verhindern eine saubere Kürzung → laut abbrechen (Rollback).
    const comp = await netAvailable45bAt(
      customerId,
      endOfMonthIso,
      { projectFuture: false, holds: "ignore" },
      tx,
    );
    const rawNetCents = comp.allocatedCents - comp.consumedNetCents;
    if (Math.round(rawNetCents) !== 0) {
      throw badRequest(
        `§45b-Kürzung fehlgeschlagen: nach der Re-Buchung verbleibt eine §45b-Abweichung von ` +
          `${formatEuroDE(rawNetCents)} (erwartet 0). Es gibt vermutlich weitere §45b-Buchungen im ` +
          `Abrechnungsmonat, die eine saubere Kürzung auf den gezahlten Betrag verhindern.`,
      );
    }

    audit.record({
      userId: actor.userId,
      action: "invoice_45b_reduced",
      entityType: "invoice",
      entityId: rootInvoiceId,
      metadata: {
        paidCents,
        invoiceGrossCents,
        overflowCents,
        targetPot,
        billingMonth,
        billingYear,
        rebooked45bCents,
        stornoInvoiceId: storno.mainStornoInvoice.id,
        stornoInvoiceNumber: storno.mainStornoInvoiceNumber,
        cascadeStornoIds: storno.cascadeStornoIds,
        task: "#1785",
      },
      ipAddress: actor.ipAddress,
    });

    return {
      stornoInvoiceId: storno.mainStornoInvoice.id,
      stornoInvoiceNumber: storno.mainStornoInvoiceNumber,
      cascadeStornoIds: storno.cascadeStornoIds,
      rebooked45bCents,
    };
  }, { faults: testFaults });

  // ── Post-Commit (wiederholbar) ────────────────────────────────────────────
  // (6) Storno-PDFs im Hintergrund persistieren (kein Render in der Transaktion).
  schedulePdfPersistInBackground(tx1.stornoInvoiceId);
  for (const id of tx1.cascadeStornoIds) schedulePdfPersistInBackground(id);

  // (7) Re-Rechnung über denselben /generate-Pfad (Invoice-per-Pot-Split).
  let reissue: Reduce45bInvoiceResult["reissue"];
  try {
    const result = await generateInvoiceCore(
      { customerId, billingMonth, billingYear },
      { userId: actor.userId, ipAddress: actor.ipAddress, testFaults: testFaults ?? new Set<string>() },
    );
    const invoiceList = "splitInvoices" in result ? result.invoices : [result];
    const new45b = invoiceList.find((i) => i.budgetType === BUDGET_TYPE_45B) ?? null;
    reissue = {
      ok: true,
      invoiceIds: invoiceList.map((i) => i.id),
      new45bInvoiceId: new45b?.id ?? null,
      ...("splitInvoices" in result && result.message ? { message: result.message } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `Re-Rechnung nach §45b-Kürzung fehlgeschlagen (Kunde ${customerId}, ${billingMonth}/${billingYear}): ${message}`,
      "invoice-45b-reduction",
    );
    reissue = { ok: false, error: message };
  }

  // (8) Qonto-Zahlungshinweis (read-only, keine Mutation der Zuordnung).
  const warnings: string[] = [];
  if (await hadBoundQontoPayment(rootInvoiceId)) {
    warnings.push(
      "Der stornierten §45b-Rechnung war eine Qonto-Zahlung zugeordnet. Bitte ordnen Sie die " +
        "Zahlung nach dem Versand der neuen §45b-Rechnung erneut zu.",
    );
  }
  if (!reissue.ok) {
    warnings.push(
      "Die neue Rechnung konnte nicht automatisch erstellt werden. Der Budget-Verlauf ist bereits " +
        "korrigiert — bitte die Rechnung über die Abrechnung für diesen Monat erneut erzeugen.",
    );
  }

  return {
    customerId,
    billingMonth,
    billingYear,
    paidCents,
    invoiceGrossCents,
    overflowCents,
    targetPot,
    rebooked45bCents: tx1.rebooked45bCents,
    storno: {
      stornoInvoiceId: tx1.stornoInvoiceId,
      stornoInvoiceNumber: tx1.stornoInvoiceNumber,
      cascadeStornoIds: tx1.cascadeStornoIds,
    },
    reissue,
    warnings,
  };
}
