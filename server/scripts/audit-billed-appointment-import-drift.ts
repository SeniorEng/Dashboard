/**
 * Task #1649 — Rückwärts-Audit: bereits ABGERECHNETE Termine, die ein früherer
 * Excel-Import (VOR dem Schutz aus Task #1602) noch still mutiert / rebucht hat.
 *
 * Hintergrund:
 *   Task #1602 hat einen Schutz eingezogen: Der historische Excel-Import darf
 *   Termine, die bereits abgerechnet sind (signierter Leistungsnachweis ODER
 *   nicht-stornierte Rechnung — SSoT `getMutationProtectedAppointmentIds`),
 *   NICHT mehr überschreiben und ihre §45b-Consumption nicht mehr neu buchen.
 *   Dieser Schutz war bewusst NUR vorwärtsgerichtet — Termine, die ein früherer
 *   Import-Lauf (bevor der Schutz existierte) still verändert hat, werden von
 *   #1602 weder erkannt noch repariert.
 *
 *   Dieses Skript ist die nachgelagerte, rein LESENDE Bestandsaufnahme. Es
 *   findet abgerechnete Termine, deren
 *     (A) §45b-/Budget-Consumption NACH dem Versiegeln des Abrechnungs-
 *         artefakts (LN-Signatur ODER Rechnungs-Erstellung) noch storniert/
 *         neu gebucht wurde ("rebooked after seal"), und/oder
 *     (B) aktuelle Termindaten (Datum / Service-Art / Dauer / km) von den
 *         eingefrorenen Rechnungs-Line-Items abweichen ("invoice line drift").
 *   Jeder Treffer wird zusätzlich markiert, ob ein Import ihn nachweislich
 *   verursacht hat (`importLinked`: Import-Batch auf der Nach-Siegel-Buchung
 *   ODER `appointment_km_rebooked`-Audit mit Import-Trigger nach dem Siegel).
 *
 * WICHTIG — nur Bericht, KEINE Reparatur:
 *   Das Skript schreibt NICHTS. Eine etwaige Korrektur ist GoBD-pflichtig
 *   (append-only, kein In-Place-Mutieren versiegelter Artefakte) und ein
 *   separater, ausdrücklich freizugebender Schritt. Es gibt daher bewusst
 *   KEIN `--apply`.
 *
 * Produktions-sicher: reine SELECTs, gegen die Read-Only-Replik ausführbar.
 *
 * Aufruf:
 *   Trockenlauf:        tsx server/scripts/audit-billed-appointment-import-drift.ts
 *   CSV-Export:         tsx server/scripts/audit-billed-appointment-import-drift.ts --csv=drift.csv
 *   Bestimmter Kunde:   tsx server/scripts/audit-billed-appointment-import-drift.ts --customer=12
 *   Bestimmte Termine:  tsx server/scripts/audit-billed-appointment-import-drift.ts --appointment=39,57
 *   Nur import-verursachte Treffer: … --import-linked-only
 */

import { writeFileSync } from "node:fs";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../lib/db";
import {
  appointments,
  appointmentServices,
  budgetTransactions,
  services,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
  auditLog,
} from "@shared/schema";
import { isKmLineItem } from "@shared/domain/invoice-line-items";
import { getMutationProtectedAppointmentIds } from "../services/appointment-billing-protection";

/** km-Toleranz für Line-Drift-Vergleich (2 NK quantisiert). */
const KM_TOLERANCE = 0.01;

/** Import-Trigger-Präfix in `audit_log.metadata.trigger`. */
const IMPORT_TRIGGER_PREFIX = "appointment_import:";

interface CliArgs {
  appointmentIds: number[];
  customerIds: number[];
  csvPath?: string;
  importLinkedOnly: boolean;
}

export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apptArg = args.find((a) => a.startsWith("--appointment="));
  const customerArg = args.find((a) => a.startsWith("--customer="));
  const csvArg = args.find((a) => a.startsWith("--csv="));
  const importLinkedOnly = args.includes("--import-linked-only");

  const parseIds = (s: string | undefined): number[] => {
    if (!s) return [];
    return s
      .split("=")[1]
      .split(",")
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => !isNaN(n));
  };

  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  return {
    appointmentIds: parseIds(apptArg),
    customerIds: parseIds(customerArg),
    csvPath: csvPath && csvPath.length > 0 ? csvPath : undefined,
    importLinkedOnly,
  };
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Frühester Zeitpunkt aus einer Menge (ignoriert null). */
function earliest(dates: (Date | null)[]): Date | null {
  let min: Date | null = null;
  for (const d of dates) {
    if (d == null) continue;
    if (min == null || d.getTime() < min.getTime()) min = d;
  }
  return min;
}

export interface BilledImportDriftRow {
  appointmentId: number;
  customerId: number;
  date: string;
  /** "ln" | "invoice" | "ln+invoice" — worüber der Termin geschützt ist. */
  protectedBy: string;
  /** Frühestes Versiegelungs-Datum (LN-Signatur / Rechnungs-Erstellung). */
  sealAt: string | null;
  // ---- Signal A: Consumption nach dem Siegel rebucht ----
  consumptionRebookedAfterSeal: boolean;
  /** Anzahl reversal-Buchungen nach dem Siegel. */
  reversalsAfterSeal: number;
  /** Anzahl consumption-Buchungen, die erst nach dem Siegel entstanden. */
  consumptionsAfterSeal: number;
  /** Späteste Nach-Siegel-Buchung (createdAt). */
  lastPostSealTxAt: string | null;
  // ---- Signal B: Rechnungs-Line-Item-Drift (nur bei Rechnungs-Schutz) ----
  invoiceLineDrift: boolean;
  driftDate: boolean;
  driftService: boolean;
  driftDuration: boolean;
  driftKm: boolean;
  currentServiceCodes: string;
  billedServiceCodes: string;
  currentDurationMinutes: number;
  billedDurationMinutes: number | null;
  currentTravelKm: number;
  currentCustomerKm: number;
  billedTravelKm: number | null;
  billedCustomerKm: number | null;
  // ---- Import-Attribution ----
  importLinked: boolean;
  /** Kurzbeschreibung der Import-Belege (Batch-IDs / Audit-Trigger). */
  importEvidence: string;
}

export async function findBilledImportDriftRows(opts: {
  appointmentIds?: number[];
  customerIds?: number[];
}): Promise<BilledImportDriftRow[]> {
  const whereParts = [
    isNull(appointments.deletedAt),
    eq(appointments.appointmentType, "Kundentermin"),
  ];
  if (opts.appointmentIds && opts.appointmentIds.length > 0) {
    whereParts.push(inArray(appointments.id, opts.appointmentIds));
  }
  if (opts.customerIds && opts.customerIds.length > 0) {
    whereParts.push(inArray(appointments.customerId, opts.customerIds));
  }

  const apptRows = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      date: appointments.date,
      travelKm: appointments.travelKilometers,
      customerKm: appointments.customerKilometers,
    })
    .from(appointments)
    .where(and(...whereParts));

  if (apptRows.length === 0) return [];

  const allIds = apptRows.map((a) => a.id);

  // SSoT: welche dieser Termine sind gegen Mutation geschützt (= abgerechnet)?
  const { protectedIds, signedServiceRecordIds, invoicedIds } =
    await getMutationProtectedAppointmentIds(allIds);
  const protectedApptRows = apptRows.filter((a) => protectedIds.has(a.id));
  if (protectedApptRows.length === 0) return [];
  const protIds = protectedApptRows.map((a) => a.id);

  // --- Aktuelle Service-Minuten + Codes je Termin ---
  const svcRows = await db
    .select({
      appointmentId: appointmentServices.appointmentId,
      code: services.code,
      actual: appointmentServices.actualDurationMinutes,
      planned: appointmentServices.plannedDurationMinutes,
    })
    .from(appointmentServices)
    .innerJoin(services, eq(appointmentServices.serviceId, services.id))
    .where(inArray(appointmentServices.appointmentId, protIds));
  const curSvcByAppt = new Map<
    number,
    { minutes: number; codes: Set<string> }
  >();
  for (const r of svcRows) {
    const acc = curSvcByAppt.get(r.appointmentId) ?? {
      minutes: 0,
      codes: new Set<string>(),
    };
    acc.minutes += Math.round(r.actual ?? r.planned ?? 0);
    if (r.code) acc.codes.add(r.code);
    curSvcByAppt.set(r.appointmentId, acc);
  }

  // --- LN-Siegel je Termin (min Signatur-Zeit, nur signierte, nicht gelöscht) ---
  const lnRows = await db
    .select({
      appointmentId: serviceRecordAppointments.appointmentId,
      employeeSignedAt: monthlyServiceRecords.employeeSignedAt,
      customerSignedAt: monthlyServiceRecords.customerSignedAt,
    })
    .from(serviceRecordAppointments)
    .innerJoin(
      monthlyServiceRecords,
      eq(serviceRecordAppointments.serviceRecordId, monthlyServiceRecords.id),
    )
    .where(
      and(
        inArray(serviceRecordAppointments.appointmentId, protIds),
        isNull(monthlyServiceRecords.deletedAt),
      ),
    );
  const lnSealByAppt = new Map<number, Date | null>();
  for (const r of lnRows) {
    const cand = earliest([toDate(r.employeeSignedAt), toDate(r.customerSignedAt)]);
    if (cand == null) continue;
    const cur = lnSealByAppt.get(r.appointmentId) ?? null;
    lnSealByAppt.set(r.appointmentId, earliest([cur, cand]));
  }

  // --- Rechnungs-Siegel + eingefrorene Line-Items je Termin ---
  const invRows = await db
    .select({
      appointmentId: invoiceLineItems.appointmentId,
      appointmentDate: invoiceLineItems.appointmentDate,
      serviceCode: invoiceLineItems.serviceCode,
      durationMinutes: invoiceLineItems.durationMinutes,
      quantityRaw: invoiceLineItems.quantityRaw,
      invoiceId: invoiceLineItems.invoiceId,
      invoiceStatus: invoicesTable.status,
      invoiceCreatedAt: invoicesTable.createdAt,
    })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(
      and(
        inArray(invoiceLineItems.appointmentId, protIds),
        // Nur echte Abrechnungs-Belege als Baseline: identische Prädikate wie die
        // Schutz-SSoT (`getMutationProtectedAppointmentIds`) — stornierte
        // Rechnungen und Stornorechnungen sind KEINE gültige Baseline und dürfen
        // weder als eingefrorene Momentaufnahme noch als Siegel-Zeit einfließen.
        // Entwürfe (`entwurf`) bleiben bewusst drin (wie in der SSoT).
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ),
    );
  // Line-Items werden JE RECHNUNG getrennt gehalten (NICHT über mehrere
  // Rechnungen summiert): ein Termin kann auf mehreren geschützten Rechnungen
  // liegen (z.B. Entwurf-Duplikate, Storno+Neu). Der Drift-Vergleich unten
  // entscheidet „stimmt mit IRGENDEINER Rechnung überein => kein Drift".
  const invSealByAppt = new Map<number, Date | null>();
  type BilledSnapshot = {
    created: Date | null;
    dates: Set<string>;
    serviceCodes: Set<string>;
    durationMinutes: number;
    travelKm: number;
    customerKm: number;
  };
  const billedByApptInvoice = new Map<number, Map<number, BilledSnapshot>>();
  for (const r of invRows) {
    if (r.appointmentId == null) continue;
    if (!invoicedIds.has(r.appointmentId)) continue; // nur SSoT-geschützte Rechnungen
    const created = toDate(r.invoiceCreatedAt);
    // „Siegel"-Zeit NUR für echt versiegelte Rechnungen (kein Entwurf): ein
    // Entwurf kann jederzeit neu erzeugt werden und ist kein GoBD-Siegel.
    if (r.invoiceStatus !== "entwurf") {
      const curSeal = invSealByAppt.get(r.appointmentId) ?? null;
      invSealByAppt.set(r.appointmentId, earliest([curSeal, created]));
    }

    let byInv = billedByApptInvoice.get(r.appointmentId);
    if (byInv == null) {
      byInv = new Map<number, BilledSnapshot>();
      billedByApptInvoice.set(r.appointmentId, byInv);
    }
    let acc = byInv.get(r.invoiceId);
    if (acc == null) {
      acc = {
        created,
        dates: new Set<string>(),
        serviceCodes: new Set<string>(),
        durationMinutes: 0,
        travelKm: 0,
        customerKm: 0,
      };
      byInv.set(r.invoiceId, acc);
    }
    acc.dates.add(toDateStr(r.appointmentDate));
    if (isKmLineItem(r.serviceCode)) {
      const km = r.quantityRaw ?? r.durationMinutes ?? 0;
      if (r.serviceCode === "travel_km") acc.travelKm += km;
      else if (r.serviceCode === "customer_km") acc.customerKm += km;
    } else if (r.serviceCode !== "no_show_charge") {
      if (r.serviceCode) acc.serviceCodes.add(r.serviceCode);
      acc.durationMinutes += r.durationMinutes ?? 0;
    }
  }

  // --- Budget-Consumption/Reversal-Buchungen je Termin ---
  const txRows = await db
    .select({
      appointmentId: budgetTransactions.appointmentId,
      transactionType: budgetTransactions.transactionType,
      createdAt: budgetTransactions.createdAt,
      importBatchId: budgetTransactions.importBatchId,
    })
    .from(budgetTransactions)
    .where(
      and(
        inArray(budgetTransactions.appointmentId, protIds),
        inArray(budgetTransactions.transactionType, ["consumption", "reversal"]),
      ),
    );

  // --- Import-Rebook-Audit je Termin ---
  const auditRows = await db
    .select({
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "appointment_km_rebooked"),
        eq(auditLog.entityType, "appointment"),
        inArray(auditLog.entityId, protIds),
      ),
    );
  const importAuditByAppt = new Map<
    number,
    { trigger: string; createdAt: Date | null }[]
  >();
  for (const r of auditRows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const trigger = typeof meta.trigger === "string" ? meta.trigger : "";
    if (!trigger.startsWith(IMPORT_TRIGGER_PREFIX)) continue;
    const bucket = importAuditByAppt.get(r.entityId) ?? [];
    bucket.push({ trigger, createdAt: toDate(r.createdAt) });
    importAuditByAppt.set(r.entityId, bucket);
  }

  const out: BilledImportDriftRow[] = [];
  for (const a of protectedApptRows) {
    const sealAt = earliest([
      lnSealByAppt.get(a.id) ?? null,
      invSealByAppt.get(a.id) ?? null,
    ]);

    // --- Signal A: Consumption nach dem Siegel rebucht ---
    let reversalsAfterSeal = 0;
    let consumptionsAfterSeal = 0;
    let lastPostSealTx: Date | null = null;
    const postSealBatchIds = new Set<number>();
    if (sealAt != null) {
      for (const t of txRows) {
        if (t.appointmentId !== a.id) continue;
        const created = toDate(t.createdAt);
        if (created == null || created.getTime() <= sealAt.getTime()) continue;
        if (t.transactionType === "reversal") reversalsAfterSeal++;
        else if (t.transactionType === "consumption") consumptionsAfterSeal++;
        if (lastPostSealTx == null || created.getTime() > lastPostSealTx.getTime()) {
          lastPostSealTx = created;
        }
        if (t.importBatchId != null) postSealBatchIds.add(t.importBatchId);
      }
    }
    const consumptionRebookedAfterSeal =
      reversalsAfterSeal > 0 || consumptionsAfterSeal > 0;

    // --- Signal B: Rechnungs-Line-Item-Drift ---
    // Ein Termin kann auf mehreren geschützten Rechnungen liegen. Deckt sich die
    // AKTUELLE Termin-Datenlage mit IRGENDEINER dieser eingefrorenen
    // Rechnungs-Momentaufnahmen, liegt KEIN Drift vor (die Ist-Daten stimmen mit
    // einem gebuchten Beleg überein). Nur wenn KEINE Rechnung passt, wird der
    // Drift gegen die JÜNGSTE Rechnung berichtet.
    const byInv = billedByApptInvoice.get(a.id);
    const cur = curSvcByAppt.get(a.id) ?? {
      minutes: 0,
      codes: new Set<string>(),
    };
    const curTravelKm = a.travelKm ?? 0;
    const curCustomerKm = a.customerKm ?? 0;
    const curCodes = [...cur.codes].sort().join("|");
    const curDateStr = toDateStr(a.date);
    let driftDate = false;
    let driftService = false;
    let driftDuration = false;
    let driftKm = false;
    let latestBilled: BilledSnapshot | null = null;
    if (byInv && byInv.size > 0) {
      let matchedAny = false;
      for (const snap of byInv.values()) {
        if (
          latestBilled == null ||
          (snap.created?.getTime() ?? 0) > (latestBilled.created?.getTime() ?? 0)
        ) {
          latestBilled = snap;
        }
        const dOk = snap.dates.size === 1 && snap.dates.has(curDateStr);
        const sOk = [...snap.serviceCodes].sort().join("|") === curCodes;
        const durOk = snap.durationMinutes === cur.minutes;
        const kmOk =
          Math.abs(curTravelKm - snap.travelKm) <= KM_TOLERANCE &&
          Math.abs(curCustomerKm - snap.customerKm) <= KM_TOLERANCE;
        if (dOk && sOk && durOk && kmOk) matchedAny = true;
      }
      if (!matchedAny && latestBilled) {
        const billedCodes = [...latestBilled.serviceCodes].sort().join("|");
        driftDate =
          latestBilled.dates.size > 0 &&
          !(latestBilled.dates.size === 1 && latestBilled.dates.has(curDateStr));
        driftService =
          latestBilled.serviceCodes.size > 0 && curCodes !== billedCodes;
        driftDuration = cur.minutes !== latestBilled.durationMinutes;
        driftKm =
          Math.abs(curTravelKm - latestBilled.travelKm) > KM_TOLERANCE ||
          Math.abs(curCustomerKm - latestBilled.customerKm) > KM_TOLERANCE;
      }
    }
    const invoiceLineDrift = driftDate || driftService || driftDuration || driftKm;

    // --- Import-Attribution ---
    const auditHits = importAuditByAppt.get(a.id) ?? [];
    const postSealAudit = auditHits.filter(
      (h) =>
        h.createdAt != null &&
        sealAt != null &&
        h.createdAt.getTime() > sealAt.getTime(),
    );
    const importLinked = postSealBatchIds.size > 0 || postSealAudit.length > 0;
    const importEvidenceParts: string[] = [];
    if (postSealBatchIds.size > 0) {
      importEvidenceParts.push(`batch=${[...postSealBatchIds].join(",")}`);
    }
    if (postSealAudit.length > 0) {
      const triggers = [...new Set(postSealAudit.map((h) => h.trigger))];
      importEvidenceParts.push(`audit=${triggers.join(",")}`);
    }

    // Nur Termine mit mind. EINEM Inkonsistenz-Signal berichten.
    if (!consumptionRebookedAfterSeal && !invoiceLineDrift) continue;

    const protectedByParts: string[] = [];
    if (signedServiceRecordIds.has(a.id)) protectedByParts.push("ln");
    if (invoicedIds.has(a.id)) protectedByParts.push("invoice");

    out.push({
      appointmentId: a.id,
      customerId: a.customerId!,
      date: toDateStr(a.date),
      protectedBy: protectedByParts.join("+"),
      sealAt: sealAt ? sealAt.toISOString() : null,
      consumptionRebookedAfterSeal,
      reversalsAfterSeal,
      consumptionsAfterSeal,
      lastPostSealTxAt: lastPostSealTx ? lastPostSealTx.toISOString() : null,
      invoiceLineDrift,
      driftDate,
      driftService,
      driftDuration,
      driftKm,
      currentServiceCodes: curCodes,
      billedServiceCodes: latestBilled
        ? [...latestBilled.serviceCodes].sort().join("|")
        : "",
      currentDurationMinutes: cur.minutes,
      billedDurationMinutes: latestBilled ? latestBilled.durationMinutes : null,
      currentTravelKm: curTravelKm,
      currentCustomerKm: curCustomerKm,
      billedTravelKm: latestBilled ? latestBilled.travelKm : null,
      billedCustomerKm: latestBilled ? latestBilled.customerKm : null,
      importLinked,
      importEvidence: importEvidenceParts.join(" "),
    });
  }

  return out.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.appointmentId - b.appointmentId,
  );
}

/**
 * Wendet die CLI-Argumente an: ruft die reine Drift-Erkennung auf und
 * verengt das Ergebnis bei `--import-linked-only` auf import-verursachte
 * Treffer. EINE gemeinsame Stelle für `main()` UND den Regressions-Test —
 * so ist die Flag-Verdrahtung (`parseArgs` → Filter) mitgetestet, nicht
 * nur die Zeilen-Semantik.
 */
export async function runDriftAudit(
  args: Pick<CliArgs, "appointmentIds" | "customerIds" | "importLinkedOnly">,
): Promise<BilledImportDriftRow[]> {
  let rows = await findBilledImportDriftRows({
    appointmentIds: args.appointmentIds.length > 0 ? args.appointmentIds : undefined,
    customerIds: args.customerIds.length > 0 ? args.customerIds : undefined,
  });
  if (args.importLinkedOnly) rows = rows.filter((r) => r.importLinked);
  return rows;
}

function toCsv(rows: BilledImportDriftRow[]): string {
  const header = [
    "appointmentId",
    "customerId",
    "date",
    "protectedBy",
    "sealAt",
    "consumptionRebookedAfterSeal",
    "reversalsAfterSeal",
    "consumptionsAfterSeal",
    "lastPostSealTxAt",
    "invoiceLineDrift",
    "driftDate",
    "driftService",
    "driftDuration",
    "driftKm",
    "currentServiceCodes",
    "billedServiceCodes",
    "currentDurationMinutes",
    "billedDurationMinutes",
    "currentTravelKm",
    "currentCustomerKm",
    "billedTravelKm",
    "billedCustomerKm",
    "importLinked",
    "importEvidence",
  ];
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.appointmentId,
        r.customerId,
        r.date,
        r.protectedBy,
        r.sealAt ?? "",
        r.consumptionRebookedAfterSeal,
        r.reversalsAfterSeal,
        r.consumptionsAfterSeal,
        r.lastPostSealTxAt ?? "",
        r.invoiceLineDrift,
        r.driftDate,
        r.driftService,
        r.driftDuration,
        r.driftKm,
        r.currentServiceCodes,
        r.billedServiceCodes,
        r.currentDurationMinutes,
        r.billedDurationMinutes ?? "",
        r.currentTravelKm,
        r.currentCustomerKm,
        r.billedTravelKm ?? "",
        r.billedCustomerKm ?? "",
        r.importLinked,
        r.importEvidence,
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();

  console.log("=== Rückwärts-Audit: abgerechnete Termine × früherer Import (Task #1649) ===");
  console.log("Modus:               NUR BERICHT (read-only, keine Reparatur)");
  console.log(`km-Toleranz:         ${KM_TOLERANCE} km`);
  if (args.appointmentIds.length > 0)
    console.log(`Termine:             ${args.appointmentIds.join(", ")}`);
  if (args.customerIds.length > 0)
    console.log(`Kunden:              ${args.customerIds.join(", ")}`);
  if (args.importLinkedOnly)
    console.log("Filter:              nur import-verursachte Treffer (--import-linked-only)");

  const rows = await runDriftAudit(args);

  console.log(`\nBetroffene abgerechnete Termine: ${rows.length}`);
  for (const r of rows) {
    const signals = [
      r.consumptionRebookedAfterSeal
        ? `rebooked-after-seal(rev=${r.reversalsAfterSeal},cons=${r.consumptionsAfterSeal})`
        : null,
      r.invoiceLineDrift
        ? "line-drift:" +
          [
            r.driftDate ? "datum" : null,
            r.driftService ? "art" : null,
            r.driftDuration ? "dauer" : null,
            r.driftKm ? "km" : null,
          ]
            .filter(Boolean)
            .join("+")
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `  appt#${r.appointmentId} (${r.date}, Kunde #${r.customerId}, ${r.protectedBy}, ` +
        `Siegel ${r.sealAt ?? "—"})` +
        (r.importLinked ? ` [IMPORT: ${r.importEvidence}]` : "") +
        `: ${signals}` +
        (r.invoiceLineDrift
          ? ` — art ${r.billedServiceCodes || "—"}→${r.currentServiceCodes || "—"}, ` +
            `dauer ${r.billedDurationMinutes ?? "—"}→${r.currentDurationMinutes} min, ` +
            `km ${r.billedTravelKm ?? "—"}/${r.billedCustomerKm ?? "—"}→${r.currentTravelKm}/${r.currentCustomerKm}`
          : ""),
    );
  }

  // --- Quantifizierung: pro Kunde & pro Monat ---
  const importLinkedCount = rows.filter((r) => r.importLinked).length;
  const rebookedCount = rows.filter((r) => r.consumptionRebookedAfterSeal).length;
  const lineDriftCount = rows.filter((r) => r.invoiceLineDrift).length;

  const byCustomer = new Map<number, number>();
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    byCustomer.set(r.customerId, (byCustomer.get(r.customerId) ?? 0) + 1);
    const ym = r.date.substring(0, 7);
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1);
  }

  console.log(`\n=== Zusammenfassung ===`);
  console.log(`Betroffene Termine gesamt:            ${rows.length}`);
  console.log(`  davon import-verursacht:            ${importLinkedCount}`);
  console.log(`  mit Consumption-Rebook nach Siegel: ${rebookedCount}`);
  console.log(`  mit Rechnungs-Line-Drift:           ${lineDriftCount}`);
  console.log(`Betroffene Kunden:                    ${byCustomer.size}`);

  if (byCustomer.size > 0) {
    console.log(`\nPro Kunde:`);
    for (const [cid, n] of [...byCustomer.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  Kunde #${cid}: ${n} Termin(e)`);
    }
  }
  if (byMonth.size > 0) {
    console.log(`\nPro Monat (Termin-Datum):`);
    for (const [ym, n] of [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      console.log(`  ${ym}: ${n} Termin(e)`);
    }
  }

  if (args.csvPath) {
    writeFileSync(args.csvPath, toCsv(rows), "utf8");
    console.log(`\nCSV geschrieben: ${args.csvPath}`);
  }

  console.log(
    "\nHinweis: Reiner Bericht. Eine GoBD-konforme Korrektur (append-only, kein " +
      "In-Place-Mutieren versiegelter Artefakte) ist ein separater, ausdrücklich " +
      "freizugebender Schritt.",
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
