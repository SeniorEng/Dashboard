/**
 * Task #1190 — Import-Update bucht fehlende §45b-Consumption erstmalig.
 *
 * Hintergrund: Der Excel-Import-Update-Pfad (`executeImport` →
 * `action === "update"`) koppelte das Budget nur über
 * `rebookAppointmentConsumption`. Dieser Rebook ist aber ein No-Op, wenn der
 * Termin GAR KEINE Consumption-Tx besitzt. Ein `completed` Termin, der bei
 * einem früheren Import nur als Datensatz angelegt wurde (ohne Budget-
 * Buchung), blieb deshalb dauerhaft ohne Consumption — das Restbudget des
 * Kunden war zu hoch (Bug Kunde #88 „Wolf, Jens").
 *
 * Dieser Test:
 *   (a) legt einen `completed` Termin OHNE jegliche Consumption-Tx an
 *       (DB-Insert, der den fehlerhaften Bestand reproduziert),
 *   (b) führt denselben Termin per `action === "update"` durch `executeImport`,
 *   (c) verifiziert, dass danach eine §45b-Consumption-Tx existiert,
 *   (d) verifiziert Idempotenz: ein zweiter Update-Lauf erzeugt KEINE zweite
 *       (zusätzliche) Live-Consumption.
 *
 * Ohne den Fix in `executeImport` bleibt nach (b) die Consumption leer und
 * der Test wird rot.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPost,
  apiPut,
} from "./test-utils";
import { db } from "../server/lib/db";
import {
  appointments,
  appointmentServices,
  budgetTransactions,
  services as servicesTable,
} from "@shared/schema";
import type { MatchedRow } from "../server/services/appointment-import";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let serviceId: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `ImportMissingConsumption_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
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
    currentMonthAmountCents: 500000,
    carryoverAmountCents: 0,
    budgetStartDate: `${new Date().getFullYear()}-01-01`,
  });

  const all = await db.select().from(servicesTable);
  const hauswirtschaft = all.find(
    (s) => /hauswirtschaft/i.test(s.name ?? "") || /hauswirtschaft/i.test(s.code ?? ""),
  );
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  serviceId = hauswirtschaft.id;
});

afterAll(async () => {
  await runCleanup();
});

function nextWeekday(): string {
  const d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().split("T")[0];
}

/** Legt einen `completed` Termin OHNE Consumption-Tx an (Bug-Bestand). */
async function insertCompletedAppointmentWithoutConsumption(date: string): Promise<number> {
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
      travelKilometers: 10,
      travelMinutes: 0,
      customerKilometers: 0,
      notes: "Import aus Altdaten",
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
  txs: Array<{ id: number; type: string | null; reversedTransactionId: number | null; apptId: number | null }>,
  apptId: number,
) {
  const reversedIds = new Set(
    txs.filter((t) => t.type === "reversal").map((t) => t.reversedTransactionId),
  );
  return txs.filter(
    (t) => t.type === "consumption" && t.apptId === apptId && !reversedIds.has(t.id),
  );
}

describe("Import-Update bucht fehlende Consumption erstmalig (Task #1190)", () => {
  it("completed Termin OHNE Consumption-Tx bekommt durch Update eine §45b-Consumption", async () => {
    const { executeImport } = await import("../server/services/appointment-import");
    const date = nextWeekday();
    const apptId = await insertCompletedAppointmentWithoutConsumption(date);

    // Vorbedingung: KEINE Consumption-Tx für diesen Termin.
    const before = await db
      .select({ id: budgetTransactions.id, type: budgetTransactions.transactionType })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, apptId));
    expect(before.filter((t) => t.type === "consumption").length).toBe(0);

    const updateRow: MatchedRow = {
      rowIndex: 1,
      kundeRaw: "Test",
      kundeId: String(customerId),
      vorname: "Test",
      nachname: "Auto",
      date,
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      kilometers: 10,
      employeeName: `${auth.user.vorname} ${auth.user.nachname}`,
      serviceType: "Hauswirtschaft",
      budgetType: "Entlastungsbetrag",
      pflegekasseName: "",
      pflegekasseIK: "",
      versichertennummer: "",
      pflegegrad: "",
      customerId,
      employeeId: auth.user.id,
      serviceId,
      budgetTypeKey: "entlastungsbetrag_45b",
      status: "duplicate",
      errors: [],
      existingAppointmentId: apptId,
      differences: ["Kilometer: DB=10 → Excel=10"],
      budgetTrimInfo: null,
      diff: null,
    };

    const updateResult = await executeImport(
      [updateRow],
      [{ action: "update", rowIndex: 1 }],
      auth.user.id,
    );
    expect(updateResult.updated).toBe(1);
    expect(updateResult.errors).toEqual([]);

    // Nach dem Update: genau EINE Live-Consumption mit 60 HW-Minuten.
    const afterTxs = await db
      .select({
        id: budgetTransactions.id,
        type: budgetTransactions.transactionType,
        reversedTransactionId: budgetTransactions.reversedTransactionId,
        apptId: budgetTransactions.appointmentId,
        hw: budgetTransactions.hauswirtschaftMinutes,
        ab: budgetTransactions.alltagsbegleitungMinutes,
      })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));

    const live = liveConsumption(afterTxs, apptId);
    expect(live.length).toBeGreaterThanOrEqual(1);
    const liveHw = live.reduce((s, t) => s + (t.hw ?? 0), 0);
    const liveAb = live.reduce((s, t) => s + (t.ab ?? 0), 0);
    expect(liveHw).toBe(60);
    expect(liveAb).toBe(0);
  }, 120_000);

  it("Idempotenz: zweiter Import-Update bucht keine zusätzliche Live-Consumption", async () => {
    const { executeImport } = await import("../server/services/appointment-import");
    const date = nextWeekday();
    const apptId = await insertCompletedAppointmentWithoutConsumption(date);

    const updateRow: MatchedRow = {
      rowIndex: 5,
      kundeRaw: "Test",
      kundeId: String(customerId),
      vorname: "Test",
      nachname: "Auto",
      date,
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      kilometers: 10,
      employeeName: `${auth.user.vorname} ${auth.user.nachname}`,
      serviceType: "Hauswirtschaft",
      budgetType: "Entlastungsbetrag",
      pflegekasseName: "",
      pflegekasseIK: "",
      versichertennummer: "",
      pflegegrad: "",
      customerId,
      employeeId: auth.user.id,
      serviceId,
      budgetTypeKey: "entlastungsbetrag_45b",
      status: "duplicate",
      existingAppointmentId: apptId,
      differences: [],
      budgetTrimInfo: null,
      diff: null,
    };

    // Erstes Update → Erstbuchung.
    const first = await executeImport([updateRow], [{ action: "update", rowIndex: 5 }], auth.user.id);
    expect(first.updated).toBe(1);

    const afterFirst = await db
      .select({
        id: budgetTransactions.id,
        type: budgetTransactions.transactionType,
        reversedTransactionId: budgetTransactions.reversedTransactionId,
        apptId: budgetTransactions.appointmentId,
        hw: budgetTransactions.hauswirtschaftMinutes,
      })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    const liveFirst = liveConsumption(afterFirst, apptId);
    const liveHwFirst = liveFirst.reduce((s, t) => s + (t.hw ?? 0), 0);

    // Zweites Update mit identischen Werten → Rebook ist No-Op, keine zweite
    // (zusätzliche) Live-Consumption.
    const second = await executeImport(
      [{ ...updateRow, rowIndex: 6 }],
      [{ action: "update", rowIndex: 6 }],
      auth.user.id,
    );
    expect(second.updated).toBe(1);

    const afterSecond = await db
      .select({
        id: budgetTransactions.id,
        type: budgetTransactions.transactionType,
        reversedTransactionId: budgetTransactions.reversedTransactionId,
        apptId: budgetTransactions.appointmentId,
        hw: budgetTransactions.hauswirtschaftMinutes,
      })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    const liveSecond = liveConsumption(afterSecond, apptId);
    const liveHwSecond = liveSecond.reduce((s, t) => s + (t.hw ?? 0), 0);

    expect(liveHwSecond).toBe(liveHwFirst);
    expect(liveHwSecond).toBe(60);
  }, 120_000);
});
