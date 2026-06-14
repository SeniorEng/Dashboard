/**
 * Task #875 (Budget GF Phase 5) — Hard-hold reservation engine.
 *
 * Operative Holds (`budget_reservations`) reservieren Budget beim PLANEN eines
 * Termins, werden beim ABSCHLUSS in den Ledger (`budget_ledger`) gebucht
 * (captured) und bei Storno/Reschedule/Reopen freigegeben (released). Der ganze
 * Layer ist hinter dem Feature-Flag `BUDGET_HARD_HOLDS` gegated
 * (`hardHoldsEnabled()`): aus = es wird KEIN Hold geschrieben, der unified
 * Reader summiert 0 Holds → byte-identisches Legacy-Verhalten (north-star
 * per-phase rollback). Legacy `budget_transactions` bleibt in Phase 5 die SSoT
 * für ConsumedNet; der Ledger wird als getreuer Schatten der Legacy-Konsumtion
 * mitgeschrieben (Phase 6 dreht den Lese-Pfad um).
 *
 * Garantien:
 *  - Overdraft unmöglich (R3/N3/I14): planHold liest die Verfügbarkeit INNERHALB
 *    des Pro-Kunde-Advisory-Locks und verteilt über die pure `planCascade` nur
 *    auf die effektiv freie Kapazität der gekappten Töpfe. Bleibt ein Rest und
 *    der Kunde zahlt nicht privat ⇒ `BudgetHardBlockError`.
 *  - One-ACID-Capture + Idempotenz (N2/R5/I13/I15): Hold→captured und die
 *    Ledger-Buchung passieren in EINER Transaktion; UNIQUE-`idempotencyKey`
 *    macht Replays zu No-ops.
 *  - State-Machine (I3): jeder Übergang via `assertReservationTransition`.
 *  - Atomarer Reschedule (I19): release(alt)+plan(neu) in einer Transaktion;
 *    wirft plan einen Hard-Block, rollt alles zurück → alte Holds bleiben.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  budgetReservations,
  budgetLedger,
  budgetTransactions,
  appointments,
  customers,
  type BudgetReservation,
} from "@shared/schema";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { quantizeKm } from "@shared/domain/invoice-line-items";
import { planCascade, type CascadePot } from "@shared/domain/budget/plan-cascade";
import {
  BudgetHardBlockError,
  OverBudgetCompletionError,
} from "@shared/domain/budget/over-budget-error";
import { classifyReconciliation } from "@shared/domain/budget/reconciliation";
import { assertReservationTransition } from "@shared/domain/budget/reservation-state-machine";
import { calculateAppointmentCost } from "./appointment-cost-calculator";
import { calculateAllocatedCents } from "./allocation-storage";
import { customersRepo } from "../../repos";
import { readBudgetTypeSettings } from "./preferences-storage";
import {
  readUnifiedBudgetAvailability,
  type CappedBudgetPot,
} from "./unified-reader";
import { lastDayOfMonth, parseLocalDate } from "@shared/utils/datetime";

const STATUTORY_POTS: CappedBudgetPot[] = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
];

const DEFAULT_PRIORITY: Record<CappedBudgetPot, number> = {
  entlastungsbetrag_45b: 1,
  umwandlung_45a: 2,
  ersatzpflege_39_42a: 3,
};

/** Feature-Flag-Gate. Aus = kein Hold-Schreibpfad (Legacy-only). */
export function hardHoldsEnabled(): boolean {
  const v = process.env.BUDGET_HARD_HOLDS;
  return v === "1" || v === "true";
}

function holdKey(
  appointmentId: number,
  occurrenceId: string | null,
  budgetType: string,
  revision: number,
): string {
  // `revision` ist die Anzahl bereits existierender (auch terminaler) Reservierungs-
  // zeilen für (appointment, occurrence, budgetType). Da `idempotency_key` global
  // UNIQUE ist, würde ein Re-Plan nach Release/Capture sonst auf den alten Key
  // kollidieren (onConflictDoNothing) und nie eine neue Hold-Zeile anlegen — der
  // atomare Reschedule (I19) wäre kaputt. Die Revision macht jeden Re-Plan eindeutig.
  return `hold:a${appointmentId}:o${occurrenceId ?? "_"}:${budgetType}:r${revision}`;
}

function captureKey(
  appointmentId: number,
  occurrenceId: string | null,
  budgetType: string,
  legacyTxId: number,
): string {
  return `capture:a${appointmentId}:o${occurrenceId ?? "_"}:${budgetType}:l${legacyTxId}`;
}

interface HoldCostInputs {
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
}

interface AppointmentCosts {
  hauswirtschaftCents: number;
  alltagsbegleitungCents: number;
  travelCents: number;
  customerKilometersCents: number;
  totalCents: number;
}

/**
 * Skaliert die Service-Bein-Beträge eines Topf-Splits proportional und setzt das
 * letzte Bein als Residuum (Subtract-last, Task #441), sodass
 * `hw + ab + tv + ck === splitAmount` exakt gilt — identisch zur Konsumtions-
 * skalierung (`buildConsumptionTxData`), damit Hold und Consume für gleiche
 * Eingaben pro Topf betragsgleich sind (I7).
 */
function scaleHoldLegs(
  splitAmountCents: number,
  totalCents: number,
  costs: AppointmentCosts,
  inputs: HoldCostInputs,
) {
  const ratio = totalCents > 0 ? splitAmountCents / totalCents : 0;
  const hw = Math.round(costs.hauswirtschaftCents * ratio);
  const ab = Math.round(costs.alltagsbegleitungCents * ratio);
  const tv = Math.round(costs.travelCents * ratio);
  const ck = splitAmountCents - hw - ab - tv;
  return {
    hauswirtschaftMinutes: Math.round(inputs.hauswirtschaftMinutes * ratio),
    hauswirtschaftCents: hw,
    alltagsbegleitungMinutes: Math.round(inputs.alltagsbegleitungMinutes * ratio),
    alltagsbegleitungCents: ab,
    travelKilometers: quantizeKm(inputs.travelKilometers * ratio),
    travelCents: tv,
    customerKilometers: quantizeKm(inputs.customerKilometers * ratio),
    customerKilometersCents: ck,
  };
}

async function acquireConsumptionLock(customerId: number, tx: DbClient): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('budget_consumption_' || ${customerId}::text))`,
  );
}

async function getPrivateCapability(
  customerId: number,
  tx: DbClient,
): Promise<{ isSelbstzahler: boolean; isPrivateAllowed: boolean }> {
  const [customer] = await customersRepo
    .selectColumnsFrom(
      {
        acceptsPrivatePayment: customers.acceptsPrivatePayment,
        billingType: customers.billingType,
      },
      tx,
    )
    .where(eq(customers.id, customerId))
    .limit(1);
  const isSelbstzahler = customer?.billingType === "selbstzahler";
  const isPrivateAllowed = (customer?.acceptsPrivatePayment ?? false) || isSelbstzahler;
  return { isSelbstzahler, isPrivateAllowed };
}

export interface PlanHoldParams {
  customerId: number;
  appointmentId: number;
  occurrenceId?: string | null;
  transactionDate: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  userId?: number;
}

export interface PlanHoldResult {
  reservations: BudgetReservation[];
  heldCents: number;
}

/**
 * Reserviert Budget für einen geplanten Termin (R3/I14). Idempotent pro
 * (appointmentId, occurrenceId, budgetType). Wirft `BudgetHardBlockError`, wenn
 * die gekappten Töpfe nicht reichen und der Kunde nicht privat zahlt.
 */
export async function planHold(
  params: PlanHoldParams,
  outerTx?: DbClient,
): Promise<PlanHoldResult> {
  const occurrenceId = params.occurrenceId ?? null;

  const doWork = async (tx: DbClient): Promise<PlanHoldResult> => {
    await acquireConsumptionLock(params.customerId, tx);

    // Idempotenz: existieren bereits aktive Holds für diesen Termin? → zurück.
    const existing = await tx
      .select()
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.appointmentId, params.appointmentId),
          eq(budgetReservations.state, "hold"),
          occurrenceId === null
            ? isNull(budgetReservations.occurrenceId)
            : eq(budgetReservations.occurrenceId, occurrenceId),
        ),
      );
    if (existing.length > 0) {
      return {
        reservations: existing,
        heldCents: existing.reduce((s, r) => s + r.amountCents, 0),
      };
    }

    const costs = await calculateAppointmentCost({
      customerId: params.customerId,
      hauswirtschaftMinutes: params.hauswirtschaftMinutes,
      alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
      travelKilometers: params.travelKilometers,
      customerKilometers: params.customerKilometers,
      date: params.transactionDate,
    });

    if (costs.totalCents <= 0) {
      return { reservations: [], heldCents: 0 };
    }

    const { isSelbstzahler, isPrivateAllowed } = await getPrivateCapability(
      params.customerId,
      tx,
    );

    // Verfügbarkeit INNERHALB des Locks lesen (Two-Table-Guard): availableCents
    // ist bereits Allocation- UND Cap- UND Hold-bereinigt.
    const avail = await readUnifiedBudgetAvailability(
      params.customerId,
      params.transactionDate,
      tx,
    );
    const settings = await readBudgetTypeSettings(
      params.customerId,
      { kind: "forDate", asOfDate: params.transactionDate },
      tx,
    );
    const priorityOf = new Map<string, number>(
      settings.map((s) => [s.budgetType, s.priority]),
    );

    // Task #912 — §45b-Buchungsverfügbarkeit an die Overview-Projektion koppeln.
    // Der unified Reader liest §45b strikt zum Termin-Datum (`asOfDate`) OHNE die
    // Vorausschau (`projectFuture`), die die „Verfügbar (nach Planung)"-Anzeige
    // benutzt (Task #704). Für einen ZUKÜNFTIGEN Termin kappt
    // `calculateAllocated45b` den Akkumulations-Horizont sonst auf „heute" — die
    // bis zum Termin-Monat noch auflaufende Monatsaufstockung fehlt. Folge:
    // Einzeltermine und frühe Serien-Vorkommen, deren Kost den bis HEUTE
    // aufgelaufenen §45b übersteigt, aber im bis zum Termin-Monat PROJIZIERTEN
    // Anspruch liegen, würden fälschlich hart geblockt — strenger als die
    // Anzeige. Wir projizieren §45b daher mit demselben Horizont wie das Summary
    // (`projectFuture` bis zum Monatsende des Termin-Monats) und behalten Holds +
    // bereits gebuchten Net exakt aus dem In-Lock-Read bei (Overdraft-Garantie:
    // aktive Holds des Jahres werden weiter abgezogen, der projizierte Anspruch
    // ist die einzige Änderung). §45a/§39 bleiben unverändert (Monats-/Jahres-Cap).
    const pot45b = avail.pots.entlastungsbetrag_45b;
    let projected45bAvailableCents = pot45b.availableCents;
    if (pot45b.enabled && pot45b.inRange) {
      const apptDate = parseLocalDate(params.transactionDate);
      const monthEnd = lastDayOfMonth(apptDate.getFullYear(), apptDate.getMonth() + 1);
      const projectedAllocated = await calculateAllocatedCents(
        params.customerId,
        "entlastungsbetrag_45b",
        { asOfDate: monthEnd, projectFuture: true },
        tx,
        undefined,
        settings,
      );
      projected45bAvailableCents = Math.max(
        0,
        projectedAllocated - pot45b.consumedNetCents - pot45b.holdsActiveCents,
      );
    }

    const orderedStatutory = isSelbstzahler
      ? []
      : [...STATUTORY_POTS]
          .sort(
            (a, b) =>
              (priorityOf.get(a) ?? DEFAULT_PRIORITY[a]) -
              (priorityOf.get(b) ?? DEFAULT_PRIORITY[b]),
          )
          .map<CascadePot>((bt) => ({
            budgetType: bt,
            capacityCents:
              bt === "entlastungsbetrag_45b"
                ? projected45bAvailableCents
                : avail.pots[bt].availableCents,
          }));

    const pots: CascadePot[] = [...orderedStatutory];
    if (isPrivateAllowed) {
      // Privater Topf absorbiert den Rest, wird aber NICHT als Hold geschrieben
      // (uncapped, kann nie überbuchen) — er existiert hier nur, damit kein
      // Rest übrig bleibt und der Hard-Block korrekt unterbleibt.
      pots.push({ budgetType: "__private__", capacityCents: 0, uncapped: true });
    }

    const { splits, outstandingCents } = planCascade(costs.totalCents, pots);
    if (outstandingCents > 0) {
      throw new BudgetHardBlockError(outstandingCents);
    }

    // Revision pro budgetType = Anzahl bereits existierender Reservierungszeilen
    // (jeden States) für diesen Termin/Occurrence. Garantiert eindeutige
    // idempotency_keys für Re-Plans nach Release/Capture (I19), während ein echter
    // Replay durch die Active-Hold-Kurzschluss-Prüfung oben abgefangen wird.
    const priorRows = await tx
      .select({ budgetType: budgetReservations.budgetType })
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.appointmentId, params.appointmentId),
          occurrenceId === null
            ? isNull(budgetReservations.occurrenceId)
            : eq(budgetReservations.occurrenceId, occurrenceId),
        ),
      );
    const revisionByType = new Map<string, number>();
    for (const r of priorRows) {
      revisionByType.set(r.budgetType, (revisionByType.get(r.budgetType) ?? 0) + 1);
    }

    const period = params.transactionDate.slice(0, 7);
    const rows: BudgetReservation[] = [];
    for (const split of splits) {
      if (split.uncapped || split.amountCents <= 0) continue;
      const legs = scaleHoldLegs(split.amountCents, costs.totalCents, costs, {
        hauswirtschaftMinutes: params.hauswirtschaftMinutes,
        alltagsbegleitungMinutes: params.alltagsbegleitungMinutes,
        travelKilometers: params.travelKilometers,
        customerKilometers: params.customerKilometers,
      });
      const inserted = await tx
        .insert(budgetReservations)
        .values({
          customerId: params.customerId,
          appointmentId: params.appointmentId,
          occurrenceId,
          budgetType: split.budgetType,
          period,
          amountCents: split.amountCents,
          state: "hold",
          idempotencyKey: holdKey(
            params.appointmentId,
            occurrenceId,
            split.budgetType,
            revisionByType.get(split.budgetType) ?? 0,
          ),
          createdByUserId: params.userId,
          ...legs,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) rows.push(inserted[0]);
    }

    // Falls onConflict alle Inserts schluckte (paralleler Replay): aktive Holds
    // neu lesen, damit der Aufrufer immer den Ist-Zustand bekommt.
    if (rows.length === 0) {
      const after = await tx
        .select()
        .from(budgetReservations)
        .where(
          and(
            eq(budgetReservations.appointmentId, params.appointmentId),
            eq(budgetReservations.state, "hold"),
            occurrenceId === null
              ? isNull(budgetReservations.occurrenceId)
              : eq(budgetReservations.occurrenceId, occurrenceId),
          ),
        );
      return { reservations: after, heldCents: after.reduce((s, r) => s + r.amountCents, 0) };
    }

    return { reservations: rows, heldCents: rows.reduce((s, r) => s + r.amountCents, 0) };
  };

  return outerTx ? doWork(outerTx) : db.transaction(doWork);
}

export interface CaptureHoldsResult {
  capturedCount: number;
  releasedCount: number;
  /** Stufe B (Task #1273) — IDs der budget_transactions-Konsum-Zeilen, auf die
   *  die captured Reservierungen dieses Termins verlinken (ehemals `ledgerIds`). */
  transactionIds: number[];
  reconciliationCase: "partial_capture" | "same_pot_extend" | "cross_pot_overflow" | "none";
}

/**
 * Überführt beim Abschluss die Holds (N2/R5/I13/I15). MUSS in derselben
 * Transaktion laufen, in der die Legacy-Konsumtion (`budget_transactions`)
 * bereits geschrieben wurde — ab Stufe B (Task #1273) ist `budget_transactions`
 * selbst die append-only Finanz-Schicht (kein budget_ledger-Spiegel mehr); Holds
 * werden auf captured (mit captured_transaction_id) / released überführt.
 */
export async function captureHolds(
  params: {
    customerId: number;
    appointmentId: number;
    occurrenceId?: string | null;
    userId?: number;
  },
  tx: DbClient,
): Promise<CaptureHoldsResult> {
  const occurrenceId = params.occurrenceId ?? null;
  await acquireConsumptionLock(params.customerId, tx);

  const holds = await tx
    .select()
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.appointmentId, params.appointmentId),
        eq(budgetReservations.state, "hold"),
        occurrenceId === null
          ? isNull(budgetReservations.occurrenceId)
          : eq(budgetReservations.occurrenceId, occurrenceId),
      ),
    );
  if (holds.length === 0) {
    return { capturedCount: 0, releasedCount: 0, transactionIds: [], reconciliationCase: "none" };
  }

  // Legacy-Konsumtionszeilen dieses Termins (in derselben Tx geschrieben) =
  // autoritative Ist-Buchung. Der Ledger spiegelt sie.
  const consumptionRows = await tx
    .select()
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.appointmentId, params.appointmentId),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    );

  const holdTotal = holds.reduce((s, r) => s + r.amountCents, 0);
  const actualTotal = consumptionRows.reduce((s, r) => s + Math.abs(r.amountCents), 0);

  // Reconciliation-Klassifikation (R4/I16) — Headroom = freie Restkapazität der
  // statutarischen Töpfe ZUSÄTZLICH zum Hold, gemessen VOR der Ist-Buchung dieses
  // Termins. `readUnifiedBudgetAvailability` zieht aber sowohl die noch aktiven
  // Holds dieses Termins ALS AUCH die in derselben Tx bereits geschriebenen
  // Legacy-Konsumtionszeilen ab. Letztere sind genau der Ist, gegen den wir
  // reconcilen — sie dürfen den Headroom nicht schmälern, sonst wird ein valider
  // case-(b) (same_pot_extend) fälschlich zu case-(c) und blockt hart. Daher den
  // statutarischen Ist-Anteil DIESES Termins wieder addieren (algebraisch exakt:
  // availableCents = capacity − fremderKonsum − fremdeHolds − dieserHold − dieserKonsum).
  const avail = await readUnifiedBudgetAvailability(
    params.customerId,
    consumptionRows[0]?.transactionDate ?? holds[0].period + "-01",
    tx,
  );
  const statutoryActualThisAppt = consumptionRows
    .filter((c) => (STATUTORY_POTS as string[]).includes(c.budgetType))
    .reduce((s, c) => s + Math.abs(c.amountCents), 0);
  const samePotHeadroom =
    STATUTORY_POTS.reduce((s, bt) => s + avail.pots[bt].availableCents, 0) +
    statutoryActualThisAppt;
  const { isPrivateAllowed } = await getPrivateCapability(params.customerId, tx);
  const recon = classifyReconciliation({
    holdCents: holdTotal,
    actualCents: actualTotal,
    samePotHeadroomCents: samePotHeadroom,
    isPrivateCapable: isPrivateAllowed,
  });
  if (recon.hardBlocked) {
    const lastStatutory = holds[holds.length - 1]?.budgetType ?? "entlastungsbetrag_45b";
    throw new OverBudgetCompletionError(params.appointmentId, recon.overflowCents, lastStatutory);
  }

  // Stufe B (Task #1273) — der budget_ledger-Spiegel-INSERT entfällt:
  // `budget_transactions` IST ab Stufe B die append-only Finanz-Schicht. Der
  // Capture-Link zeigt direkt auf die Konsum-Zeile (captured_transaction_id);
  // pro Topf gewinnt die erste Konsum-Zeile dieses Topfes.
  const transactionIds: number[] = [];
  const txByType = new Map<string, number>();
  for (const c of consumptionRows) {
    transactionIds.push(c.id);
    if (!txByType.has(c.budgetType)) {
      txByType.set(c.budgetType, c.id);
    }
  }

  // Tatsächlich gebuchte Ist-Beträge pro Topf (aus den Legacy-Konsumtionszeilen)
  // — damit beim Capture die Reconciliation-Anpassung (case a: Ist < Hold →
  // herabsetzen; case b: Ist > Hold im selben Topf → heraufsetzen) AUF DER
  // Reservierung selbst sichtbar wird und nicht nur klassifiziert herumliegt.
  const actualByType = new Map<string, number>();
  for (const c of consumptionRows) {
    actualByType.set(
      c.budgetType,
      (actualByType.get(c.budgetType) ?? 0) + Math.abs(c.amountCents),
    );
  }

  // Holds überführen: gibt es Konsum im selben Topf → captured (+ Transaktions-
  // Link, amountCents auf den reconcilierten Ist-Betrag dieses Topfes gesetzt);
  // sonst (Topf blieb ungenutzt, case a Teil-Capture) → released.
  let capturedCount = 0;
  let releasedCount = 0;
  for (const hold of holds) {
    const txId = txByType.get(hold.budgetType);
    const target = txId != null ? "captured" : "released";
    assertReservationTransition("hold", target);
    const capturedAmount =
      target === "captured"
        ? actualByType.get(hold.budgetType) ?? hold.amountCents
        : hold.amountCents;
    await tx
      .update(budgetReservations)
      .set({
        state: target,
        // Stufe B (Task #1273) — der Capture-Link zeigt direkt auf die
        // budget_transactions-Konsum-Zeile dieses Topfes. capturedLedgerId wird
        // nicht mehr gesetzt (Spalte bleibt für Stufe C bestehen).
        capturedTransactionId: txId ?? null,
        amountCents: capturedAmount,
        updatedAt: new Date(),
      })
      .where(eq(budgetReservations.id, hold.id));
    if (target === "captured") capturedCount++;
    else releasedCount++;
  }

  return {
    capturedCount,
    releasedCount,
    transactionIds,
    reconciliationCase: recon.case,
  };
}

/**
 * Gibt alle aktiven Holds eines Termins frei (Storno/Reschedule/Reopen).
 * Idempotent — wirkt nur auf `state='hold'`.
 */
export async function releaseHolds(
  appointmentId: number,
  userId?: number,
  outerTx?: DbClient,
): Promise<number> {
  const run = async (tx: DbClient): Promise<number> => {
    const holds = await tx
      .select({ id: budgetReservations.id })
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.appointmentId, appointmentId),
          eq(budgetReservations.state, "hold"),
        ),
      );
    if (holds.length === 0) return 0;
    assertReservationTransition("hold", "released");
    await tx
      .update(budgetReservations)
      .set({ state: "released", updatedAt: new Date(), createdByUserId: userId })
      .where(
        and(
          inArray(
            budgetReservations.id,
            holds.map((h) => h.id),
          ),
          eq(budgetReservations.state, "hold"),
        ),
      );
    return holds.length;
  };
  return outerTx ? run(outerTx) : db.transaction(run);
}

/**
 * Atomarer Reschedule (I19): alte Holds freigeben + neue planen in EINER
 * Transaktion. Wirft `planHold` einen Hard-Block, rollt alles zurück → die
 * ursprünglichen Holds bleiben unverändert bestehen.
 */
export async function rescheduleHold(
  params: PlanHoldParams,
  outerTx?: DbClient,
): Promise<PlanHoldResult> {
  const run = async (tx: DbClient): Promise<PlanHoldResult> => {
    await releaseHolds(params.appointmentId, params.userId, tx);
    return planHold(params, tx);
  };
  return outerTx ? run(outerTx) : db.transaction(run);
}

export interface OrphanHold {
  reservation: BudgetReservation;
  reason: "appointment_cancelled" | "appointment_deleted" | "completed_uncaptured" | "expired";
}

/**
 * Read-only Orphan-/Expiry-Sweep (R6/N4). Findet aktive Holds, deren Termin
 * inkonsistent ist: storniert/gelöscht (hätte released werden müssen) oder
 * abgeschlossen ohne Capture (Limbo, I20). Prod-sicher: schreibt NICHTS.
 */
export async function sweepOrphanHolds(asOf: Date = new Date()): Promise<OrphanHold[]> {
  const rows = await db
    .select({
      reservation: budgetReservations,
      apptStatus: appointments.status,
      apptDeletedAt: appointments.deletedAt,
    })
    .from(budgetReservations)
    .leftJoin(appointments, eq(budgetReservations.appointmentId, appointments.id))
    .where(eq(budgetReservations.state, "hold"));

  const orphans: OrphanHold[] = [];
  for (const r of rows) {
    const exp = r.reservation.expiresAt;
    if (exp && exp.getTime() < asOf.getTime()) {
      orphans.push({ reservation: r.reservation, reason: "expired" });
      continue;
    }
    if (r.apptDeletedAt != null) {
      orphans.push({ reservation: r.reservation, reason: "appointment_deleted" });
      continue;
    }
    if (r.apptStatus === "cancelled") {
      orphans.push({ reservation: r.reservation, reason: "appointment_cancelled" });
      continue;
    }
    if (r.apptStatus === "completed") {
      orphans.push({ reservation: r.reservation, reason: "completed_uncaptured" });
    }
  }
  return orphans;
}
