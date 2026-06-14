/**
 * Reconciliation-Skript für Task #611 / #616 / #619:
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
 * Task #619 — kontrollierte Storno+Neuanlage durch Superadmin:
 *   - Der Boot-Audit (`server/startup/audit-appointment-budget-km-drift.ts`,
 *     Task #616) listet betroffene Bestandsbuchungen nur — schreibt aus
 *     GoBD-Gründen NICHTS. Dieses Skript ist die kontrollierte Korrektur:
 *     erfordert beim --apply einen Superadmin-User und eine Begründung,
 *     die im Audit-Eintrag `budget_transaction_corrected` landet.
 *   - Bereits geschlossene Monate werden NICHT stillschweigend geöffnet —
 *     standardmäßig wird der Termin übersprungen und in der Übersicht
 *     gemeldet. Mit --allow-closed-months entscheidet der Superadmin
 *     ausdrücklich pro Lauf, dass auch geschlossene Monate korrigiert
 *     werden (z.B. wenn der Monat danach manuell wieder geschlossen wird).
 *
 * Vorgehen pro Termin (Drift > Toleranz):
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
 *   5. Audit-Eintrag `budget_transaction_corrected` pro Termin + Sammel-
 *      Audit `budget_transaction_corrected_batch` pro Lauf (mit batchId und
 *      Begründung).
 *
 * GoBD: Storno + Neu-Anlage statt UPDATE — die Historie bleibt vollständig
 * sichtbar (alte Tx + Reversal + Neue Tx).
 *
 * Idempotenz:
 *   - `reversedTransactionId`-UNIQUE-Index verhindert Doppel-Storno.
 *   - Re-Lauf: ein zweiter Aufruf findet keine driftenden Termine mehr,
 *     weil die alten Txs ihre `appointmentId` verloren haben und die neue
 *     Buchung die korrekten km hat. Der Boot-Audit ist danach leer.
 *
 * Aufruf:
 *   Trockenlauf:        tsx server/scripts/reconcile-km-drift.ts
 *   Bestimmte Termine:  tsx server/scripts/reconcile-km-drift.ts --appointment=39,57
 *   Bestimmter Kunde:   tsx server/scripts/reconcile-km-drift.ts --customer=12
 *   Toleranz anpassen:  tsx server/scripts/reconcile-km-drift.ts --tolerance=0.5
 *   Scharf ausführen:   tsx server/scripts/reconcile-km-drift.ts --apply \
 *                          --user=<superadmin-id> --reason="Schröder km-Drift #619"
 *   Inkl. geschlossener Monate:
 *                       … --allow-closed-months
 */

import { randomUUID } from "node:crypto";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  budgetTransactions,
  users,
} from "@shared/schema";
import { createConsumptionTransaction } from "../storage/budget/consumption-engine";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { auditService } from "../services/audit";

// Auf 0,05 km gesetzt, damit das Skript mindestens alles abdeckt, was der
// Boot-Audit (`audit-appointment-budget-km-drift.ts`) flaggt. Sonst bliebe
// die Schwelle 0,15 km > 0,05 km, und es blieben Drift-Fälle übrig, die
// der Boot-Audit beim nächsten Re-Deploy wieder meldet (#619 verlangt
// einen sauberen Re-Boot).
const DEFAULT_TOLERANCE_KM = 0.05;
const AUDIT_ACTION = "budget_transaction_corrected";
const AUDIT_BATCH_ACTION = "budget_transaction_corrected_batch";

interface CliArgs {
  apply: boolean;
  appointmentIds: number[];
  customerIds: number[];
  toleranceKm: number;
  userId?: number;
  reason?: string;
  allowClosedMonths: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowClosedMonths = args.includes("--allow-closed-months");
  const apptArg = args.find(a => a.startsWith("--appointment="));
  const customerArg = args.find(a => a.startsWith("--customer="));
  const tolArg = args.find(a => a.startsWith("--tolerance="));
  const userArg = args.find(a => a.startsWith("--user="));
  const reasonArg = args.find(a => a.startsWith("--reason="));

  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s.split("=")[1].split(",")
      .map(x => parseInt(x.trim(), 10))
      .filter(n => !isNaN(n));
  };

  const toleranceKm = tolArg ? parseFloat(tolArg.split("=")[1]) : DEFAULT_TOLERANCE_KM;
  const userId = userArg ? parseInt(userArg.split("=")[1], 10) : undefined;
  const reason = reasonArg ? reasonArg.split("=").slice(1).join("=").trim() : undefined;

  return {
    apply,
    appointmentIds: parseIds(apptArg),
    customerIds: parseIds(customerArg),
    toleranceKm: Number.isFinite(toleranceKm) && toleranceKm >= 0 ? toleranceKm : DEFAULT_TOLERANCE_KM,
    userId: userId !== undefined && !isNaN(userId) ? userId : undefined,
    reason: reason && reason.length > 0 ? reason : undefined,
    allowClosedMonths,
  };
}

export interface DriftCandidate {
  appointmentId: number;
  customerId: number;
  date: string;
  assignedEmployeeId: number | null;
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
    assignedEmployeeId: appointments.assignedEmployeeId,
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
      assignedEmployeeId: a.assignedEmployeeId ?? null,
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
  monthClosed?: boolean;
}

export interface KmReconcileSummary {
  candidates: DriftCandidate[];
  results: ReconcileResult[];
  repaired: number;
  skipped: number;
  errored: number;
  closedMonthSkipped: number;
  batchId?: string;
}

async function reconcileOne(
  c: DriftCandidate,
  apply: boolean,
  userId: number | undefined,
  batchId: string | undefined,
  reason: string | undefined,
  allowClosedMonths: boolean,
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

  // Closed-Month-Schutz (Task #619): Termin-Monat darf nicht stillschweigend
  // überschrieben werden. Geprüft wird gegen den zugewiesenen Mitarbeiter
  // des Termins; wenn keiner gesetzt ist, wird die Buchung als „offen"
  // betrachtet (kein Monatsabschluss möglich ohne assignedEmployeeId).
  let monthClosed = false;
  if (c.assignedEmployeeId !== null) {
    monthClosed = await isMonthClosed(c.assignedEmployeeId, c.date);
  }
  if (monthClosed && !allowClosedMonths) {
    return {
      appointmentId: c.appointmentId,
      status: "skipped",
      detail:
        `Monat von Mitarbeiter #${c.assignedEmployeeId} für ${c.date} ist geschlossen — ` +
        `Korrektur übersprungen. Mit --allow-closed-months ausdrücklich erlauben.`,
      reversedTxIds: [],
      monthClosed: true,
    };
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
        `(hw=${hwSum} min, ab=${abSum} min)` +
        (monthClosed ? ` [Monat geschlossen — wird wegen --allow-closed-months einbezogen]` : ""),
      reversedTxIds: existingTxs.map(t => t.id),
      monthClosed,
    };
  }

  const reversedIds: number[] = [];
  const noteSuffix = reason ? ` — Grund: ${reason}` : "";

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

      // Task #819 (GoBD): Reversal behält die appointmentId der Original-
      // Consumption (keine appointmentId=null-Waisen mehr). Der Pre-Check in
      // createCascadeConsumption sieht die stornierte Zeile nicht mehr, weil
      // getTransactionByAppointmentId reversedTransactionId-Stornos ausblendet.
      const [rev] = await tx.insert(budgetTransactions).values({
        customerId: orig.customerId,
        budgetType: orig.budgetType,
        transactionDate: orig.transactionDate,
        transactionType: "reversal",
        amountCents: -orig.amountCents,
        appointmentId: orig.appointmentId,
        allocationId: orig.allocationId,
        reversedTransactionId: orig.id,
        notes: `Storno (km-Drift-Korrektur #619) von Transaktion #${orig.id}${noteSuffix}`,
        createdByUserId: userId,
      })
        .onConflictDoNothing()
        .returning();
      if (rev) reversedIds.push(orig.id);
    }

    // 1b. Original-Consumptions vom Termin abkoppeln (Task #823): sonst hängen
    //     stornierte Alt-Zeile UND Neu-Buchung am selben Termin und jede naive
    //     `type='consumption' AND appointmentId=X`-Aggregation (Drift-Detektor,
    //     Re-Lauf-Idempotenz) zählt doppelt. Reversal-Zeilen behalten ihre
    //     appointmentId (Audit-Trail); die stornierte Buchung bleibt über
    //     `reversedTransactionId` rückführbar.
    // Task #1273: budget_transactions ist seit Stufe B GoBD-immutable
    // (BEFORE-Trigger) — Bypass transaktions-lokal freischalten.
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx.update(budgetTransactions)
      .set({ appointmentId: null })
      .where(inArray(budgetTransactions.id, existingTxs.map(t => t.id)));

    // 2. Neu-Buchung mit AKTUELLEM appt-km am ursprünglichen Datum.
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
      assignedEmployeeId: c.assignedEmployeeId,
      previousTravelKm: c.txTravelKmSum,
      newTravelKm: c.apptTravelKm,
      previousCustomerKm: c.txCustomerKmSum,
      newCustomerKm: c.apptCustomerKm,
      reversedTransactionIds: reversedIds,
      reason: reason ?? null,
      monthClosedAtCorrection: monthClosed,
      ...(batchId ? { batchId } : {}),
    });
  }

  return {
    appointmentId: c.appointmentId,
    status: "ok",
    detail:
      `Storno + neu angelegt: travel ${c.txTravelKmSum.toFixed(1)}→${c.apptTravelKm.toFixed(1)} km, ` +
      `customer ${c.txCustomerKmSum.toFixed(1)}→${c.apptCustomerKm.toFixed(1)} km` +
      (monthClosed ? ` [im geschlossenen Monat korrigiert]` : ""),
    reversedTxIds: reversedIds,
    monthClosed,
  };
}

export async function reconcileKmDrift(opts: {
  appointmentIds?: number[];
  customerIds?: number[];
  apply: boolean;
  toleranceKm?: number;
  userId?: number;
  reason?: string;
  allowClosedMonths?: boolean;
}): Promise<KmReconcileSummary> {
  const toleranceKm = opts.toleranceKm ?? DEFAULT_TOLERANCE_KM;
  const allowClosedMonths = opts.allowClosedMonths ?? false;
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
  let closedMonthSkipped = 0;

  for (const c of candidates) {
    try {
      const r = await reconcileOne(c, opts.apply, opts.userId, batchId, opts.reason, allowClosedMonths);
      results.push(r);
      if (r.status === "ok") repaired++;
      else if (r.status === "skipped") {
        skipped++;
        if (r.monthClosed) closedMonthSkipped++;
      }
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
      reason: opts.reason ?? null,
      allowClosedMonths,
      totalCandidates: candidates.length,
      repaired,
      skipped,
      closedMonthSkipped,
      errored,
      appointmentIds: results.filter(r => r.status === "ok").map(r => r.appointmentId),
      skippedClosedAppointmentIds: results
        .filter(r => r.status === "skipped" && r.monthClosed)
        .map(r => r.appointmentId),
    });
  }

  return { candidates, results, repaired, skipped, closedMonthSkipped, errored, batchId };
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db.select({
    id: users.id,
    isSuperAdmin: users.isSuperAdmin,
    isActive: users.isActive,
    displayName: users.displayName,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `km-Drift-Korrekturen sind Task #619 explizit auf Superadmins beschränkt.`,
    );
  }
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error("Fehler: --apply erfordert --reason=\"...\" (≥10 Zeichen Begründung für den Audit-Log).");
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`Modus:               ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Toleranz:            ${args.toleranceKm} km`);
  console.log(`Geschlossene Monate: ${args.allowClosedMonths ? "EINBEZIEHEN (--allow-closed-months)" : "überspringen"}`);
  if (args.userId !== undefined) console.log(`Superadmin (User-ID): ${args.userId}`);
  if (args.reason) console.log(`Begründung:          ${args.reason}`);
  if (args.appointmentIds.length > 0) console.log(`Termine:             ${args.appointmentIds.join(", ")}`);
  if (args.customerIds.length > 0) console.log(`Kunden:              ${args.customerIds.join(", ")}`);

  const summary = await reconcileKmDrift({
    appointmentIds: args.appointmentIds.length > 0 ? args.appointmentIds : undefined,
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
    apply: args.apply,
    toleranceKm: args.toleranceKm,
    userId: args.userId,
    reason: args.reason,
    allowClosedMonths: args.allowClosedMonths,
  });

  console.log(`\nDrift-Kandidaten gefunden: ${summary.candidates.length}`);
  for (const r of summary.results) {
    const c = summary.candidates.find(x => x.appointmentId === r.appointmentId)!;
    console.log(
      `  Termin #${c.appointmentId} (${c.date}, Kunde #${c.customerId}, MA #${c.assignedEmployeeId ?? "—"}): ${r.status} — ${r.detail}`,
    );
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Repariert:                  ${summary.repaired}`);
  console.log(`Übersprungen (gesamt):      ${summary.skipped}`);
  console.log(`  davon geschlossener Monat: ${summary.closedMonthSkipped}`);
  console.log(`Fehler:                     ${summary.errored}`);
  if (summary.batchId) console.log(`Audit-Batch-ID:             ${summary.batchId}`);
  if (!args.apply) {
    console.log("\nHinweis: Trockenlauf — keine Änderungen geschrieben. Mit --apply --user=<id> --reason=\"…\" ausführen.");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
