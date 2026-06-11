/**
 * Task #1197 — Startup-Migration `backfillMissingImportConsumption` (Task #1191)
 * end-to-end gegen eine echte DB.
 *
 * Hintergrund: Die Dev-DB hat keine Import-Batches, deshalb konnte der
 * Live-Buchungspfad der Startup-Migration (Import-Termin ohne Consumption
 * finden → Kaskade erstbuchen → erzeugte `budget_transactions` mit der
 * `import_batch_id` des Termins stempeln → Audit `appointment_km_rebooked`
 * mit `firstTimeBooking: true` und Trigger `appointment_import:backfill`
 * schreiben) bisher nur über seine Einzelteile, nicht end-to-end verifiziert
 * werden. Dieser Test lockt das Verhalten fest:
 *
 *   (1) Ein Kunde mit gefülltem §45b-Topf und ein `completed` Termin MIT
 *       `import_batch_id`, aber OHNE Consumption-Tx wird angelegt.
 *   (2) Die Migration läuft durch den Guarded-Runner: sie bucht die Consumption
 *       über die Kaskade, stempelt die neuen Rows mit der `import_batch_id` des
 *       Termins und schreibt eine Audit-Zeile mit `firstTimeBooking: true` und
 *       Trigger `appointment_import:backfill`.
 *   (3) Ein zweiter Lauf ist ein No-Op (Ledger-Gate; und logisch: es bleibt kein
 *       consumption-freier Import-Termin übrig).
 *   (4) Ein NICHT-importierter consumption-freier Termin bleibt unangetastet.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  getAuthCookie,
  runCleanup,
  cleanupCustomer,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPost,
  apiPut,
} from "./test-utils";
import { db } from "../server/lib/db";
import {
  appointments,
  appointmentServices,
  auditLog,
  budgetTransactions,
  importBatches,
  services as servicesTable,
} from "@shared/schema";
import { ensureMigrationLedger } from "../server/startup/ensure-migration-ledger";
import { runGuardedBudgetMigration } from "../server/startup/budget-migration-runner";
import { backfillMissingImportConsumption } from "../server/startup/backfill-missing-import-consumption";
import { findMissingConsumptionAppointments } from "../server/scripts/backfill-missing-import-consumption";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";

/**
 * Eindeutiger Test-Migrationsname: wir fahren die ECHTE Migrations-Funktion,
 * gaten sie aber unter einem eigenen Ledger-Namen, damit der Produktionsname
 * (`backfill-missing-import-consumption-1191`, beim App-Boot bereits geledgert)
 * den Test nicht beeinflusst.
 */
const TEST_MIGRATION_NAME = "__test1197_backfill_missing_import_consumption";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let serviceId: number;
let importedApptId: number;
let nonImportedApptId: number;
let importBatchId: number;

function nextWeekday(offset = 1): string {
  const d = new Date();
  let added = 0;
  while (added < offset || d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().split("T")[0];
}

/**
 * Legt einen `completed` Termin OHNE Consumption-Tx an (reproduziert den
 * fehlerhaften Bestand). `importBatchIdValue=null` ⇒ ein Nicht-Import-Termin,
 * den die Migration NICHT anfassen darf.
 */
async function insertCompletedAppointmentWithoutConsumption(
  date: string,
  importBatchIdValue: number | null,
): Promise<number> {
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      createdByUserId: auth.user.id,
      assignedEmployeeId: auth.user.id,
      performedByEmployeeId: auth.user.id,
      appointmentType: "Kundentermin",
      date,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "completed",
      actualStart: "09:00",
      actualEnd: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      travelMinutes: 0,
      customerKilometers: 0,
      notes: "Import aus Altdaten",
      importBatchId: importBatchIdValue,
      signedAt: new Date(),
      signedByUserId: auth.user.id,
    })
    .returning();

  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId,
    plannedDurationMinutes: 60,
    actualDurationMinutes: 60,
    details: "Import: Hauswirtschaft",
  });

  return appt.id;
}

function liveConsumption(
  txs: Array<{
    id: number;
    type: string | null;
    reversedTransactionId: number | null;
    apptId: number | null;
    importBatchId: number | null;
    hw: number | null;
  }>,
  apptId: number,
) {
  const reversedIds = new Set(
    txs.filter((t) => t.type === "reversal").map((t) => t.reversedTransactionId),
  );
  return txs.filter(
    (t) => t.type === "consumption" && t.apptId === apptId && !reversedIds.has(t.id),
  );
}

async function consumptionTxsForAppt(apptId: number) {
  return db
    .select({
      id: budgetTransactions.id,
      type: budgetTransactions.transactionType,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
      apptId: budgetTransactions.appointmentId,
      importBatchId: budgetTransactions.importBatchId,
      hw: budgetTransactions.hauswirtschaftMinutes,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.appointmentId, apptId));
}

async function clearTestLedger(): Promise<void> {
  await db.execute(
    sql`DELETE FROM budget_migrations WHERE name = ${TEST_MIGRATION_NAME}`,
  );
}

beforeAll(async () => {
  auth = await getAuthCookie();
  await ensureMigrationLedger();
  await clearTestLedger();

  const customer = await createTestCustomer({
    nachname: `ImportBackfillMig_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
  });
  customerId = customer.id;
  await assignEmployeeToCustomer(customerId, auth.user.id);

  // Gefüllter §45b-Topf, damit die Kaskade die Consumption tatsächlich buchen
  // kann (sonst Hard-Block → kein Beweis für den Buchungspfad).
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      {
        budgetType: "entlastungsbetrag_45b",
        priority: 1,
        enabled: true,
        monthlyLimitCents: 13100,
      },
    ],
  });
  // §45b-Startwert innerhalb des statutarischen Caps (≤ 131 €/berechtigtem
  // Monat). Ein zu hoher Wert würde der Server-Cap mit 400 ablehnen ⇒ keine
  // materialisierte Allocation-Zeile, die Buchung liefe dann nur über die
  // §45b-FIFO-Projektion und der Conservation-Guard würde fälschlich eine
  // Topf-Überziehung melden.
  const initialBudgetRes = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: `${new Date().getFullYear()}-01-01`,
  });
  if (initialBudgetRes.status !== 200 && initialBudgetRes.status !== 201) {
    throw new Error(
      `initial-budget Setup fehlgeschlagen: ${initialBudgetRes.status} ${JSON.stringify(initialBudgetRes.data)}`,
    );
  }

  const all = await db.select().from(servicesTable);
  const hauswirtschaft = all.find(
    (s) => /hauswirtschaft/i.test(s.name ?? "") || /hauswirtschaft/i.test(s.code ?? ""),
  );
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  serviceId = hauswirtschaft.id;

  const [batch] = await db
    .insert(importBatches)
    .values({
      fileName: "Test1197.xlsx",
      fileHash: `test1197-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rowCount: 1,
      importedCount: 1,
      createdByUserId: auth.user.id,
    })
    .returning();
  importBatchId = batch.id;

  importedApptId = await insertCompletedAppointmentWithoutConsumption(
    nextWeekday(1),
    importBatchId,
  );
  nonImportedApptId = await insertCompletedAppointmentWithoutConsumption(
    nextWeekday(2),
    null,
  );
});

afterAll(async () => {
  await clearTestLedger();
  await cleanupCustomer(customerId);
  await runCleanup();
});

describe("Startup-Migration: fehlende Import-Consumption nachbuchen (Task #1197)", () => {
  it("Vorbedingung: importierter Termin hat KEINE Consumption-Tx", async () => {
    const txs = await consumptionTxsForAppt(importedApptId);
    expect(txs.filter((t) => t.type === "consumption").length).toBe(0);
  });

  it("Guarded-Runner bucht Consumption, stempelt import_batch_id und schreibt das First-Time-Booking-Audit", async () => {
    const outcome = await runGuardedBudgetMigration({
      name: TEST_MIGRATION_NAME,
      migrate: backfillMissingImportConsumption,
    });
    expect(outcome).toBe("applied");

    // Live-Consumption für den Import-Termin existiert jetzt.
    const txs = await consumptionTxsForAppt(importedApptId);
    const live = liveConsumption(txs, importedApptId);
    expect(live.length).toBeGreaterThanOrEqual(1);
    const liveHw = live.reduce((s, t) => s + (t.hw ?? 0), 0);
    expect(liveHw).toBe(60);

    // Alle Consumption-Rows des Termins tragen die import_batch_id des Termins.
    for (const t of live) {
      expect(t.importBatchId).toBe(importBatchId);
    }

    // Audit-Zeile: appointment_km_rebooked mit firstTimeBooking + Backfill-Trigger.
    const [auditEntry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "appointment_km_rebooked"),
          eq(auditLog.entityType, "appointment"),
          eq(auditLog.entityId, importedApptId),
        ),
      )
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(auditEntry).toBeDefined();
    const meta = auditEntry.metadata as Record<string, unknown> | null;
    expect(meta?.trigger).toBe(REBOOK_TRIGGERS.import.backfill);
    expect(meta?.firstTimeBooking).toBe(true);
    expect(meta?.source).toBe("backfill-missing-import-consumption");
    expect(meta?.importBatchId).toBe(importBatchId);
  }, 120_000);

  it("lässt einen NICHT-importierten consumption-freien Termin unangetastet", async () => {
    const txs = await consumptionTxsForAppt(nonImportedApptId);
    expect(txs.filter((t) => t.type === "consumption").length).toBe(0);
  });

  it("Idempotenz: zweiter Guarded-Lauf wird per Ledger-Gate übersprungen", async () => {
    const outcome = await runGuardedBudgetMigration({
      name: TEST_MIGRATION_NAME,
      migrate: backfillMissingImportConsumption,
    });
    expect(outcome).toBe("skipped");
  });

  it("Idempotenz: ohne Ledger-Gate bleibt die Migration ein No-Op (kein Import-Termin ohne Consumption mehr)", async () => {
    // Es gibt keinen consumption-freien Import-Termin mehr.
    const remaining = await findMissingConsumptionAppointments({ onlyImported: true });
    expect(remaining.some((r) => r.appointmentId === importedApptId)).toBe(false);

    // Ledger-Eintrag entfernen und erneut fahren: jetzt greift NUR die logische
    // Idempotenz (Selektion findet nichts) — changed=0, keine zusätzliche
    // Consumption.
    const before = liveConsumption(await consumptionTxsForAppt(importedApptId), importedApptId);
    await clearTestLedger();

    const outcome = await runGuardedBudgetMigration({
      name: TEST_MIGRATION_NAME,
      migrate: backfillMissingImportConsumption,
    });
    expect(outcome).toBe("applied");

    const after = liveConsumption(await consumptionTxsForAppt(importedApptId), importedApptId);
    expect(after.length).toBe(before.length);
    const afterHw = after.reduce((s, t) => s + (t.hw ?? 0), 0);
    expect(afterHw).toBe(60);
  }, 120_000);
});
