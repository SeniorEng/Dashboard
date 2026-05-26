/**
 * Task #613 — Termin-km-Änderungen automatisch in Budget übernehmen.
 *
 * Hintergrund: wird ein bereits dokumentierter Termin nachträglich editiert
 * und ändern sich die km-Werte (`travelKilometers` / `customerKilometers`),
 * bleiben die zugehörigen `budget_transactions`-Zeilen sonst auf den ALTEN
 * km/Cents stehen und driften zur Anzeige. Bisher half nur das
 * `reconcile-km-drift`-Skript. Diese Helfer-Funktion erlaubt es dem
 * Termin-Update-Pfad, denselben Storno+Neu-Schritt synchron in derselben
 * Transaktion auszulösen.
 *
 * Vorgehen identisch zu `server/scripts/reconcile-km-drift.ts`:
 *   1. Bestehende `consumption`-Txs zum Termin laden.
 *   2. Pro Tx ein `reversal` mit `reversedTransactionId` schreiben (idempotent
 *      über UNIQUE-Index → onConflictDoNothing). Datum = ursprüngliches
 *      Buchungsdatum, damit Monats-Caps korrekt netto rechnen.
 *   3. Alte Consumptions vom Termin abkoppeln (`appointmentId = null`), damit
 *      `createCascadeConsumption` keinen Dup-Konflikt sieht.
 *   4. Neu-Buchung via `createConsumptionTransaction` mit den AKTUELLEN
 *      Termin-km am ursprünglichen Buchungsdatum. Minuten kommen aus der
 *      Summe der bisherigen Buchungen, damit die Topf-Wahl stabil bleibt
 *      und keine ungewollte Re-Cost-Berechnung passiert.
 *
 * Audit-Log wird vom Aufrufer geschrieben (für den Live-Edit-Pfad mit Action
 * `appointment_km_rebooked`, für das Skript mit `km_drift_reconciled`),
 * damit der Auslöser im Audit-Trail erkennbar bleibt.
 */

import { eq, and, inArray } from "drizzle-orm";
import { budgetTransactions } from "@shared/schema";
import { createConsumptionTransaction } from "./consumption-engine";
import type { DbClient } from "./types";

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
  /** Aus den Bestands-Txs summierte Minuten, die für die Neu-Buchung verwendet wurden. */
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  /** km-Summen der alten Buchungen (Quelle vor dem Rebook) — für Audit-Log. */
  previousTravelKm: number;
  previousCustomerKm: number;
}

export async function rebookAppointmentConsumptionForKm(
  params: RebookKmParams,
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
  };

  const existingTxs = await tx.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, params.appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  if (existingTxs.length === 0) return empty;

  const hwSum = existingTxs.reduce((s, t) => s + (t.hauswirtschaftMinutes ?? 0), 0);
  const abSum = existingTxs.reduce((s, t) => s + (t.alltagsbegleitungMinutes ?? 0), 0);

  if (hwSum === 0 && abSum === 0) {
    // Ohne Minuten würde die Neu-Buchung 0 € kosten und keine ausgleichende
    // Cascade-Zeile schreiben. Dann wäre der Storno verlustfrei, aber die
    // ursprüngliche km-Spur ginge ohne Ersatz verloren — also nicht anfassen.
    return empty;
  }

  const txDate = existingTxs[0].transactionDate;
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
      notes: `Storno (Termin-Edit km-Update) von Transaktion #${orig.id}`,
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

  await createConsumptionTransaction({
    customerId: params.customerId,
    appointmentId: params.appointmentId,
    transactionDate: txDate,
    hauswirtschaftMinutes: hwSum,
    alltagsbegleitungMinutes: abSum,
    travelKilometers: params.travelKilometers,
    customerKilometers: params.customerKilometers,
    userId: params.userId,
  }, tx);

  return {
    rebooked: true,
    reversedTransactionIds: reversedIds,
    transactionDate: txDate,
    hauswirtschaftMinutes: hwSum,
    alltagsbegleitungMinutes: abSum,
    previousTravelKm: existingTxs.reduce((s, t) => s + (t.travelKilometers ?? 0), 0),
    previousCustomerKm: existingTxs.reduce((s, t) => s + (t.customerKilometers ?? 0), 0),
  };
}
