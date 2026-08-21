/**
 * Task #1651 — GoBD-konforme Reparatur: Termine, die NACH der Abrechnung
 * (Siegel = Rechnung erstellt / Leistungsnachweis signiert) durch einen
 * Vor-Guard-Excel-Import STILL mutiert bzw. neu-verbucht wurden.
 *
 * Erkennung (SSoT) — NICHT dupliziert
 * -----------------------------------
 * Die Erkennung liegt komplett in `findBilledImportDriftRows`
 * (`server/scripts/audit-billed-appointment-import-drift.ts`, Task #1649).
 * Dieses Skript KONSUMIERT sie und baut darauf die Korrektur auf; es gibt keine
 * zweite Drift-Heuristik.
 *
 * Korrektur = „Storno + Neuausstellung" (append-only) — NIE In-Place-Mutation
 * ------------------------------------------------------------------------------
 * Ein versiegeltes Artefakt (Rechnung / signierter LN) wird niemals editiert.
 *   (b) Rechnungs-Schutz → die versiegelte Rechnung wird über den EINEN
 *       gemeinsamen Storno-Pfad `stornoInvoiceCascade`
 *       (`server/services/invoice-storno.ts`, dieselbe SSoT wie die Route
 *       `PATCH /api/billing/:id/status`) inkl. `billing_run_id`-Cascade und
 *       pot-bewusster Budget-Reversierung storniert. Anschließend wird der
 *       betroffene Abrechnungs-Monat via `generateInvoiceCore` NEU ausgestellt
 *       (bucht die frei gewordenen Netto-Null-Termine frisch → Rechnung ==
 *       Ledger).
 *   (a) LN-Schutz → der signierte Leistungsnachweis wird GoBD-konform
 *       soft-storniert (`deleted_at` + `service_record_deleted`-Audit mit
 *       Begründung). Ein neuer LN wird BEWUSST NICHT automatisch erzeugt —
 *       automatischer LN-Reset ist nicht GoBD-konform (Task #576). Der Termin
 *       wird damit zur manuellen Neu-Dokumentation freigegeben und im Report
 *       ausgewiesen.
 *
 * Sicherheits-Gates (analog reconcile-phantom-pot-invoices.ts, Task #1016)
 * -----------------------------------------------------------------------
 *   - Trockenlauf ist Default; nur `--apply` schreibt.
 *   - `--apply` erfordert ZUSÄTZLICH:
 *       · `--user=<superadmin-id>`   Audit-Attribution, nur Superadmins.
 *       · `--reason="…"`             ≥10 Zeichen, landet in jedem Audit-Eintrag.
 *       · `--appointment=<id>[,…]`   EXPLIZITE, mit Alrik bestätigte Fall-Liste.
 *                                    KEIN Blind-Bulk über alle Treffer — nur
 *                                    Termine, die auf dieser Allowlist stehen,
 *                                    werden repariert.
 *       · Prod-DB-Guard              `assertProdDatabase()`: der scharfe Lauf
 *                                    MUSS gegen die Produktions-DB gehen. Dort
 *                                    liegt der Drift, und die GoBD-Storno-/
 *                                    Neuausstellungs-Artefakte (PDFs im
 *                                    Object-Storage) sind prod-env-scoped.
 *
 * Aufruf
 * ------
 *   Trockenlauf (Kandidaten listen):
 *     tsx server/scripts/reconcile-billed-appointment-import-drift.ts
 *     tsx server/scripts/reconcile-billed-appointment-import-drift.ts --customer=108 --import-linked-only
 *   Scharf (nur bestätigte Termine, gegen die Prod-DB):
 *     tsx server/scripts/reconcile-billed-appointment-import-drift.ts --apply \
 *       --appointment=1234,1235 --user=<superadmin-id> --reason="Import-Drift-Reparatur #1651"
 *
 * Exit-Code: 0 = keine offenen Drift-Kandidaten (bzw. alle bestätigten repariert),
 * 1 = mindestens ein offener Drift-Kandidat gefunden (CI-/Skript-freundlich).
 */

import { and, eq, inArray, isNull, isNotNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import {
  customers,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
  users,
} from "@shared/schema";
import {
  findBilledImportDriftRows,
  type BilledImportDriftRow,
} from "./audit-billed-appointment-import-drift";
import { withAudit } from "../lib/with-audit";
import { stornoInvoiceCascade } from "../services/invoice-storno";
import { getInvoiceForUpdateTx } from "../storage/billing-storage";
import { generateInvoiceCore } from "../services/invoice-calc";
import {
  persistInvoicePdf,
  schedulePdfPersistInBackground,
} from "../services/invoice-pdf-orchestrator";
import { assertProdWriteAllowedOrThrow } from "./lib/prod-write-gate";
import { activeInvoiceCondition } from "../lib/appointment-invoiced";

export interface Args {
  apply: boolean;
  customerIds: number[];
  appointmentIds: number[];
  userId?: number;
  reason?: string;
  confirmTarget?: string;
  importLinkedOnly: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const parseIdList = (raw: string | undefined): number[] => {
    const out: number[] = [];
    if (!raw) return out;
    for (const s of raw.split(",")) {
      const n = parseInt(s.trim(), 10);
      if (!Number.isNaN(n)) out.push(n);
    }
    return out;
  };
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply: argv.includes("--apply"),
    customerIds: parseIdList(get("--customer=")),
    appointmentIds: parseIdList(get("--appointment=")),
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    confirmTarget: get("--confirm-target="),
    reason: get("--reason="),
    importLinkedOnly: argv.includes("--import-linked-only"),
  };
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
        `Import-Drift-Reparaturen (Storno + Neuausstellung) sind Task #1651 ` +
        `explizit auf Superadmins beschränkt.`,
    );
  }
}

// `assertProdDatabase()` ist entfallen — ERSETZT durch die SSoT
// `server/scripts/lib/prod-write-gate.ts`.
//
// Sie war ein DRITTER Prod-Begriff, und ein falscher:
//
//   const looksProd = PROD_HOST_PATTERN.test(host) || (prodHost !== "" && host === prodHost);
//
// Auf Replit heisst der interne Host in Dev und Prod gleich. `host === prodHost`
// war damit auch fuer `heliumdb` wahr — die Wegwerf-Default-DB galt als
// Produktion, und ein `--apply` haette GoBD-Storno-/Neuausstellungs-Artefakte
// dorthin geschrieben. Der 18.08.2026 mit umgekehrtem Vorzeichen.
//
// Die SSoT fragt statt der FORM die IDENTITAET: Host + `current_database()` aus
// der offenen Verbindung gegen `PROD_DATABASE_URL`, plus `--confirm-target`,
// Superadmin und Begruendung.


/** Als geschützt geltender Termin: über LN, Rechnung oder beides versiegelt. */
function isFlaggedRow(row: BilledImportDriftRow): boolean {
  // Ein Termin ist reparaturbedürftig, wenn nach dem Siegel etwas mutiert wurde:
  // Consumption rebucht (Signal A) ODER Rechnungs-Line-Item-Drift (Signal B).
  return row.consumptionRebookedAfterSeal || row.invoiceLineDrift;
}

/** Aktive (nicht-stornierte, nicht-Storno-)Rechnungen, auf denen der Termin liegt. */
async function resolveSealedInvoiceIds(appointmentId: number): Promise<number[]> {
  const rows = await db
    .select({ invoiceId: invoiceLineItems.invoiceId })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoiceLineItems.appointmentId, appointmentId),
        activeInvoiceCondition(),
      ),
    );
  return Array.from(new Set(rows.map((r) => r.invoiceId)));
}

/** Signierte (Mitarbeiter ODER Kunde), nicht soft-gelöschte LN des Termins. */
async function resolveSignedServiceRecordIds(appointmentId: number): Promise<number[]> {
  const rows = await db
    .select({ id: monthlyServiceRecords.id })
    .from(serviceRecordAppointments)
    .innerJoin(
      monthlyServiceRecords,
      eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
    )
    .where(
      and(
        eq(serviceRecordAppointments.appointmentId, appointmentId),
        isNull(monthlyServiceRecords.deletedAt),
        or(
          isNotNull(monthlyServiceRecords.employeeSignedAt),
          isNotNull(monthlyServiceRecords.customerSignedAt),
        ),
      ),
    );
  return Array.from(new Set(rows.map((r) => r.id)));
}

interface RepairPlanItem {
  appointmentId: number;
  customerId: number;
  date: string;
  protectedBy: string;
  sealedInvoiceIds: number[];
  signedServiceRecordIds: number[];
}

export interface RepairSummary {
  apply: boolean;
  scanned: number;
  flagged: BilledImportDriftRow[];
  plan: RepairPlanItem[];
  /** Nur bei --apply befüllt. */
  stornoedInvoiceIds: number[];
  reissuedInvoiceIds: number[];
  softStornoedServiceRecordIds: number[];
  lnReDocRequiredAppointmentIds: number[];
  batchId?: string;
}

function monthKey(customerId: number, year: number, month: number): string {
  return `${customerId}:${year}:${month}`;
}

export async function reconcile(args: Args): Promise<RepairSummary> {
  // 1) Erkennung über die SSoT. Im scharfen Lauf ist die Menge auf die
  //    bestätigte Allowlist eingegrenzt; im Trockenlauf wird optional nach
  //    Kunden gefiltert.
  const detectOpts: { appointmentIds?: number[]; customerIds?: number[] } = {};
  if (args.apply) {
    detectOpts.appointmentIds = args.appointmentIds;
  } else if (args.appointmentIds.length > 0) {
    detectOpts.appointmentIds = args.appointmentIds;
  } else if (args.customerIds.length > 0) {
    detectOpts.customerIds = args.customerIds;
  }

  const allRows = await findBilledImportDriftRows(detectOpts);

  // Optionaler Import-Attributions-Filter.
  const rows = args.importLinkedOnly ? allRows.filter((r) => r.importLinked) : allRows;

  const flagged = rows.filter(isFlaggedRow);

  const summary: RepairSummary = {
    apply: args.apply,
    scanned: rows.length,
    flagged,
    plan: [],
    stornoedInvoiceIds: [],
    reissuedInvoiceIds: [],
    softStornoedServiceRecordIds: [],
    lnReDocRequiredAppointmentIds: [],
  };

  // 2) Reparatur-Plan je Termin auflösen (Rechnung(en) + LN(s)).
  for (const row of flagged) {
    const sealedInvoiceIds = await resolveSealedInvoiceIds(row.appointmentId);
    const signedServiceRecordIds = await resolveSignedServiceRecordIds(row.appointmentId);
    summary.plan.push({
      appointmentId: row.appointmentId,
      customerId: row.customerId,
      date: row.date,
      protectedBy: row.protectedBy,
      sealedInvoiceIds,
      signedServiceRecordIds,
    });
  }

  if (!args.apply || args.userId === undefined) {
    return summary;
  }

  // 3) SCHARFER Lauf — nur über die bestätigte Allowlist.
  const batchId = randomUUID();
  summary.batchId = batchId;
  const auditExtra = { task: "#1651", reason: args.reason, batchId };

  // 3a) Rechnungen stornieren (dedupliziert; Cascade-Geschwister werden vom
  //     Storno-Pfad selbst miterledigt und hier übersprungen). Pro storniertem
  //     Original merken wir uns den (Kunde, Monat, Jahr) für die Neuausstellung.
  const invoiceIdsToStorno = Array.from(
    new Set(summary.plan.flatMap((p) => p.sealedInvoiceIds)),
  );
  const monthsToReissue = new Map<string, { customerId: number; billingMonth: number; billingYear: number }>();
  const alreadyStornoed = new Set<number>();

  for (const invoiceId of invoiceIdsToStorno) {
    if (alreadyStornoed.has(invoiceId)) continue;
    // Aktuellen Status prüfen — ein zuvor stornierter Cascade-Bruder oder eine
    // Stornorechnung darf nicht erneut storniert werden.
    const current = await db
      .select({
        id: invoicesTable.id,
        status: invoicesTable.status,
        invoiceType: invoicesTable.invoiceType,
        customerId: invoicesTable.customerId,
        billingMonth: invoicesTable.billingMonth,
        billingYear: invoicesTable.billingYear,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    const inv = current[0];
    if (!inv || inv.status === "storniert" || inv.invoiceType === "stornorechnung") {
      continue;
    }

    const result = await withAudit(async (tx, audit) =>
      stornoInvoiceCascade(tx, audit, {
        rootInvoiceId: invoiceId,
        cascadeRun: true,
        userId: args.userId!,
        ipAddress: undefined,
        auditMetadataExtra: auditExtra,
      }),
    );

    alreadyStornoed.add(invoiceId);
    summary.stornoedInvoiceIds.push(invoiceId);
    // Storno-PDF(s) persistieren (best-effort synchron, Fallback Hintergrund).
    for (const sid of [result.mainStornoInvoice.id, ...result.cascadeStornoIds]) {
      try {
        await persistInvoicePdf(sid);
      } catch (err) {
        console.error(`  ! PDF-Persistierung für Storno #${sid} fehlgeschlagen (wird nachgezogen):`, err);
        schedulePdfPersistInBackground(sid);
      }
    }

    // (Kunde, Monat, Jahr) des Originals + evtl. gecascadeter Geschwister für
    // die Neuausstellung merken. Die Geschwister teilen Kunde/Monat/Jahr, daher
    // reicht das Original. Nach dem Storno sind alle deren Termine frei.
    monthsToReissue.set(monthKey(inv.customerId, inv.billingYear, inv.billingMonth), {
      customerId: inv.customerId,
      billingMonth: inv.billingMonth,
      billingYear: inv.billingYear,
    });
    // Cascade-Geschwister als "schon storniert" markieren, damit ein späterer
    // Allowlist-Termin desselben Laufs sie nicht erneut anfasst.
    // (Sie sind nach dem Cascade-Storno bereits status='storniert'; die
    // Status-Prüfung oben fängt das ohnehin ab — dies ist nur eine Abkürzung.)
  }

  // 3b) Betroffene Monate NEU ausstellen. generateInvoiceCore rechnet nur die
  //     jetzt frei gewordenen (netto-null) Termine ab; bereits berechnete
  //     Termine bleiben ausgeschlossen (idempotent).
  for (const m of monthsToReissue.values()) {
    try {
      const res = await generateInvoiceCore(
        { customerId: m.customerId, billingMonth: m.billingMonth, billingYear: m.billingYear },
        { userId: args.userId!, testFaults: new Set<string>() },
      );
      const issued = collectIssuedInvoiceIds(res);
      summary.reissuedInvoiceIds.push(...issued);
    } catch (err) {
      console.error(
        `  ! Neuausstellung für Kunde #${m.customerId} ${m.billingMonth}/${m.billingYear} ` +
          `fehlgeschlagen — Storno bleibt bestehen, Monat manuell neu ausstellen:`,
        err,
      );
    }
  }

  // 3c) Signierte LN soft-stornieren (append-only Trail) — KEINE Auto-Neu-
  //     erstellung (Task #576). Betroffene Termine für Neu-Dokumentation
  //     ausweisen.
  const serviceRecordIdsToStorno = Array.from(
    new Set(summary.plan.flatMap((p) => p.signedServiceRecordIds)),
  );
  for (const srId of serviceRecordIdsToStorno) {
    // Zugehörige (offene) Termine für den Report.
    const apptRows = await db
      .select({ appointmentId: serviceRecordAppointments.appointmentId })
      .from(serviceRecordAppointments)
      .where(eq(serviceRecordAppointments.serviceRecordId, srId));

    await withAudit(async (tx, audit) => {
      const updated = await tx
        .update(monthlyServiceRecords)
        .set({ deletedAt: new Date() })
        .where(
          and(eq(monthlyServiceRecords.id, srId), isNull(monthlyServiceRecords.deletedAt)),
        )
        .returning({ id: monthlyServiceRecords.id });
      if (updated.length === 0) return; // bereits soft-gelöscht — nichts zu tun
      audit.record({
        userId: args.userId!,
        action: "service_record_deleted",
        entityType: "service_record",
        entityId: srId,
        metadata: {
          ...auditExtra,
          appointmentIds: apptRows.map((a) => a.appointmentId),
          note: "Import-Drift-Reparatur: signierter LN soft-storniert, Termine zur Neu-Dokumentation freigegeben (kein Auto-Reset, Task #576).",
        },
      });
    });

    summary.softStornoedServiceRecordIds.push(srId);
    for (const a of apptRows) {
      if (!summary.lnReDocRequiredAppointmentIds.includes(a.appointmentId)) {
        summary.lnReDocRequiredAppointmentIds.push(a.appointmentId);
      }
    }
  }

  return summary;
}

/** Sammelt die IDs aller frisch ausgestellten Rechnungen aus einem generateInvoiceCore-Ergebnis. */
function collectIssuedInvoiceIds(res: unknown): number[] {
  const out: number[] = [];
  if (!res || typeof res !== "object") return out;
  const r = res as Record<string, unknown>;
  const pushId = (v: unknown) => {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "number") {
      out.push((v as { id: number }).id);
    }
  };
  // Split-Fall: { splitInvoices: true, invoices: Invoice[] }.
  if (Array.isArray(r.invoices)) {
    for (const inv of r.invoices) pushId(inv);
    return out;
  }
  // Einzel-Fall: das Ergebnis IST die Invoice (hat .id direkt).
  pushId(r);
  return out;
}

function main2(summary: RepairSummary, args: Args, names: Map<number, string>): void {
  console.log(`\nGeprüfte geschützte Termine: ${summary.scanned}`);
  console.log(`Reparaturbedürftige Termine (Drift erkannt): ${summary.flagged.length}\n`);

  for (const p of summary.plan) {
    console.log(
      `  Termin #${p.appointmentId} · ${p.date} · Kunde #${p.customerId} ${names.get(p.customerId) ?? ""}` +
        `\n    Schutz: ${p.protectedBy}` +
        `\n    Rechnung(en): ${p.sealedInvoiceIds.length > 0 ? p.sealedInvoiceIds.join(", ") : "—"}` +
        ` · Signierte LN: ${p.signedServiceRecordIds.length > 0 ? p.signedServiceRecordIds.join(", ") : "—"}`,
    );
  }

  if (args.apply) {
    console.log(`\n=== Reparatur ausgeführt (Batch ${summary.batchId}) ===`);
    console.log(`  Stornierte Rechnungen:        ${summary.stornoedInvoiceIds.length} (${summary.stornoedInvoiceIds.join(", ") || "—"})`);
    console.log(`  Neu ausgestellte Rechnungen:  ${summary.reissuedInvoiceIds.length} (${summary.reissuedInvoiceIds.join(", ") || "—"})`);
    console.log(`  Soft-stornierte LN:           ${summary.softStornoedServiceRecordIds.length} (${summary.softStornoedServiceRecordIds.join(", ") || "—"})`);
    if (summary.lnReDocRequiredAppointmentIds.length > 0) {
      console.log(
        `  ⚠ Manuelle LN-Neu-Dokumentation nötig für Termine: ` +
          `${summary.lnReDocRequiredAppointmentIds.join(", ")}`,
      );
    }
  } else if (summary.flagged.length > 0) {
    console.log(
      "\nHinweis: Trockenlauf — keine Änderungen geschrieben." +
        '\n  Scharf reparieren (nur bestätigte Termine) mit:' +
        '\n    --apply --appointment=<id>,… --user=<superadmin-id> --reason="…"',
    );
  } else {
    console.log("\n✓ Keine reparaturbedürftigen (nach-Siegel-mutierten) Termine gefunden.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    if (args.appointmentIds.length === 0) {
      console.error(
        "Fehler: --apply erfordert --appointment=<id>,… (EXPLIZITE, bestätigte Fall-Liste). " +
          "Ein Blind-Bulk-Lauf über alle Treffer ist bewusst nicht möglich.",
      );
      process.exit(1);
    }
    const freigabe = await assertProdWriteAllowedOrThrow(
      {
        apply: args.apply,
        userId: args.userId,
        reason: args.reason,
        confirmTarget: args.confirmTarget,
      },
      "Der Lauf schreibt GoBD-Storno- und Neuausstellungs-Artefakte.",
    );
    console.log(`Freigegeben durch: ${freigabe.displayName}`);
  }

  console.log(`\n=== Import-Drift-Reparatur (Storno + Neuausstellung) · Task #1651 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  if (args.apply) {
    console.log(`Termine:  ${args.appointmentIds.join(", ")}`);
    console.log(`Superadmin: ${args.userId}`);
    console.log(`Begründung: ${args.reason}`);
  } else {
    console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
    console.log(`Termine:  ${args.appointmentIds.length > 0 ? args.appointmentIds.join(", ") : "ALLE"}`);
    if (args.importLinkedOnly) console.log(`Filter:   nur import-verknüpfte Treffer`);
  }

  const summary = await reconcile(args);

  const cids = Array.from(new Set(summary.plan.map((p) => p.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  main2(summary, args, names);

  process.exit(summary.flagged.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
