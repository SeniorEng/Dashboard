/**
 * Task #643 — Drift-Detektor: Import-Update-Pfad koppelt Budget-Ledger an Termin.
 *
 * Hintergrund: `executeImport` schrieb im Update-Zweig nur die neuen km und
 * eine Notiz in die `appointments`-Zeile. Die zugehörige
 * `budget_transactions`-Consumption blieb auf den ALTEN Werten stehen
 * (Drift Frau Schröder, Termin 12.01.2026: Termin 7,3 km, Ledger 70 km).
 *
 * Dieser Test:
 *   (a) legt per `executeImport` (action `import`) einen Termin mit km=70 an,
 *   (b) führt denselben Termin per action `update` auf km=7,3,
 *   (c) verifiziert, dass die Budget-Transaktion nach dem Update auf
 *       quantize(7,3) km steht — und NICHT mehr auf 70 km.
 *
 * Ohne den Fix in `executeImport` muss der Test rot werden (Σ tx.travelKm
 * bleibt bei 70).
 */
// @ts-nocheck

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPost,
  apiPut,
} from "../test-utils";
import { db } from "../../server/lib/db";
import { appointments, appointmentServices, budgetTransactions, services as servicesTable, auditLog } from "@shared/schema";
import { quantizeKm } from "@shared/domain/invoice-line-items";
import { REBOOK_TRIGGERS } from "@shared/domain/budget-rebook-triggers";
import type { MatchedRow } from "../../server/services/appointment-import";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let serviceId: number;
let serviceIdAb: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `ImportUpdateDrift_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
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
  const alltagsbegleitung = all.find(
    (s) => /alltagsbegleitung/i.test(s.name ?? "") || /alltagsbegleitung/i.test(s.code ?? ""),
  );
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  if (!alltagsbegleitung) throw new Error("Service Alltagsbegleitung nicht gefunden");
  serviceId = hauswirtschaft.id;
  serviceIdAb = alltagsbegleitung.id;
});

afterAll(async () => {
  await runCleanup();
});

function nextWeekday(): string {
  const d = new Date();
  // bis zum nächsten Werktag (Mo–Fr) vorrücken
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().split("T")[0];
}

describe("Equality: Import-Update koppelt Budget-Ledger an Termin (Task #643)", () => {
  it("nach Import-Update steht Σ tx.travelKm auf quantize(neue km), nicht mehr auf alten km", async () => {
    const { executeImport } = await import("../../server/services/appointment-import");
    const date = nextWeekday();

    const baseRow: MatchedRow = {
      rowIndex: 1,
      kundeRaw: "Test",
      kundeId: String(customerId),
      vorname: "Test",
      nachname: "Auto",
      date,
      startTime: "09:00",
      endTime: "10:00",
      durationMinutes: 60,
      kilometers: 70, // Alt-Wert (Drift-Quelle)
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
      status: "new",
      errors: [],
      existingAppointmentId: null,
      differences: [],
      budgetTrimInfo: null,
      diff: null,
    };

    const importResult = await executeImport(
      [baseRow],
      [{ action: "import", rowIndex: 1 }],
      auth.user.id,
    );
    expect(importResult.imported).toBe(1);

    const [createdAppt] = await db
      .select({ id: appointments.id, travelKm: appointments.travelKilometers })
      .from(appointments)
      .where(eq(appointments.customerId, customerId));
    expect(createdAppt).toBeTruthy();
    expect(createdAppt.travelKm).toBe(70);

    const beforeTxs = await db
      .select({ km: budgetTransactions.travelKilometers, type: budgetTransactions.transactionType })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, createdAppt.id));
    const beforeKm = beforeTxs
      .filter((t) => t.type === "consumption")
      .reduce((s, t) => s + (t.km ?? 0), 0);
    expect(beforeKm).toBeGreaterThan(69);

    // Update-Pfad: km=7,3
    const updateRow: MatchedRow = {
      ...baseRow,
      rowIndex: 2,
      kilometers: 7.3,
      status: "duplicate",
      existingAppointmentId: createdAppt.id,
      differences: ["Kilometer: DB=70 → Excel=7.3"],
    };

    const updateResult = await executeImport(
      [updateRow],
      [{ action: "update", rowIndex: 2 }],
      auth.user.id,
    );
    expect(updateResult.updated).toBe(1);
    expect(updateResult.errors).toEqual([]);

    // Drift-Check: Termin zeigt 7,3 km UND Σ aktiver Consumption-Txs zeigt
    // quantize(7,3) km (alte Tx ist storniert, neue Tx steht auf 7,3 km).
    const [afterAppt] = await db
      .select({ travelKm: appointments.travelKilometers })
      .from(appointments)
      .where(eq(appointments.id, createdAppt.id));
    expect(afterAppt.travelKm).toBeCloseTo(7.3, 2);

    const afterTxs = await db
      .select({
        km: budgetTransactions.travelKilometers,
        type: budgetTransactions.transactionType,
        apptId: budgetTransactions.appointmentId,
      })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));

    // Nur die Consumption-Txs, die noch am Termin hängen (alte sind via
    // rebookAppointmentConsumption abgekoppelt → appointmentId = null).
    const liveKm = afterTxs
      .filter((t) => t.type === "consumption" && t.apptId === createdAppt.id)
      .reduce((s, t) => s + (t.km ?? 0), 0);

    expect(liveKm).toBeCloseTo(quantizeKm(7.3), 2);
    expect(liveKm).toBeLessThan(10);
  }, 120_000);

  it("Task #647: Import-Update mit Service-Art-Mismatch HW→AB schreibt richtige Kategorie in DB und Budget-Ledger", async () => {
    const { executeImport, matchRows } = await import("../../server/services/appointment-import");
    const date = nextWeekday();

    // (1) Import als Hauswirtschaft.
    const baseRow: MatchedRow = {
      rowIndex: 10,
      kundeRaw: "Test",
      kundeId: String(customerId),
      vorname: "Test",
      nachname: "Auto",
      date,
      startTime: "11:00",
      endTime: "12:00",
      durationMinutes: 60,
      kilometers: 5,
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
      status: "new",
      errors: [],
      existingAppointmentId: null,
      differences: [],
      budgetTrimInfo: null,
      diff: null,
    };

    const importResult = await executeImport(
      [baseRow],
      [{ action: "import", rowIndex: 10 }],
      auth.user.id,
    );
    expect(importResult.imported).toBe(1);

    const created = await db
      .select({ id: appointments.id, start: appointments.scheduledStart })
      .from(appointments)
      .where(eq(appointments.customerId, customerId));
    const apptRow = created.find((c) => c.start === "11:00:00" || c.start === "11:00");
    if (!apptRow) throw new Error("Test-Termin nicht gefunden");
    const apptId = apptRow.id;

    // Σ HW-Minuten der Consumption-Txs vor Update
    const beforeTxs = await db
      .select({ hw: budgetTransactions.hauswirtschaftMinutes, ab: budgetTransactions.alltagsbegleitungMinutes, type: budgetTransactions.transactionType })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, apptId));
    const beforeHw = beforeTxs.filter(t => t.type === "consumption").reduce((s, t) => s + (t.hw ?? 0), 0);
    const beforeAb = beforeTxs.filter(t => t.type === "consumption").reduce((s, t) => s + (t.ab ?? 0), 0);
    expect(beforeHw).toBe(60);
    expect(beforeAb).toBe(0);

    // (2) Update derselben Zeile als Alltagsbegleitung.
    const updateRow: MatchedRow = {
      ...baseRow,
      rowIndex: 11,
      serviceType: "Alltagsbegleitung",
      serviceId: serviceIdAb,
      status: "duplicate",
      existingAppointmentId: apptId,
      differences: ["Art: DB=hauswirtschaft → Excel=alltagsbegleitung"],
      diff: { serviceCode: { db: "hauswirtschaft", excel: "alltagsbegleitung" } },
    };

    const updateResult = await executeImport(
      [updateRow],
      [{ action: "update", rowIndex: 11 }],
      auth.user.id,
    );
    expect(updateResult.errors).toEqual([]);
    expect(updateResult.updated).toBe(1);

    // appointment_services muss jetzt auf AB stehen.
    const svcRows = await db
      .select({ serviceId: appointmentServices.serviceId, planned: appointmentServices.plannedDurationMinutes })
      .from(appointmentServices)
      .where(eq(appointmentServices.appointmentId, apptId));
    expect(svcRows.length).toBe(1);
    expect(svcRows[0].serviceId).toBe(serviceIdAb);
    expect(svcRows[0].planned).toBe(60);

    // Aktive Consumption-Txs (an Termin gekoppelt) müssen AB-Minuten zeigen.
    const afterTxs = await db
      .select({ hw: budgetTransactions.hauswirtschaftMinutes, ab: budgetTransactions.alltagsbegleitungMinutes, type: budgetTransactions.transactionType, apptId: budgetTransactions.appointmentId })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    const liveHw = afterTxs.filter(t => t.type === "consumption" && t.apptId === apptId).reduce((s, t) => s + (t.hw ?? 0), 0);
    const liveAb = afterTxs.filter(t => t.type === "consumption" && t.apptId === apptId).reduce((s, t) => s + (t.ab ?? 0), 0);
    expect(liveHw).toBe(0);
    expect(liveAb).toBe(60);

    // Audit-Log enthält previous/new ServiceCode + Trigger import:update
    const audits = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, "appointment_km_rebooked"), eq(auditLog.entityId, apptId)));
    const updateAudit = audits.find(a => {
      const m = a.metadata as Record<string, unknown> | null;
      return m?.trigger === REBOOK_TRIGGERS.import.update;
    });
    expect(updateAudit).toBeDefined();
    const meta = updateAudit!.metadata as Record<string, unknown>;
    expect(meta.previousServiceCode).toBe("hauswirtschaft");
    expect(meta.newServiceCode).toBe("alltagsbegleitung");

    // (3) Idempotenz — Re-Match der "alten" Excel-Zeile (jetzt AB) gegen
    //     den aktuellen DB-Stand produziert KEINEN Diff mehr.
    const { customers } = await import("@shared/schema");
    const [custRow] = await db
      .select({ vorname: customers.vorname, nachname: customers.nachname })
      .from(customers)
      .where(eq(customers.id, customerId));
    const reMatched = await matchRows([{
      rowIndex: 12,
      kundeRaw: `${custRow.vorname} ${custRow.nachname}`,
      kundeId: String(customerId),
      vorname: custRow.vorname ?? "",
      nachname: custRow.nachname ?? "",
      date,
      startTime: "11:00",
      endTime: "12:00",
      durationMinutes: 60,
      kilometers: 5,
      employeeName: `${auth.user.vorname} ${auth.user.nachname}`,
      serviceType: "Alltagsbegleitung",
      budgetType: "Entlastungsbetrag",
      pflegekasseName: "",
      pflegekasseIK: "",
      versichertennummer: "",
      pflegegrad: "",
    }]);
    const matched = reMatched.find(r => r.date === date && r.startTime === "11:00");
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("duplicate");
    // Idempotenz-Kernassertion: kein Service-Art-Diff mehr.
    expect(matched!.diff?.serviceCode).toBeUndefined();
    expect(matched!.diff?.durationMinutes).toBeUndefined();
    expect(matched!.diff?.endTime).toBeUndefined();
    expect(matched!.diff?.assignedEmployee).toBeUndefined();
  }, 120_000);
});
