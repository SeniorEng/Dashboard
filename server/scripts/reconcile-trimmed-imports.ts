/**
 * Reconciliation-Skript für Task #116:
 *   Repariert Altdaten-Importe, die fälschlich auf 0 oder weniger Minuten
 *   gekürzt wurden, obwohl im §45b-Topf inklusive Übertrag genug Budget
 *   vorhanden gewesen wäre.
 *
 * Vorgehen pro Kunde:
 *   1. Carryover-Allokationen (source='carryover') normalisieren:
 *      `validFrom` wird auf Jahresanfang des Stichjahres (Carryover.year + 1)
 *      gesetzt, damit der Übertrag auch für rückwirkende Importmonate sichtbar
 *      ist (Ursache 1 aus Task #116).
 *   2. Importierte Termine mit Notiz "Import aus Altdaten — Budget gekürzt: X → Y Min"
 *      bzw. "Budget erschöpft: X → 0 Min" auflisten.
 *   3. Pro Termin prüfen, ob mit korrigierter Logik (Monatscap + Übertrag) genug
 *      Budget verfügbar gewesen wäre, um die Original-Minuten zu buchen.
 *   4. Wenn ja: bestehende Buchungen reversieren, durationPromised /
 *      appointment_services auf Originalminuten setzen, neue Buchung anlegen,
 *      Notiz auf "Import aus Altdaten — Reconciled #116: original X Min wiederhergestellt"
 *      umschreiben.
 *
 * Idempotenz:
 *   - Bereits reconciled Termine ("Reconciled #116" in Notiz) werden übersprungen.
 *   - Reversal nutzt `reversedTransactionId`-UNIQUE-Index → kein Doppel-Storno.
 *   - Carryover-Normalisierung ist no-op, wenn validFrom bereits korrekt gesetzt.
 *
 * Aufruf:
 *   - Trockenlauf:        tsx server/scripts/reconcile-trimmed-imports.ts --customer=<id>
 *   - Scharf ausführen:   tsx server/scripts/reconcile-trimmed-imports.ts --customer=<id> --apply
 *   - Mehrere Kunden:     tsx server/scripts/reconcile-trimmed-imports.ts --customer=12,34 --apply
 */

import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  appointmentServices,
  budgetAllocations,
  budgetTransactions,
  customers,
  services,
} from "@shared/schema";
import { calculateAppointmentCost } from "../storage/budget/appointment-cost-calculator";
import { getAvailableForDate } from "../storage/budget/import-availability";
import { createConsumptionTransaction } from "../storage/budget/consumption-engine";

const TRIM_REGEX = /Budget (gekürzt|erschöpft):\s*(\d+)\s*→\s*(\d+)\s*Min/;
const RECONCILED_MARKER = "Reconciled #116";

interface CandidateAppt {
  id: number;
  customerId: number;
  date: string;
  notes: string | null;
  durationPromised: number | null;
  travelKilometers: number;
  customerKilometers: number;
  performedByEmployeeId: number | null;
  serviceId: number | null;
  serviceCode: string | null;
  originalMinutes: number;
  currentMinutes: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const customerArg = args.find(a => a.startsWith("--customer="));
  const customerIds: number[] = [];
  if (customerArg) {
    const ids = customerArg.split("=")[1].split(",");
    for (const idStr of ids) {
      const n = parseInt(idStr.trim(), 10);
      if (!isNaN(n)) customerIds.push(n);
    }
  }
  return { apply, customerIds };
}

async function normalizeCarryoverValidFrom(customerId: number, apply: boolean): Promise<number> {
  const carryovers = await db.select()
    .from(budgetAllocations)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
    ));

  let updated = 0;
  for (const a of carryovers) {
    // Stichjahr = source-year + 1
    const targetYear = a.year + 1;
    const expectedValidFrom = `${targetYear}-01-01`;
    if (a.validFrom !== expectedValidFrom) {
      console.log(
        `  Carryover #${a.id}: validFrom ${a.validFrom} → ${expectedValidFrom}`,
      );
      if (apply) {
        await db.update(budgetAllocations)
          .set({ validFrom: expectedValidFrom })
          .where(eq(budgetAllocations.id, a.id));
      }
      updated++;
    }
  }
  return updated;
}

async function findCandidates(customerId: number): Promise<CandidateAppt[]> {
  const rows = await db.select({
    id: appointments.id,
    customerId: appointments.customerId,
    date: appointments.date,
    notes: appointments.notes,
    durationPromised: appointments.durationPromised,
    travelKilometers: appointments.travelKilometers,
    customerKilometers: appointments.customerKilometers,
    performedByEmployeeId: appointments.performedByEmployeeId,
  })
    .from(appointments)
    .where(and(
      eq(appointments.customerId, customerId),
      isNull(appointments.deletedAt),
      sql`${appointments.notes} LIKE 'Import aus Altdaten%'`,
    ));

  const candidates: CandidateAppt[] = [];
  for (const r of rows) {
    const notes = r.notes ?? "";
    if (notes.includes(RECONCILED_MARKER)) continue;
    const m = notes.match(TRIM_REGEX);
    if (!m) continue;
    const original = parseInt(m[2], 10);
    const current = parseInt(m[3], 10);
    if (!Number.isFinite(original) || original <= current) continue;

    const apptServices = await db.select({
      serviceId: appointmentServices.serviceId,
      serviceCode: services.code,
    })
      .from(appointmentServices)
      .innerJoin(services, eq(services.id, appointmentServices.serviceId))
      .where(eq(appointmentServices.appointmentId, r.id))
      .limit(1);

    candidates.push({
      id: r.id,
      customerId: r.customerId!,
      date: typeof r.date === "string" ? r.date : String(r.date),
      notes,
      durationPromised: r.durationPromised,
      travelKilometers: r.travelKilometers ?? 0,
      customerKilometers: r.customerKilometers ?? 0,
      performedByEmployeeId: r.performedByEmployeeId,
      serviceId: apptServices[0]?.serviceId ?? null,
      serviceCode: apptServices[0]?.serviceCode ?? null,
      originalMinutes: original,
      currentMinutes: current,
    });
  }
  return candidates;
}

async function reconcileAppointment(c: CandidateAppt, apply: boolean, userId?: number): Promise<{ status: "ok" | "insufficient" | "skipped"; detail: string }> {
  if (!c.serviceCode || !c.serviceId) {
    return { status: "skipped", detail: "kein Service zugeordnet" };
  }
  const isHw = c.serviceCode.toLowerCase() === "hauswirtschaft";

  // Prüfen, ob mit korrigierter Logik genug Budget für die Originalminuten vorhanden wäre.
  // Hierzu rechnen wir die Verfügbarkeit am Termintag aus, addieren aber die aktuelle
  // (gekürzte) Buchung auf den verfügbaren Topf zurück, da diese im Zuge der Reconciliation
  // reversiert wird.
  const existingTxs = await db.select()
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, c.id),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
  const existingConsumedCents = existingTxs.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

  const fullCosts = await calculateAppointmentCost({
    customerId: c.customerId,
    hauswirtschaftMinutes: isHw ? c.originalMinutes : 0,
    alltagsbegleitungMinutes: isHw ? 0 : c.originalMinutes,
    travelKilometers: c.travelKilometers,
    customerKilometers: c.customerKilometers,
    date: c.date,
  });

  const availability = await getAvailableForDate(c.customerId, c.date);
  const effectiveAvailable = availability.totalCents + existingConsumedCents;

  if (fullCosts.totalCents > effectiveAvailable) {
    return {
      status: "insufficient",
      detail: `Originalkosten ${(fullCosts.totalCents / 100).toFixed(2)} € > verfügbar ${(effectiveAvailable / 100).toFixed(2)} €`,
    };
  }

  if (!apply) {
    return {
      status: "ok",
      detail: `Würde wiederherstellen: ${c.currentMinutes} → ${c.originalMinutes} Min (${(fullCosts.totalCents / 100).toFixed(2)} €)`,
    };
  }

  await db.transaction(async (tx) => {
    // 1. Reversal-Buchung pro bestehender Consumption — WICHTIG: Reversal wird auf
    //    das ursprüngliche transactionDate datiert. Die Cascade rechnet Monatscaps
    //    monatsgebunden (consumption[Monat] − reversal[Monat]); ein heute-datiertes
    //    Reversal würde im historischen Importmonat netto nichts abziehen und die
    //    Neubuchung blockieren.
    for (const t of existingTxs) {
      // Idempotenz: existiert bereits ein Reversal für diese Transaktion, überspringen.
      const existingReversal = await tx.select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.reversedTransactionId, t.id),
          eq(budgetTransactions.transactionType, "reversal"),
        ))
        .limit(1);
      if (existingReversal.length > 0) continue;

      await tx.insert(budgetTransactions).values({
        customerId: t.customerId,
        budgetType: t.budgetType,
        transactionDate: t.transactionDate,
        transactionType: "reversal",
        amountCents: -t.amountCents,
        appointmentId: null,
        allocationId: t.allocationId,
        reversedTransactionId: t.id,
        notes: `Storno (Reconcile #116) von Transaktion #${t.id}`,
        createdByUserId: userId,
      }).onConflictDoNothing();
    }

    // 2. Alte Consumptions vom Termin abkoppeln (appointmentId=null), damit der
    //    Pre-Check in createCascadeConsumption für den Termin keine offene Zeile
    //    mehr sieht. Reversal-Verknüpfung über reversedTransactionId bleibt erhalten.
    await tx.update(budgetTransactions)
      .set({ appointmentId: null })
      .where(and(
        eq(budgetTransactions.appointmentId, c.id),
        inArray(budgetTransactions.id, existingTxs.map(t => t.id)),
      ));

    // 3. Termin-Daten auf Originalminuten zurücksetzen.
    await tx.update(appointments)
      .set({
        durationPromised: c.originalMinutes,
        notes: `Import aus Altdaten — ${RECONCILED_MARKER}: ${c.currentMinutes} → ${c.originalMinutes} Min wiederhergestellt`,
      })
      .where(eq(appointments.id, c.id));

    await tx.update(appointmentServices)
      .set({
        plannedDurationMinutes: c.originalMinutes,
        actualDurationMinutes: c.originalMinutes,
      })
      .where(eq(appointmentServices.appointmentId, c.id));

    // 4. Neue Buchung mit Originalminuten am ursprünglichen Datum.
    await createConsumptionTransaction({
      customerId: c.customerId,
      appointmentId: c.id,
      transactionDate: c.date,
      hauswirtschaftMinutes: isHw ? c.originalMinutes : 0,
      alltagsbegleitungMinutes: isHw ? 0 : c.originalMinutes,
      travelKilometers: c.travelKilometers,
      customerKilometers: c.customerKilometers,
      userId,
    }, tx);
  });

  return { status: "ok", detail: `Wiederhergestellt: ${c.currentMinutes} → ${c.originalMinutes} Min` };
}

export async function reconcileCustomer(customerId: number, apply: boolean) {
  const [customer] = await db.select({ vorname: customers.vorname, nachname: customers.nachname })
    .from(customers).where(eq(customers.id, customerId)).limit(1);
  const name = customer ? `${customer.vorname} ${customer.nachname}` : `#${customerId}`;
  console.log(`\n=== Kunde ${name} (#${customerId}) ===`);

  const carryoverChanges = await normalizeCarryoverValidFrom(customerId, apply);
  if (carryoverChanges > 0) {
    console.log(`  Carryover-validFrom normalisiert: ${carryoverChanges} Eintrag/Einträge`);
  } else {
    console.log(`  Carryover-validFrom: bereits korrekt`);
  }

  const candidates = await findCandidates(customerId);
  console.log(`  Kandidaten (gekürzte Importe): ${candidates.length}`);

  let restored = 0;
  let insufficient = 0;
  let skipped = 0;

  for (const c of candidates) {
    const result = await reconcileAppointment(c, apply);
    const prefix = `  Termin #${c.id} ${c.date}:`;
    if (result.status === "ok") {
      restored++;
      console.log(`${prefix} ${result.detail}`);
    } else if (result.status === "insufficient") {
      insufficient++;
      console.log(`${prefix} übersprungen (${result.detail})`);
    } else {
      skipped++;
      console.log(`${prefix} übersprungen (${result.detail})`);
    }
  }

  console.log(`  Zusammenfassung: ${restored} wiederhergestellt, ${insufficient} unzureichend, ${skipped} übersprungen`);
  return { restored, insufficient, skipped };
}

async function main() {
  const { apply, customerIds } = parseArgs();
  if (customerIds.length === 0) {
    console.error("Fehler: --customer=<id>[,<id>...] erforderlich.");
    process.exit(1);
  }
  console.log(`Modus: ${apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Kunden: ${customerIds.join(", ")}`);

  let totals = { restored: 0, insufficient: 0, skipped: 0 };
  for (const id of customerIds) {
    const r = await reconcileCustomer(id, apply);
    totals.restored += r.restored;
    totals.insufficient += r.insufficient;
    totals.skipped += r.skipped;
  }

  console.log(`\n=== Gesamt ===`);
  console.log(`Wiederhergestellt: ${totals.restored}`);
  console.log(`Unzureichend (Budget reicht weiterhin nicht): ${totals.insufficient}`);
  console.log(`Übersprungen: ${totals.skipped}`);
  if (!apply) {
    console.log("\nHinweis: Trockenlauf — keine Änderungen geschrieben. Mit --apply ausführen, um zu schreiben.");
  }
  process.exit(0);
}

// Nur ausführen, wenn dieses Modul direkt gestartet wird (z.B. via tsx).
// Beim Import in Tests soll main() NICHT laufen.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
