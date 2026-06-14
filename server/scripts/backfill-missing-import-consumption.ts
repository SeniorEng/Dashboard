/**
 * Task #1190 — Erstbuchung fehlender Import-Consumption (Bestandskorrektur).
 *
 * Hintergrund:
 *   Der Excel-Import-Update-Pfad (`executeImport` → `action === "update"`)
 *   koppelte das Budget bisher ausschließlich über
 *   `rebookAppointmentConsumption` (Storno + Neuanlage). Dieser Rebook ist
 *   per Definition ein No-Op, wenn es für den Termin noch GAR KEINE
 *   `budget_transactions`-Consumption gibt. Folge: ein `completed` Termin,
 *   der bei einem früheren Import-Lauf nur als Datensatz angelegt wurde
 *   (ohne Budget-Buchung) und danach per Update erneut „angefasst" wurde,
 *   blieb ohne jede Consumption — das Budget des Kunden zeigt zu viel
 *   Restguthaben (z.B. Kunde #88 „Wolf, Jens": ~784 € statt ~1.148 €).
 *
 *   Der Code-Fix in `executeImport` schließt die Lücke für künftige Importe.
 *   Dieses Skript korrigiert den BESTAND: es findet abgeschlossene, nicht
 *   soft-gelöschte Termine ganz OHNE Consumption-Tx und bucht die fehlende
 *   Consumption erstmalig über `createConsumptionTransaction` (inkl.
 *   §45b-FIFO/Kaskade) — append-only, idempotent und GoBD-auditiert.
 *
 * Idempotenz:
 *   - Selektiert NUR Termine ohne jegliche Consumption-Tx. Ein Termin, der
 *     bereits (z.B. durch einen vorherigen Lauf) eine Consumption hat, wird
 *     nicht mehr gefunden — ein zweiter Lauf ist daher ein No-Op.
 *   - Vor der Buchung wird INNERHALB der Termin-Transaktion erneut geprüft,
 *     dass keine Consumption existiert (Schutz gegen Doppelbuchung bei
 *     paralleler Ausführung).
 *
 * Aufruf:
 *   Trockenlauf (Report):  tsx server/scripts/backfill-missing-import-consumption.ts
 *   Nur ein Batch:         … --batch=4
 *   Nur ein Kunde:         … --customer=88
 *   CSV-Export:            … --csv=tmp/missing-consumption.csv
 *   Scharf:                … --apply --user=<superadmin-id> --reason="Nachbuchung fehlende Import-Consumption Batch 4"
 *   Inkl. geschl. Monate:  … --apply … --allow-closed-months
 *
 * GoBD-Schutz (analog `reconcile-import-from-excel.ts`):
 *   - Default ist Trockenlauf (kein Schreibzugriff).
 *   - `--apply` erfordert `--user=<superadmin-id>` + `--reason="…"` (≥10 Zeichen).
 *   - Hostname-Guard: bricht ab, wenn der DB-Host nach Produktion aussieht.
 *   - Geschlossene Monate werden ohne `--allow-closed-months` übersprungen.
 */

import { writeFileSync } from "node:fs";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  budgetTransactions,
  customers,
  users,
} from "@shared/schema";
import { budgetStorage } from "../storage/budget-storage";
import { calculateAppointmentCost } from "../storage/budget/appointment-cost-calculator";
import { loadCurrentServiceMinutes } from "../storage/budget/km-rebook";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import { isMonthClosed } from "../storage/time-tracking/month-closing";
import { auditService } from "../services/audit";

interface CliArgs {
  apply: boolean;
  userId?: number;
  reason?: string;
  csvPath?: string;
  customerIds: number[];
  batchId?: number;
  allowClosedMonths: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (prefix: string): string | undefined => {
    const a = args.find((x) => x.startsWith(prefix));
    if (!a) return undefined;
    const v = a.split("=").slice(1).join("=").trim();
    return v.length > 0 ? v : undefined;
  };
  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
  };
  const userStr = get("--user=");
  const userId = userStr ? parseInt(userStr, 10) : undefined;
  const batchStr = get("--batch=");
  const batchId = batchStr ? parseInt(batchStr, 10) : undefined;
  return {
    apply: args.includes("--apply"),
    userId: userId !== undefined && !isNaN(userId) ? userId : undefined,
    reason: get("--reason="),
    csvPath: get("--csv="),
    customerIds: parseIds(get("--customer=")),
    batchId: batchId !== undefined && !isNaN(batchId) ? batchId : undefined,
    allowClosedMonths: args.includes("--allow-closed-months"),
  };
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ABBRUCH: NODE_ENV=production. Dieses Skript darf nie auf Produktion laufen.",
    );
  }
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/@([^:/?#]+)/);
    host = (m ? m[1] : "").toLowerCase();
  }
  if (host && /(^|[.-])prod([.-]|$)|production/.test(host)) {
    throw new Error(
      `ABBRUCH: DB-Host '${host}' sieht nach Produktion aus. Dieses Skript darf nie auf Produktion laufen.`,
    );
  }
  console.log(`Sicherheits-Check ok. DB-Host: ${host || "(unbekannt)"}`);
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Bestandskorrektur ist auf Superadmins beschränkt.`,
    );
  }
}

export interface MissingConsumptionRow {
  appointmentId: number;
  customerId: number;
  customerName: string;
  date: string;
  employeeId: number | null;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  travelKilometers: number;
  customerKilometers: number;
  expectedCostCents: number;
  importBatchId: number | null;
}

/**
 * Findet abgeschlossene, nicht soft-gelöschte Termine, die KEINE
 * Consumption-Tx haben. Reine Reads — keine Mutation.
 */
export async function findMissingConsumptionAppointments(opts: {
  customerIds?: number[];
  batchId?: number;
  /**
   * Nur Termine, die aus einem Excel-Import stammen (`import_batch_id IS NOT
   * NULL`). Genutzt vom automatischen Startup-Backfill, der ausschließlich die
   * Import-Population korrigiert (nicht jeden beliebigen Termin ohne
   * Consumption).
   */
  onlyImported?: boolean;
} = {}): Promise<MissingConsumptionRow[]> {
  const conditions = [
    isNull(appointments.deletedAt),
    eq(appointments.status, "completed"),
    // Kein Consumption-Eintrag (egal ob live oder storniert) — ein Termin
    // mit storniertem Bestand wird vom Rebook-Pfad abgedeckt, nicht hier.
    sql`NOT EXISTS (
      SELECT 1 FROM ${budgetTransactions} bt
      WHERE bt.appointment_id = ${appointments.id}
        AND bt.transaction_type = 'consumption'
    )`,
    // Nur Selbstzahler-Ausschluss NICHT nötig: Selbstzahler bekommen ebenso
    // eine Consumption (uncapped Privattopf). Fehlt sie, ist das ebenfalls
    // ein Bestandsfehler.
  ];
  if (opts.customerIds && opts.customerIds.length > 0) {
    conditions.push(inArray(appointments.customerId, opts.customerIds));
  }
  if (opts.batchId !== undefined) {
    conditions.push(eq(appointments.importBatchId, opts.batchId));
  }
  if (opts.onlyImported) {
    conditions.push(sql`${appointments.importBatchId} IS NOT NULL`);
  }

  const rows = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      customerName: customers.name,
      date: appointments.date,
      employeeId: appointments.performedByEmployeeId,
      assignedEmployeeId: appointments.assignedEmployeeId,
      travelKilometers: appointments.travelKilometers,
      customerKilometers: appointments.customerKilometers,
      importBatchId: appointments.importBatchId,
    })
    .from(appointments)
    .innerJoin(customers, eq(appointments.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(appointments.customerId, appointments.date, appointments.id);

  const result: MissingConsumptionRow[] = [];
  for (const r of rows) {
    if (r.customerId == null) continue;
    const dateStr = typeof r.date === "string" ? r.date : String(r.date);
    const { hwMinutes, abMinutes } = await loadCurrentServiceMinutes(r.id, db);
    const travelKm = r.travelKilometers ?? 0;
    const customerKm = r.customerKilometers ?? 0;

    let expectedCostCents = 0;
    try {
      const costs = await calculateAppointmentCost({
        customerId: r.customerId,
        hauswirtschaftMinutes: hwMinutes,
        alltagsbegleitungMinutes: abMinutes,
        travelKilometers: travelKm,
        customerKilometers: customerKm,
        date: dateStr,
      });
      expectedCostCents = costs.totalCents;
    } catch {
      // Kostenschätzung nur fürs Reporting — Fehler hier dürfen die
      // Diagnose nicht abbrechen.
    }

    result.push({
      appointmentId: r.id,
      customerId: r.customerId,
      customerName: r.customerName ?? `#${r.customerId}`,
      date: dateStr,
      employeeId: r.employeeId ?? r.assignedEmployeeId ?? null,
      hauswirtschaftMinutes: hwMinutes,
      alltagsbegleitungMinutes: abMinutes,
      travelKilometers: travelKm,
      customerKilometers: customerKm,
      expectedCostCents,
      importBatchId: r.importBatchId,
    });
  }
  return result;
}

export interface BackfillOutcome {
  appointmentId: number;
  status: "booked" | "skipped" | "noop" | "error";
  detail: string;
}

/**
 * Bucht die fehlende Consumption für genau EINEN Termin erstmalig nach.
 * Append-only: keine Storno-/Update-Pfade, nur eine neue Consumption +
 * Audit-Eintrag in einer gemeinsamen Transaktion.
 */
export async function backfillOne(
  row: MissingConsumptionRow,
  userId: number,
  reason: string,
  allowClosedMonths: boolean,
): Promise<BackfillOutcome> {
  let monthClosed = false;
  if (row.employeeId != null) {
    monthClosed = await isMonthClosed(row.employeeId, row.date);
  }
  if (monthClosed && !allowClosedMonths) {
    return {
      appointmentId: row.appointmentId,
      status: "skipped",
      detail: `Monat von Mitarbeiter #${row.employeeId} für ${row.date} ist geschlossen — mit --allow-closed-months ausdrücklich erlauben.`,
    };
  }

  try {
    const booked = await db.transaction(async (tx) => {
      // Idempotenz-Re-Check INNERHALB der Tx: existiert inzwischen doch eine
      // Consumption, nichts tun (Schutz gegen parallele Läufe).
      const existing = await tx
        .select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(and(
          eq(budgetTransactions.appointmentId, row.appointmentId),
          eq(budgetTransactions.transactionType, "consumption"),
        ))
        .limit(1);
      if (existing.length > 0) return false;

      await budgetStorage.createConsumptionTransaction(
        {
          customerId: row.customerId,
          appointmentId: row.appointmentId,
          transactionDate: row.date,
          hauswirtschaftMinutes: row.hauswirtschaftMinutes,
          alltagsbegleitungMinutes: row.alltagsbegleitungMinutes,
          travelKilometers: row.travelKilometers,
          customerKilometers: row.customerKilometers,
          userId,
        },
        tx,
      );

      // Erzeugte Consumption (Kaskade über mehrere Töpfe möglich) mit dem
      // Import-Batch des Termins verknüpfen, falls vorhanden.
      if (row.importBatchId != null) {
        // Task #1273: budget_transactions ist seit Stufe B GoBD-immutable
        // (BEFORE-Trigger) — Bypass transaktions-lokal freischalten.
        await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
        await tx
          .update(budgetTransactions)
          .set({ importBatchId: row.importBatchId })
          .where(eq(budgetTransactions.appointmentId, row.appointmentId));
      }

      await auditService.log(
        userId,
        "appointment_km_rebooked",
        "appointment",
        row.appointmentId,
        {
          customerId: row.customerId,
          trigger: REBOOK_TRIGGERS.import.backfill,
          firstTimeBooking: true,
          source: "backfill-missing-import-consumption",
          reason,
          monthClosedAtCorrection: monthClosed,
          transactionDate: row.date,
          hauswirtschaftMinutes: row.hauswirtschaftMinutes,
          alltagsbegleitungMinutes: row.alltagsbegleitungMinutes,
          travelKilometers: row.travelKilometers,
          customerKilometers: row.customerKilometers,
          expectedCostCents: row.expectedCostCents,
          importBatchId: row.importBatchId,
        },
        undefined,
        tx,
      );

      return true;
    });

    if (!booked) {
      return {
        appointmentId: row.appointmentId,
        status: "noop",
        detail: "Consumption existierte bereits (idempotenter Re-Check) — übersprungen.",
      };
    }
    return {
      appointmentId: row.appointmentId,
      status: "booked",
      detail:
        `Consumption nachgebucht (${row.hauswirtschaftMinutes}min HW / ` +
        `${row.alltagsbegleitungMinutes}min AB / ${row.travelKilometers.toFixed(2)}km, ` +
        `≈ ${(row.expectedCostCents / 100).toFixed(2)} €)` +
        (monthClosed ? " [im geschlossenen Monat]" : ""),
    };
  } catch (err) {
    return {
      appointmentId: row.appointmentId,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function toCsv(rows: MissingConsumptionRow[]): string {
  const header = [
    "appointmentId", "customerId", "customerName", "date", "employeeId",
    "hauswirtschaftMinutes", "alltagsbegleitungMinutes",
    "travelKilometers", "customerKilometers", "expectedCostEuro", "importBatchId",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.appointmentId, r.customerId, `"${r.customerName.replace(/"/g, '""')}"`, r.date,
      r.employeeId ?? "",
      r.hauswirtschaftMinutes, r.alltagsbegleitungMinutes,
      r.travelKilometers.toFixed(2), r.customerKilometers.toFixed(2),
      (r.expectedCostCents / 100).toFixed(2), r.importBatchId ?? "",
    ].join(","));
  }
  return lines.join("\n");
}

function summarizeByCustomer(rows: MissingConsumptionRow[]): string[] {
  const byCust = new Map<number, { name: string; total: number; cents: number }>();
  for (const r of rows) {
    const acc = byCust.get(r.customerId) ?? { name: r.customerName, total: 0, cents: 0 };
    acc.total++;
    acc.cents += r.expectedCostCents;
    byCust.set(r.customerId, acc);
  }
  const out: string[] = [];
  for (const [cid, info] of byCust) {
    out.push(
      `  Kunde #${cid} (${info.name}): ${info.total} Termin(e) ohne Consumption, ` +
        `≈ ${(info.cents / 100).toFixed(2)} € nachzubuchen`,
    );
  }
  return out;
}

async function main() {
  const args = parseArgs();
  assertNotProduction();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`Modus:               ${args.apply ? "SCHARF (--apply)" : "Trockenlauf"}`);
  console.log(`Geschlossene Monate: ${args.allowClosedMonths ? "EINBEZIEHEN (--allow-closed-months)" : "überspringen"}`);
  if (args.batchId !== undefined) console.log(`Import-Batch:         #${args.batchId}`);
  if (args.customerIds.length > 0) console.log(`Kunden:              ${args.customerIds.join(", ")}`);
  if (args.userId !== undefined) console.log(`Superadmin (User-ID): ${args.userId}`);
  if (args.reason) console.log(`Begründung:          ${args.reason}`);

  const rows = await findMissingConsumptionAppointments({
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
    batchId: args.batchId,
  });

  console.log(`\nTermine ohne Consumption gefunden: ${rows.length}`);
  const totalCents = rows.reduce((s, r) => s + r.expectedCostCents, 0);
  console.log(`Geschätzte Σ-Nachbuchung: ${(totalCents / 100).toFixed(2)} €`);

  if (rows.length > 0) {
    console.log(`\n--- Details ---`);
    for (const r of rows) {
      console.log(
        `  appt#${r.appointmentId} (${r.date}, Kunde #${r.customerId} ${r.customerName}): ` +
          `${r.hauswirtschaftMinutes}min HW / ${r.alltagsbegleitungMinutes}min AB / ` +
          `${r.travelKilometers.toFixed(2)}km ≈ ${(r.expectedCostCents / 100).toFixed(2)} €` +
          (r.importBatchId != null ? ` [Batch #${r.importBatchId}]` : ""),
      );
    }
    console.log(`\n--- Pro Kunde ---`);
    for (const line of summarizeByCustomer(rows)) console.log(line);
  }

  if (args.csvPath) {
    writeFileSync(args.csvPath, toCsv(rows), "utf8");
    console.log(`\nCSV geschrieben: ${args.csvPath}`);
  }

  if (!args.apply) {
    console.log(`\nHinweis: Trockenlauf — keine Änderungen geschrieben.`);
    console.log(`Mit --apply --user=<superadmin-id> --reason="…" scharf ausführen.`);
    process.exit(0);
  }

  console.log(`\n--- Apply ---`);
  let booked = 0, noop = 0, skipped = 0, errored = 0;
  for (const r of rows) {
    const out = await backfillOne(r, args.userId!, args.reason!, args.allowClosedMonths);
    console.log(`  appt#${out.appointmentId}: ${out.status} — ${out.detail}`);
    if (out.status === "booked") booked++;
    else if (out.status === "noop") noop++;
    else if (out.status === "skipped") skipped++;
    else errored++;
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Nachgebucht:          ${booked}`);
  console.log(`No-Op (schon da):     ${noop}`);
  console.log(`Übersprungen:         ${skipped}`);
  console.log(`Fehler:               ${errored}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
