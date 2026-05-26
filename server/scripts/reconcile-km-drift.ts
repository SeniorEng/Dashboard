/**
 * Reconciliation-Skript für Task #611:
 *   Repariert Termine, bei denen `appointments.travelKilometers` (Termin-
 *   Detail / Anzeige) und die Summe der `budget_transactions.travelKilometers`
 *   desselben Termins um mehr als die Rundungstoleranz auseinanderlaufen.
 *
 * Hintergrund:
 *   - Vor #611 hat `buildConsumptionTxData` km via `Math.round(km * ratio)`
 *     auf Integer-km eingedampft. Termin-Detail zeigt `7,3 km`, Budget-Eintrag
 *     enthielt aber nur `7 km`.
 *   - Zusätzlich gab es Fälle, in denen ein Anwender ursprünglich eine
 *     fehlerhafte km-Zahl (z.B. 70 statt 7,3) eingegeben hat, den Termin
 *     später korrigierte, die alten Budget-Buchungen aber unverändert
 *     blieben. Sichtbar als "Faktor-10-Drift" in der Budget-Übersicht.
 *
 * Vorgehen pro Termin (Drift > 0,15 km):
 *   1. Termin-Daten + bestehende Consumption-Txs laden.
 *   2. Pro Consumption-Tx ein Reversal mit `reversedTransactionId = orig.id`
 *      einfügen (idempotent durch UNIQUE-Index auf `reversedTransactionId`,
 *      onConflictDoNothing).
 *   3. Alte Consumptions vom Termin abkoppeln (`appointmentId = null`), damit
 *      der Pre-Check in `createCascadeConsumption` für diesen Termin keine
 *      offene Zeile mehr sieht.
 *   4. Neue Buchung mit den AKTUELLEN appt-Werten via
 *      `createConsumptionTransaction` — derselbe Pfad wie die normale
 *      Termin-Dokumentation, inkl. korrekter km-Rundung auf 0,1.
 *   5. Audit-Eintrag pro Termin + Sammel-Audit pro Lauf (mit batchId).
 *
 * GoBD: Storno + Neu-Anlage statt UPDATE — die Historie bleibt vollständig
 * sichtbar (alte Tx + Reversal + Neue Tx).
 *
 * Idempotenz:
 *   - `reversedTransactionId`-UNIQUE-Index verhindert Doppel-Storno.
 *   - Re-Lauf: ein zweiter Aufruf findet keine driftenden Termine mehr.
 *
 * Aufruf:
 *   Trockenlauf:        tsx server/scripts/reconcile-km-drift.ts
 *   Bestimmte Termine:  tsx server/scripts/reconcile-km-drift.ts --appointment=39,57
 *   Bestimmter Kunde:   tsx server/scripts/reconcile-km-drift.ts --customer=12
 *   Scharf ausführen:   tsx server/scripts/reconcile-km-drift.ts --apply
 *   Toleranz anpassen:  tsx server/scripts/reconcile-km-drift.ts --tolerance=0.5
 */

import { randomUUID } from "node:crypto";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  appointmentServices,
  budgetTransactions,
  customers,
  services,
} from "@shared/schema";
import { createConsumptionTransaction } from "../storage/budget/consumption-engine";
import { auditService } from "../services/audit";

const DEFAULT_TOLERANCE_KM = 0.15;
const AUDIT_ACTION = "km_drift_reconciled";
const AUDIT_BATCH_ACTION = "km_drift_reconciled_batch";

interface CliArgs {
  apply: boolean;
  appointmentIds: number[];
  customerIds: number[];
  toleranceKm: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const apptArg = args.find(a => a.startsWith("--appointment="));
  const customerArg = args.find(a => a.startsWith("--customer="));
  const tolArg = args.find(a => a.startsWith("--tolerance="));

  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s.split("=")[1].split(",")
      .map(x => parseInt(x.trim(), 10))
      .filter(n => !isNaN(n));
  };

  const toleranceKm = tolArg ? parseFloat(tolArg.split("=")[1]) : DEFAULT_TOLERANCE_KM;

  return {
    apply,
    appointmentIds: parseIds(apptArg),
    customerIds: parseIds(customerArg),
    toleranceKm: Number.isFinite(toleranceKm) && toleranceKm >= 0 ? toleranceKm : DEFAULT_TOLERANCE_KM,
  };
}

export interface DriftCandidate {
  appointmentId: number;
  customerId: number;
  date: string;
  apptTravelKm: number;
  apptCustomerKm: number;
  txTravelKmSum: number;
  txCustomerKmSum: number;
  travelDrift: number;
  customerDrift: number;
}

export async function findDriftCandidates(opts: {
  appointmentIds?: number[];
  customerIds?: number[];
  toleranceKm: number;
}): Promise<DriftCandidate[]> {
  // Wir laden pro Termin appt-km + Σ tx-km und filtern in-Memory. Die Anzahl
  // potenziell betroffener Termine ist klein genug (Größenordnung tausender);
  // ein vollständiger Aggregat-Join wäre auf PostgreSQL ähnlich performant,
  // ist aber wartungsärmer in JS.
  const whereParts = [
    isNull(appointments.deletedAt),
  ];
  if (opts.appointmentIds && opts.appointmentIds.length > 0) {
    whereParts.push(inArray(appointments.id, opts.appointmentIds));
  }
  if (opts.customerIds && opts.customerIds.length > 0) {
    whereParts.push(inArray(appointments.customerId, opts.customerIds));
  }

  const apptRows = await db.select({
    id: appointments.id,
    customerId: appointments.customerId,
    date: appointments.date,
    travelKm: appointments.travelKilometers,
    customerKm: appointments.customerKilometers,
  })
    .from(appointments)
    .where(and(...whereParts));

  if (apptRows.length === 0) return [];

  const apptIds = apptRows.map(a => a.id);
  const txRows = await db.select({
    appointmentId: budgetTransactions.appointmentId,
    travelKm: budgetTransactions.travelKilometers,
    customerKm: budgetTransactions.customerKilometers,
  })
    .from(budgetTransactions)
    .where(and(
      inArray(budgetTransactions.appointmentId, apptIds),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  const sumByAppt = new Map<number, { travel: number; customer: number }>();
  for (const t of txRows) {
    if (t.appointmentId == null) continue;
    const acc = sumByAppt.get(t.appointmentId) ?? { travel: 0, customer: 0 };
    acc.travel += t.travelKm ?? 0;
    acc.customer += t.customerKm ?? 0;
    sumByAppt.set(t.appointmentId, acc);
  }

  const out: DriftCandidate[] = [];
  for (const a of apptRows) {
    const sums = sumByAppt.get(a.id);
    if (!sums) continue; // Keine consumption-tx → kein Drift möglich.
    const apptTravel = a.travelKm ?? 0;
    const apptCustomer = a.customerKm ?? 0;
    const travelDrift = Math.abs(apptTravel - sums.travel);
    const customerDrift = Math.abs(apptCustomer - sums.customer);
    if (travelDrift <= opts.toleranceKm && customerDrift <= opts.toleranceKm) continue;
    out.push({
      appointmentId: a.id,
      customerId: a.customerId!,
      date: typeof a.date === "string" ? a.date : String(a.date),
      apptTravelKm: apptTravel,
      apptCustomerKm: apptCustomer,
      txTravelKmSum: sums.travel,
      txCustomerKmSum: sums.customer,
      travelDrift,
      customerDrift,
    });
  }
  return out;
}

export interface ReconcileResult {
  appointmentId: number;
  status: "ok" | "skipped" | "error";
  detail: string;
  reversedTxIds: number[];
  newTxAmountCents?: number;
}

export interface KmReconcileSummary {
  candidates: DriftCandidate[];
  results: ReconcileResult[];
  repaired: number;
  skipped: number;
  errored: number;
  batchId?: string;
}

async function reconcileOne(
  c: DriftCandidate,
  apply: boolean,
  userId: number | undefined,
  batchId: string | undefined,
): Promise<ReconcileResult> {
  // Wir brauchen die Service-/Minuten-Information aus den bestehenden
  // Consumption-Txs, um die Neu-Buchung 1:1 mit derselben hw/ab-Verteilung
  // wieder anzulegen. Andernfalls würden wir den Termin neu kostenrechnen
  // und potenziell andere Töpfe treffen — das wäre keine reine km-Korrektur.
  const existingTxs = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, c.appointmentId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));

  if (existingTxs.length === 0) {
    return { appointmentId: c.appointmentId, status: "skipped", detail: "keine Consumption-Tx vorhanden", reversedTxIds: [] };
  }

  // hw/ab-Minuten + km-Werte aus dem AKTUELLEN appt holen (km ist die
  // Korrekturgrundlage; hw/ab werden aus den Original-Buchungen summiert,
  // damit die Topf-Wahl stabil bleibt).
  const hwSum = existingTxs.reduce((s, t) => s + (t.hauswirtschaftMinutes ?? 0), 0);
  const abSum = existingTxs.reduce((s, t) => s + (t.alltagsbegleitungMinutes ?? 0), 0);

  if (hwSum === 0 && abSum === 0) {
    return {
      appointmentId: c.appointmentId,
      status: "skipped",
      detail: "weder hw- noch ab-Minuten in bestehenden Buchungen — Neuanlage würde 0 € kosten",
      reversedTxIds: [],
    };
  }

  if (!apply) {
    return {
      appointmentId: c.appointmentId,
      status: "ok",
      detail:
        `Würde storno + neu anlegen: travel ${c.txTravelKmSum.toFixed(1)}→${c.apptTravelKm.toFixed(1)} km, ` +
        `customer ${c.txCustomerKmSum.toFixed(1)}→${c.apptCustomerKm.toFixed(1)} km ` +
        `(hw=${hwSum} min, ab=${abSum} min)`,
      reversedTxIds: existingTxs.map(t => t.id),
    };
  }

  const reversedIds: number[] = [];

  await db.transaction(async (tx) => {
    // 1. Reversal pro bestehender Consumption — datiert auf das ursprüngliche
    //    transactionDate, damit Monatscaps (cap-calculator) korrekt netto
    //    rechnen (consumption[Monat] − reversal[Monat]).
    for (const orig of existingTxs) {
      const dup = await tx.select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.reversedTransactionId, orig.id),
          eq(budgetTransactions.transactionType, "reversal"),
        ))
        .limit(1);
      if (dup.length > 0) continue;

      const [rev] = await tx.insert(budgetTransactions).values({
        customerId: orig.customerId,
        budgetType: orig.budgetType,
        transactionDate: orig.transactionDate,
        transactionType: "reversal",
        amountCents: -orig.amountCents,
        appointmentId: null,
        allocationId: orig.allocationId,
        reversedTransactionId: orig.id,
        notes: `Storno (Reconcile #611 km-Drift) von Transaktion #${orig.id}`,
        createdByUserId: userId,
      })
        .onConflictDoNothing()
        .returning();
      if (rev) reversedIds.push(orig.id);
    }

    // 2. Alte Consumptions vom Termin abkoppeln, damit der Pre-Check in
    //    createCascadeConsumption keine offene Zeile mehr sieht.
    await tx.update(budgetTransactions)
      .set({ appointmentId: null })
      .where(and(
        eq(budgetTransactions.appointmentId, c.appointmentId),
        inArray(budgetTransactions.id, existingTxs.map(t => t.id)),
      ));

    // 3. Neu-Buchung mit AKTUELLEM appt-km am ursprünglichen Datum.
    await createConsumptionTransaction({
      customerId: c.customerId,
      appointmentId: c.appointmentId,
      transactionDate: c.date,
      hauswirtschaftMinutes: hwSum,
      alltagsbegleitungMinutes: abSum,
      travelKilometers: c.apptTravelKm,
      customerKilometers: c.apptCustomerKm,
      userId,
    }, tx);
  });

  if (userId !== undefined) {
    await auditService.log(userId, AUDIT_ACTION, "appointment", c.appointmentId, {
      customerId: c.customerId,
      date: c.date,
      previousTravelKm: c.txTravelKmSum,
      newTravelKm: c.apptTravelKm,
      previousCustomerKm: c.txCustomerKmSum,
      newCustomerKm: c.apptCustomerKm,
      reversedTransactionIds: reversedIds,
      ...(batchId ? { batchId } : {}),
    });
  }

  return {
    appointmentId: c.appointmentId,
    status: "ok",
    detail:
      `Storno + neu angelegt: travel ${c.txTravelKmSum.toFixed(1)}→${c.apptTravelKm.toFixed(1)} km, ` +
      `customer ${c.txCustomerKmSum.toFixed(1)}→${c.apptCustomerKm.toFixed(1)} km`,
    reversedTxIds: reversedIds,
  };
}

export async function reconcileKmDrift(opts: {
  appointmentIds?: number[];
  customerIds?: number[];
  apply: boolean;
  toleranceKm?: number;
  userId?: number;
}): Promise<KmReconcileSummary> {
  const toleranceKm = opts.toleranceKm ?? DEFAULT_TOLERANCE_KM;
  const candidates = await findDriftCandidates({
    appointmentIds: opts.appointmentIds,
    customerIds: opts.customerIds,
    toleranceKm,
  });

  const batchId = opts.apply && opts.userId !== undefined && candidates.length > 0
    ? randomUUID()
    : undefined;

  const results: ReconcileResult[] = [];
  let repaired = 0;
  let skipped = 0;
  let errored = 0;

  for (const c of candidates) {
    try {
      const r = await reconcileOne(c, opts.apply, opts.userId, batchId);
      results.push(r);
      if (r.status === "ok") repaired++;
      else if (r.status === "skipped") skipped++;
    } catch (err) {
      errored++;
      results.push({
        appointmentId: c.appointmentId,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
        reversedTxIds: [],
      });
    }
  }

  if (batchId && opts.userId !== undefined) {
    await auditService.log(opts.userId, AUDIT_BATCH_ACTION, "budget", 0, {
      batchId,
      toleranceKm,
      totalCandidates: candidates.length,
      repaired,
      skipped,
      errored,
      appointmentIds: results.filter(r => r.status === "ok").map(r => r.appointmentId),
    });
  }

  return { candidates, results, repaired, skipped, errored, batchId };
}

async function main() {
  const args = parseArgs();
  console.log(`Modus:      ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Toleranz:   ${args.toleranceKm} km`);
  if (args.appointmentIds.length > 0) console.log(`Termine:    ${args.appointmentIds.join(", ")}`);
  if (args.customerIds.length > 0) console.log(`Kunden:     ${args.customerIds.join(", ")}`);

  const summary = await reconcileKmDrift({
    appointmentIds: args.appointmentIds.length > 0 ? args.appointmentIds : undefined,
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
    apply: args.apply,
    toleranceKm: args.toleranceKm,
  });

  console.log(`\nDrift-Kandidaten gefunden: ${summary.candidates.length}`);
  for (const r of summary.results) {
    const c = summary.candidates.find(x => x.appointmentId === r.appointmentId)!;
    console.log(
      `  Termin #${c.appointmentId} (${c.date}, Kunde #${c.customerId}): ${r.status} — ${r.detail}`,
    );
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Repariert:    ${summary.repaired}`);
  console.log(`Übersprungen: ${summary.skipped}`);
  console.log(`Fehler:       ${summary.errored}`);
  if (!args.apply) {
    console.log("\nHinweis: Trockenlauf — keine Änderungen geschrieben. Mit --apply ausführen.");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
