/**
 * Task #613 / #618 — Termin-Edit-Änderungen automatisch in Budget übernehmen.
 *
 * Hintergrund: wird ein bereits dokumentierter Termin nachträglich editiert
 * und ändern sich budget-relevante Felder (km, Service-Minuten, Datum oder
 * die Services selbst), bleiben die zugehörigen `budget_transactions`-Zeilen
 * sonst auf den ALTEN Werten stehen. Vor #618 hat `reconcile-km-drift`
 * (manuell) bzw. der km-Edit-Pfad aus #613 nur den km-Drift abgefangen —
 * Datum/Minuten/Services-Drift blieb still bestehen.
 *
 * Vorgehen (analog `server/scripts/reconcile-km-drift.ts` und der
 * Bulk-Variante `rebookDisabledBudgetTransactions`):
 *   1. Bestehende `consumption`-Txs zum Termin laden.
 *   2. Aus dem AKTUELLEN Termin + `appointment_services` die Soll-Werte
 *      ableiten (km direkt vom Termin, hw/ab-Minuten aus Summe der Service-
 *      Zeilen nach `lohnart_kategorie`, Datum vom Termin).
 *   3. Wenn alles drift-frei zur Summe der Bestands-Txs passt → no-op.
 *   4. Sonst: pro Tx ein `reversal` mit `reversedTransactionId` schreiben
 *      (idempotent über UNIQUE-Index → onConflictDoNothing). Datum =
 *      ursprüngliches Buchungsdatum, damit Monats-Caps korrekt netto rechnen.
 *   5. Alte Consumptions vom Termin abkoppeln (`appointmentId = null`), damit
 *      `createConsumptionTransaction` keinen Dup-Konflikt sieht.
 *   6. Neu-Buchung via `createConsumptionTransaction` mit den AKTUELLEN
 *      Termin-Werten am AKTUELLEN Termin-Datum (damit ein Datums-Edit auch
 *      die neue Monatsperiode trifft).
 *
 * Audit-Log wird vom Aufrufer geschrieben (`appointment_km_rebooked` mit
 * `trigger`-Feld für km/duration/services/date), damit der Auslöser im
 * Audit-Trail erkennbar bleibt.
 */

import { eq, and, inArray } from "drizzle-orm";
import { appointments, appointmentServices, budgetTransactions, services } from "@shared/schema";
import { createConsumptionTransaction } from "./consumption-engine";
import type { DbClient } from "./types";
import { db } from "../../lib/db";
import { appointmentsRepo } from "../../repos";

export interface RebookKmParams {
  appointmentId: number;
  customerId: number;
  /** Neue km-Werte aus dem AKTUELLEN Termin (nach dem Update). */
  travelKilometers: number;
  customerKilometers: number;
  userId?: number;
}

export interface RebookKmResult {
  /** true wenn Storno+Neu ausgeführt wurde, false wenn kein Rebook nötig war. */
  rebooked: boolean;
  reversedTransactionIds: number[];
  /** Buchungsdatum, an das die Neu-Buchung gehängt wurde (für Audit-Log). */
  transactionDate: string | null;
  /** Aus den aktuellen Services summierte Minuten, die für die Neu-Buchung verwendet wurden. */
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  /** km-Summen der alten Buchungen (Quelle vor dem Rebook) — für Audit-Log. */
  previousTravelKm: number;
  previousCustomerKm: number;
  /** Buchungsdatum der alten Txs (vor dem Rebook) — für Audit-Log bei Datums-Edits. */
  previousTransactionDate: string | null;
  /** Minuten-Summen der alten Buchungen (Quelle vor dem Rebook). */
  previousHauswirtschaftMinutes: number;
  previousAlltagsbegleitungMinutes: number;
}

/**
 * Liest die aktuell durchgeführten (oder geplanten) Service-Minuten und
 * gruppiert sie nach `services.lohnart_kategorie`. Fällt auf
 * `plannedDurationMinutes` zurück, wenn `actualDurationMinutes` (noch)
 * nicht gesetzt ist.
 */
async function loadCurrentServiceMinutes(
  appointmentId: number,
  tx: DbClient,
): Promise<{ hwMinutes: number; abMinutes: number }> {
  const rows = await tx.select({
    actual: appointmentServices.actualDurationMinutes,
    planned: appointmentServices.plannedDurationMinutes,
    kategorie: services.lohnartKategorie,
  })
    .from(appointmentServices)
    .innerJoin(services, eq(appointmentServices.serviceId, services.id))
    .where(eq(appointmentServices.appointmentId, appointmentId));

  let hw = 0;
  let ab = 0;
  for (const r of rows) {
    const m = r.actual ?? r.planned ?? 0;
    if (r.kategorie === "hauswirtschaft") hw += m;
    else if (r.kategorie === "alltagsbegleitung") ab += m;
  }
  return { hwMinutes: hw, abMinutes: ab };
}

export async function rebookAppointmentConsumptionForKm(
  params: RebookKmParams,
  tx: DbClient,
): Promise<RebookKmResult> {
  return rebookAppointmentConsumption(
    { appointmentId: params.appointmentId, userId: params.userId },
    tx,
  );
}

/**
 * Generelle Rebook-Funktion für Termin-Edits (Task #618). Liest die
 * AKTUELLEN Werte (km, Minuten, Datum) selbst aus DB und vergleicht mit
 * der Summe der bestehenden Consumption-Txs. Bei Drift: Storno der alten
 * Txs + Neu-Buchung über `createConsumptionTransaction`.
 */
export async function rebookAppointmentConsumption(
  params: { appointmentId: number; userId?: number },
  tx: DbClient,
): Promise<RebookKmResult> {
  const empty: RebookKmResult = {
    rebooked: false,
    reversedTransactionIds: [],
    transactionDate: null,
    hauswirtschaftMinutes: 0,
    alltagsbegleitungMinutes: 0,
    previousTravelKm: 0,
    previousCustomerKm: 0,
    previousTransactionDate: null,
    previousHauswirtschaftMinutes: 0,
    previousAlltagsbegleitungMinutes: 0,
  };

  const existingTxs = await tx.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, params.appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  if (existingTxs.length === 0) return empty;

  const [appt] = await appointmentsRepo.selectColumnsFrom({
    customerId: appointments.customerId,
    date: appointments.date,
    travelKilometers: appointments.travelKilometers,
    customerKilometers: appointments.customerKilometers,
  }, tx)
    .where(and(
      eq(appointments.id, params.appointmentId),
      appointmentsRepo.activeOnly(),
    ))
    .limit(1);

  if (!appt || appt.customerId == null) return empty;

  const newTravelKm = appt.travelKilometers ?? 0;
  const newCustomerKm = appt.customerKilometers ?? 0;
  const newDate = typeof appt.date === "string" ? appt.date : String(appt.date);

  const { hwMinutes: newHw, abMinutes: newAb } = await loadCurrentServiceMinutes(
    params.appointmentId,
    tx,
  );

  const prevTravelKm = existingTxs.reduce((s, t) => s + (t.travelKilometers ?? 0), 0);
  const prevCustomerKm = existingTxs.reduce((s, t) => s + (t.customerKilometers ?? 0), 0);
  const prevHw = existingTxs.reduce((s, t) => s + (t.hauswirtschaftMinutes ?? 0), 0);
  const prevAb = existingTxs.reduce((s, t) => s + (t.alltagsbegleitungMinutes ?? 0), 0);
  const prevDate = existingTxs[0].transactionDate;

  // Drift-Toleranz für km: 0,01 km, weil `quantizeKm` auf 2 NK rundet und
  // FIFO-Splits Cents-genau ausgleichen (Σlegs == amountCents), nicht aber
  // km bis aufs Bit. Datum und Minuten sind ganzzahlig — strikter Vergleich.
  const kmDriftTravel = Math.abs(prevTravelKm - newTravelKm);
  const kmDriftCustomer = Math.abs(prevCustomerKm - newCustomerKm);
  const kmDrift = kmDriftTravel > 0.01 || kmDriftCustomer > 0.01;
  const minutesDrift = prevHw !== newHw || prevAb !== newAb;
  const dateDrift = prevDate !== newDate;

  if (!kmDrift && !minutesDrift && !dateDrift) {
    return {
      ...empty,
      previousTravelKm: prevTravelKm,
      previousCustomerKm: prevCustomerKm,
      previousTransactionDate: prevDate,
      previousHauswirtschaftMinutes: prevHw,
      previousAlltagsbegleitungMinutes: prevAb,
      hauswirtschaftMinutes: newHw,
      alltagsbegleitungMinutes: newAb,
    };
  }

  // Ohne Minuten würde die Neu-Buchung 0 € kosten und die alten
  // Consumption-Spuren ohne Ersatz aufheben. Das ist explizit erlaubt
  // (Termin auf 0 Min editiert → kein Verbrauch), aber wir behandeln es
  // gleich: Reverse + leeres Re-Booking.
  const reversedIds: number[] = [];

  for (const orig of existingTxs) {
    const [rev] = await tx.insert(budgetTransactions).values({
      customerId: orig.customerId,
      budgetType: orig.budgetType,
      transactionDate: orig.transactionDate,
      transactionType: "reversal",
      amountCents: -orig.amountCents,
      appointmentId: null,
      allocationId: orig.allocationId,
      reversedTransactionId: orig.id,
      notes: `Storno (Termin-Edit) von Transaktion #${orig.id}`,
      createdByUserId: params.userId,
    })
      .onConflictDoNothing()
      .returning();
    if (rev) reversedIds.push(orig.id);
  }

  // Alte Consumptions vom Termin abkoppeln, damit der Pre-Check in
  // createCascadeConsumption keine offene Zeile mehr sieht.
  await tx.update(budgetTransactions)
    .set({ appointmentId: null })
    .where(and(
      eq(budgetTransactions.appointmentId, params.appointmentId),
      inArray(budgetTransactions.id, existingTxs.map(t => t.id)),
    ));

  if (newHw > 0 || newAb > 0 || newTravelKm > 0 || newCustomerKm > 0) {
    await createConsumptionTransaction({
      customerId: appt.customerId,
      appointmentId: params.appointmentId,
      transactionDate: newDate,
      hauswirtschaftMinutes: newHw,
      alltagsbegleitungMinutes: newAb,
      travelKilometers: newTravelKm,
      customerKilometers: newCustomerKm,
      userId: params.userId,
    }, tx);
  }

  return {
    rebooked: true,
    reversedTransactionIds: reversedIds,
    transactionDate: newDate,
    hauswirtschaftMinutes: newHw,
    alltagsbegleitungMinutes: newAb,
    previousTravelKm: prevTravelKm,
    previousCustomerKm: prevCustomerKm,
    previousTransactionDate: prevDate,
    previousHauswirtschaftMinutes: prevHw,
    previousAlltagsbegleitungMinutes: prevAb,
  };
}

// Re-export `db` für Module, die nur die generelle Funktion brauchen.
export { db as _kmRebookDb };
