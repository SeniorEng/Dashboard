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
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPost,
  apiPut,
} from "../test-utils";
import { db } from "../../server/lib/db";
import { appointments, budgetTransactions, services as servicesTable } from "@shared/schema";
import { quantizeKm } from "@shared/domain/invoice-line-items";
import type { MatchedRow } from "../../server/services/appointment-import";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let serviceId: number;

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
    currentYearAmountCents: 500000,
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
});
