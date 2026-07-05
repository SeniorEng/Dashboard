/**
 * Task #1650 — Regressions-Schutz für das Rückwärts-Audit (Task #1649).
 *
 * `server/scripts/audit-billed-appointment-import-drift.ts` exportiert eine rein
 * lesende `findBilledImportDriftRows()`, die abgerechnete Termine findet, deren
 *   (A) Budget-Consumption NACH dem Versiegeln (LN-Signatur / Rechnungs-
 *       Erstellung) noch storniert/neu gebucht wurde ("rebooked after seal"), und/
 *   (B) aktuelle Termindaten (Datum/Art/Dauer/km) von den eingefrorenen
 *       Rechnungs-Line-Items abweichen ("invoice line drift").
 *
 * Ohne Test könnte eine spätere Änderung an der Schutz-SSoT
 * (`getMutationProtectedAppointmentIds`), am Line-Item-Shape oder am
 * Consumption-/Reversal-Schema die Erkennung still kaputt machen. Dieser Test
 * pinnt das Verhalten fest, indem er bekannte Fälle seedet und prüft, dass das
 * Audit GENAU diese Fälle (und nur diese) meldet:
 *
 *   (a) Termin auf signiertem LN + Rechnung, dessen AKTUELLE Dauer von den
 *       eingefrorenen `invoice_line_items` abweicht        → line-drift gemeldet.
 *   (b) Termin mit einer Reversal-Buchung NACH dem Siegel  → rebooked-after-seal.
 *   (c) sauber abgerechneter Termin (Ist == eingefroren)   → NICHT gemeldet.
 *   (d) Termin auf zwei IDENTISCHEN Entwurfs-Rechnungen    → NICHT gemeldet
 *       (per-Rechnung "matches ANY snapshot", kein Summen-False-Positive).
 *
 * Zusätzlich: `--import-linked-only` verengt auf die import-attributierten
 * Treffer (nur (b) trägt einen `importBatchId` auf der Nach-Siegel-Buchung).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPut,
  apiPost,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let hwServiceId: number;
let hwServiceCode: string;

// Alle Termine im selben Monat; Siegel-/Buchungszeiten sind bewusst FIXE
// Timestamps (keine Wall-Clock-Abhängigkeit → deterministisch).
const DATE_A = "2026-05-05"; // Dienstag — Dauer-Drift (line-drift)
const DATE_B = "2026-05-06"; // Mittwoch — Reversal nach Siegel (rebooked)
const DATE_C = "2026-05-07"; // Donnerstag — sauber, darf NICHT gemeldet werden
const DATE_D = "2026-05-08"; // Freitag — Doppel-Entwurf, darf NICHT gemeldet werden

const SEAL_B = new Date("2026-05-20T10:00:00Z");
const CONSUMPTION_BEFORE_SEAL = new Date("2026-05-10T10:00:00Z");
const REVERSAL_AFTER_SEAL = new Date("2026-05-25T10:00:00Z");
const IMPORT_BATCH_ID = 987654;

let apptA: number;
let apptB: number;
let apptC: number;
let apptD: number;

/**
 * Legt einen abgeschlossenen Kundentermin + eine `appointment_services`-Zeile an
 * (das Audit liest die AKTUELLE Dauer/Art aus `appointment_services`, nicht aus
 * `appointments`). Gibt die Termin-ID zurück.
 */
async function insertApptWithService(
  date: string,
  actualDurationMinutes: number,
  travelKm: number,
): Promise<number> {
  const { db } = await import("../server/lib/db");
  const { appointments, appointmentServices } = await import("@shared/schema");
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: auth.user.id,
      performedByEmployeeId: auth.user.id,
      date,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      actualStart: "09:00",
      actualEnd: "10:00",
      durationPromised: actualDurationMinutes,
      durationActual: actualDurationMinutes,
      status: "completed",
      appointmentType: "Kundentermin",
      serviceId: hwServiceId,
      travelKilometers: travelKm,
    })
    .returning({ id: appointments.id });
  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId: hwServiceId,
    plannedDurationMinutes: actualDurationMinutes,
    actualDurationMinutes,
  });
  return appt.id;
}

/** Signierter (nicht soft-gelöschter) Leistungsnachweis auf `appointmentId`. */
async function insertSignedLn(appointmentId: number, signedAt: Date): Promise<void> {
  const { db } = await import("../server/lib/db");
  const { monthlyServiceRecords, serviceRecordAppointments } = await import(
    "@shared/schema"
  );
  const [ln] = await db
    .insert(monthlyServiceRecords)
    .values({
      customerId,
      employeeId: auth.user.id,
      year: 2026,
      month: 5,
      recordType: "single",
      status: "signed",
      employeeSignedAt: signedAt,
      employeeSignedByUserId: auth.user.id,
    })
    .returning({ id: monthlyServiceRecords.id });
  await db.insert(serviceRecordAppointments).values({
    serviceRecordId: ln.id,
    appointmentId,
  });
}

/**
 * Legt eine Rechnung + ein einzelnes (Nicht-km-)Line-Item auf `appointmentId`
 * an und gibt die Rechnungs-ID zurück.
 */
async function insertInvoiceWithLine(
  appointmentId: number,
  date: string,
  status: "entwurf" | "versendet",
  durationMinutes: number,
): Promise<number> {
  const { db } = await import("../server/lib/db");
  const { invoices, invoiceLineItems } = await import("@shared/schema");
  const [inv] = await db
    .insert(invoices)
    .values({
      customerId,
      invoiceNumber: `TEST-1650-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      billingType: "selbstzahler",
      invoiceType: "rechnung",
      billingMonth: 5,
      billingYear: 2026,
      status,
      recipientName: "Test Empfänger",
      netAmountCents: 3800,
      grossAmountCents: 3800,
    } as typeof invoices.$inferInsert)
    .returning({ id: invoices.id });
  await db.insert(invoiceLineItems).values({
    invoiceId: inv.id,
    appointmentId,
    appointmentDate: date,
    serviceDescription: "Hauswirtschaft",
    serviceCode: hwServiceCode,
    durationMinutes,
    unitPriceCents: 3800,
    totalCents: 3800,
  } as typeof invoiceLineItems.$inferInsert);
  return inv.id;
}

/** Direkte Budget-Buchung (consumption/reversal) mit fixem `createdAt`. */
async function insertBudgetTx(opts: {
  appointmentId: number;
  transactionType: "consumption" | "reversal";
  amountCents: number;
  createdAt: Date;
  transactionDate: string;
  reversedTransactionId?: number | null;
  importBatchId?: number | null;
}): Promise<number> {
  const { db } = await import("../server/lib/db");
  const { budgetTransactions } = await import("@shared/schema");
  const [tx] = await db
    .insert(budgetTransactions)
    .values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: opts.transactionDate,
      transactionType: opts.transactionType,
      amountCents: opts.amountCents,
      appointmentId: opts.appointmentId,
      reversedTransactionId: opts.reversedTransactionId ?? null,
      importBatchId: opts.importBatchId ?? null,
      createdAt: opts.createdAt,
    } as typeof budgetTransactions.$inferInsert)
    .returning({ id: budgetTransactions.id });
  return tx.id;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `ImportDrift_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
  });
  customerId = customer.id;
  await assignEmployeeToCustomer(customerId, auth.user.id);
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 13100 },
    ],
  });
  await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 200000,
    carryoverAmountCents: 0,
    budgetStartDate: "2026-01-01",
  });

  const { db } = await import("../server/lib/db");
  const { services: servicesTable } = await import("@shared/schema");
  const allServices = await db.select().from(servicesTable);
  const hw = allServices.find(
    (s) => /hauswirtschaft/i.test(s.name ?? "") || /hauswirtschaft/i.test(s.code ?? ""),
  );
  if (!hw) throw new Error("Service Hauswirtschaft nicht gefunden");
  hwServiceId = hw.id;
  hwServiceCode = hw.code!;

  // (a) Dauer-Drift: Ist-Dauer 90 min, eingefroren 60 min (Art/Datum/km gleich).
  apptA = await insertApptWithService(DATE_A, 90, 0);
  await insertSignedLn(apptA, new Date("2026-05-18T10:00:00Z"));
  await insertInvoiceWithLine(apptA, DATE_A, "versendet", 60);

  // (b) Reversal nach dem Siegel (import-attributiert via importBatchId).
  apptB = await insertApptWithService(DATE_B, 60, 0);
  await insertSignedLn(apptB, SEAL_B);
  const consB = await insertBudgetTx({
    appointmentId: apptB,
    transactionType: "consumption",
    amountCents: -3800,
    createdAt: CONSUMPTION_BEFORE_SEAL,
    transactionDate: DATE_B,
  });
  await insertBudgetTx({
    appointmentId: apptB,
    transactionType: "reversal",
    amountCents: 3800,
    createdAt: REVERSAL_AFTER_SEAL,
    transactionDate: DATE_B,
    reversedTransactionId: consB,
    importBatchId: IMPORT_BATCH_ID,
  });

  // (c) Sauber: Ist-Dauer == eingefroren, keine Nach-Siegel-Buchung.
  apptC = await insertApptWithService(DATE_C, 60, 0);
  await insertSignedLn(apptC, new Date("2026-05-18T10:00:00Z"));
  await insertInvoiceWithLine(apptC, DATE_C, "versendet", 60);
  // Consumption VOR dem Siegel (darf NICHT als "rebooked after seal" zählen).
  await insertBudgetTx({
    appointmentId: apptC,
    transactionType: "consumption",
    amountCents: -3800,
    createdAt: new Date("2026-05-12T10:00:00Z"),
    transactionDate: DATE_C,
  });

  // (d) Zwei IDENTISCHE Entwurfs-Rechnungen (Duplikat) — je 60 min, Ist 60 min.
  apptD = await insertApptWithService(DATE_D, 60, 0);
  await insertInvoiceWithLine(apptD, DATE_D, "entwurf", 60);
  await insertInvoiceWithLine(apptD, DATE_D, "entwurf", 60);
});

afterAll(async () => {
  await runCleanup();
});

async function runAudit() {
  const { findBilledImportDriftRows } = await import(
    "../server/scripts/audit-billed-appointment-import-drift"
  );
  return findBilledImportDriftRows({ customerIds: [customerId] });
}

describe("Task #1650: findBilledImportDriftRows Regressions-Schutz", () => {
  it("meldet den Dauer-Drift (Signal B, invoice line-drift) für Termin (a)", async () => {
    const rows = await runAudit();
    const row = rows.find((r) => r.appointmentId === apptA);
    expect(row, "Dauer-Drift-Termin (a) muss gemeldet werden").toBeDefined();
    expect(row!.invoiceLineDrift).toBe(true);
    expect(row!.driftDuration).toBe(true);
    // Nur die Dauer weicht ab — Datum/Art/km bleiben identisch.
    expect(row!.driftDate).toBe(false);
    expect(row!.driftService).toBe(false);
    expect(row!.driftKm).toBe(false);
    expect(row!.currentDurationMinutes).toBe(90);
    expect(row!.billedDurationMinutes).toBe(60);
    expect(row!.consumptionRebookedAfterSeal).toBe(false);
    // Kein Import-Beleg auf (a).
    expect(row!.importLinked).toBe(false);
  });

  it("meldet die Nach-Siegel-Reversal (Signal A) für Termin (b)", async () => {
    const rows = await runAudit();
    const row = rows.find((r) => r.appointmentId === apptB);
    expect(row, "Reversal-nach-Siegel-Termin (b) muss gemeldet werden").toBeDefined();
    expect(row!.consumptionRebookedAfterSeal).toBe(true);
    expect(row!.reversalsAfterSeal).toBe(1);
    expect(row!.consumptionsAfterSeal).toBe(0);
    // Keine Rechnung → kein Line-Drift.
    expect(row!.invoiceLineDrift).toBe(false);
    expect(row!.protectedBy).toBe("ln");
    // Import-attributiert (importBatchId auf der Nach-Siegel-Buchung).
    expect(row!.importLinked).toBe(true);
    expect(row!.importEvidence).toContain(`batch=${IMPORT_BATCH_ID}`);
  });

  it("meldet den sauber abgerechneten Termin (c) NICHT", async () => {
    const rows = await runAudit();
    expect(rows.find((r) => r.appointmentId === apptC)).toBeUndefined();
  });

  it("meldet den Doppel-Entwurf-Termin (d) NICHT (matches-ANY, kein Summen-False-Positive)", async () => {
    const rows = await runAudit();
    expect(rows.find((r) => r.appointmentId === apptD)).toBeUndefined();
  });

  it("--import-linked-only verengt über die CLI-Verdrahtung auf import-attributierte Treffer", async () => {
    // Testet die ECHTE Flag-Verdrahtung: `parseArgs()` liest `process.argv`,
    // `runDriftAudit()` wendet den `--import-linked-only`-Filter an. Kein
    // manuelles `rows.filter(...)` — eine Regression in parseArgs/main würde
    // hier auffallen.
    const { parseArgs, runDriftAudit } = await import(
      "../server/scripts/audit-billed-appointment-import-drift"
    );

    const originalArgv = process.argv;
    process.argv = [
      "node",
      "audit-billed-appointment-import-drift.ts",
      "--import-linked-only",
      `--customer=${customerId}`,
    ];
    try {
      const args = parseArgs();
      expect(args.importLinkedOnly).toBe(true);
      expect(args.customerIds).toEqual([customerId]);

      const linkedIds = (await runDriftAudit(args)).map((r) => r.appointmentId);
      // Nur (b) ist import-attributiert; (a) fällt raus, (c)/(d) werden gar nicht gemeldet.
      expect(linkedIds).toContain(apptB);
      expect(linkedIds).not.toContain(apptA);
      expect(linkedIds).not.toContain(apptC);
      expect(linkedIds).not.toContain(apptD);
    } finally {
      process.argv = originalArgv;
    }

    // Gegenprobe OHNE Flag: (a) taucht wieder auf → beweist, dass der Filter
    // (nicht die Seed-Daten) die Verengung bewirkt.
    process.argv = ["node", "x", `--customer=${customerId}`];
    try {
      const args = parseArgs();
      expect(args.importLinkedOnly).toBe(false);
      const allIds = (await runDriftAudit(args)).map((r) => r.appointmentId);
      expect(allIds).toContain(apptA);
      expect(allIds).toContain(apptB);
    } finally {
      process.argv = originalArgv;
    }
  });
});
