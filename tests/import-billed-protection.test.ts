/**
 * Task #1602 — Integrationstest für den Abrechnungs-Schutz im Excel-Import.
 *
 * Der Haupt-Import-`update`-Pfad überschreibt Termine + rebucht §45b-Verbrauch,
 * bisher nur durch Soft-Delete geschützt. Bereits ABGERECHNETE Bestandstermine
 * (signierter Leistungsnachweis ODER nicht-stornierte Rechnung) dürfen NIE
 * mutiert werden — sonst desynchronisiert der Import einen bereits gestellten
 * LN/eine bereits gestellte Rechnung still.
 *
 * Geprüft wird:
 *  (1) matchRows taggt einen abgerechneten Bestandstermin mit
 *      `billedProtected: true` (sowohl signierter-LN- als auch Rechnungs-Pfad).
 *  (2) executeImport überspringt eine `update`-Aktion auf einem geschützten
 *      Termin hart (result.billedProtected++), ohne den Termin zu mutieren
 *      oder Budget zu rebuchen.
 *  (3) Ein NICHT abgerechneter, dokumentierter Bestandstermin wird weiterhin
 *      normal per `update` aktualisiert (kein False-Positive).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
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
let hauswirtschaftServiceId: number;

// Alle Termine im selben Excel-Monat (Cutoff), damit der Import sie anfasst.
const DATE_SIGNED_LN = "2026-09-08"; // Dienstag
const DATE_INVOICED = "2026-09-09"; // Mittwoch
const DATE_UNBILLED = "2026-09-10"; // Donnerstag

async function insertCompletedAppt(date: string, start: string, end: string): Promise<number> {
  const { db } = await import("../server/lib/db");
  const { appointments } = await import("@shared/schema");
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: auth.user.id,
      performedByEmployeeId: auth.user.id,
      date,
      scheduledStart: start,
      scheduledEnd: end,
      actualStart: start,
      actualEnd: end,
      durationPromised: 60,
      durationActual: 60,
      status: "completed",
      appointmentType: "Kundentermin",
      serviceId: hauswirtschaftServiceId,
      travelKilometers: 0,
    })
    .returning({ id: appointments.id });
  return appt.id;
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `ImportBilled_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
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
  const hauswirtschaft = allServices.find(
    (s) => /hauswirtschaft/i.test(s.name ?? "") || /hauswirtschaft/i.test(s.code ?? ""),
  );
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  hauswirtschaftServiceId = hauswirtschaft.id;
});

afterAll(async () => {
  await runCleanup();
});

function fixtureRow(rowIndex: number, date: string, customer: { vorname: string; nachname: string }, employeeName: string) {
  return {
    rowIndex,
    kundeRaw: `${customer.vorname} ${customer.nachname}`,
    kundeId: String(customerId),
    vorname: customer.vorname,
    nachname: customer.nachname,
    date,
    startTime: "09:00",
    endTime: "10:00",
    durationMinutes: 60,
    kilometers: 0,
    employeeName,
    serviceType: "Hauswirtschaft",
    budgetType: "Entlastungsbetrag",
    pflegekasseName: "",
    pflegekasseIK: "",
    versichertennummer: "",
    pflegegrad: "",
  };
}

describe("Task #1602: Excel-Import Abrechnungs-Schutz", () => {
  it("matchRows taggt abgerechnete Termine (signierter LN + Rechnung) mit billedProtected", async () => {
    const { matchRows } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const {
      customers,
      monthlyServiceRecords,
      serviceRecordAppointments,
      invoices,
      invoiceLineItems,
    } = await import("@shared/schema");

    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    const signedApptId = await insertCompletedAppt(DATE_SIGNED_LN, "09:00", "10:00");
    const invoicedApptId = await insertCompletedAppt(DATE_INVOICED, "09:00", "10:00");
    const unbilledApptId = await insertCompletedAppt(DATE_UNBILLED, "09:00", "10:00");

    // (a) Signierter Leistungsnachweis auf signedApptId.
    const [ln] = await db
      .insert(monthlyServiceRecords)
      .values({
        customerId,
        employeeId: auth.user.id,
        year: 2026,
        month: 9,
        recordType: "single",
        status: "signed",
        employeeSignedAt: new Date(),
        employeeSignedByUserId: auth.user.id,
      })
      .returning({ id: monthlyServiceRecords.id });
    await db.insert(serviceRecordAppointments).values({
      serviceRecordId: ln.id,
      appointmentId: signedApptId,
    });

    // (b) Nicht-stornierte Rechnung mit Line-Item auf invoicedApptId.
    const [inv] = await db
      .insert(invoices)
      .values({
        customerId,
        invoiceNumber: `TEST-1602-${Date.now()}`,
        billingType: "selbstzahler",
        invoiceType: "rechnung",
        billingMonth: 9,
        billingYear: 2026,
        status: "entwurf",
        recipientName: `${cust.vorname} ${cust.nachname}`,
        netAmountCents: 3800,
        grossAmountCents: 3800,
      } as typeof invoices.$inferInsert)
      .returning({ id: invoices.id });
    await db.insert(invoiceLineItems).values({
      invoiceId: inv.id,
      appointmentId: invoicedApptId,
      appointmentDate: DATE_INVOICED,
      serviceDescription: "Hauswirtschaft",
      durationMinutes: 60,
      unitPriceCents: 3800,
      totalCents: 3800,
    } as typeof invoiceLineItems.$inferInsert);

    const rows = await matchRows([
      fixtureRow(1, DATE_SIGNED_LN, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
      fixtureRow(2, DATE_INVOICED, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
      fixtureRow(3, DATE_UNBILLED, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
    ]);

    const bySigned = rows.find((r) => r.existingAppointmentId === signedApptId);
    const byInvoiced = rows.find((r) => r.existingAppointmentId === invoicedApptId);
    const byUnbilled = rows.find((r) => r.existingAppointmentId === unbilledApptId);

    expect(bySigned?.billedProtected).toBe(true);
    expect(byInvoiced?.billedProtected).toBe(true);
    expect(byUnbilled?.billedProtected).toBeFalsy();
  });

  it("executeImport überspringt update auf geschütztem Termin (billedProtected++, keine Mutation/Rebook)", async () => {
    const { matchRows, executeImport } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const {
      customers,
      appointments,
      monthlyServiceRecords,
      serviceRecordAppointments,
    } = await import("@shared/schema");

    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    // Frischer abgerechneter (signierter LN) Termin mit ABWEICHENDER Dauer im
    // Bestand, damit der Import einen echten Diff sieht und mutieren WOLLTE.
    const protectedApptId = await insertCompletedAppt("2026-09-11", "09:00", "09:30");
    const [ln] = await db
      .insert(monthlyServiceRecords)
      .values({
        customerId,
        employeeId: auth.user.id,
        year: 2026,
        month: 9,
        recordType: "single",
        status: "signed",
        customerSignedAt: new Date(),
        customerSignedByUserId: auth.user.id,
      })
      .returning({ id: monthlyServiceRecords.id });
    await db.insert(serviceRecordAppointments).values({
      serviceRecordId: ln.id,
      appointmentId: protectedApptId,
    });

    const [before] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, protectedApptId))
      .limit(1);
    const consumedBefore = await get45bConsumptionCents();

    const matched = await matchRows([
      fixtureRow(20, "2026-09-11", { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
    ]);
    const row = matched.find((r) => r.existingAppointmentId === protectedApptId);
    expect(row?.billedProtected).toBe(true);

    // Erzwinge trotz Schutz eine update-Aktion (simuliert Client-Manipulation
    // auf Service-Ebene) — executeImport MUSS defensiv hart überspringen.
    const result = await executeImport(matched, [{ action: "update", rowIndex: 20 }], auth.user.id);

    expect(result.billedProtected).toBe(1);
    expect(result.updated).toBe(0);

    const [after] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, protectedApptId))
      .limit(1);
    // Start/Ende unverändert (keine Übernahme der Excel-Zeiten 09:00–10:00).
    expect(after.actualStart).toBe(before.actualStart);
    expect(after.actualEnd).toBe(before.actualEnd);
    expect(await get45bConsumptionCents()).toBe(consumedBefore);
  });

  it("executeImport aktualisiert einen NICHT abgerechneten dokumentierten Termin normal (kein False-Positive)", async () => {
    const { matchRows, executeImport } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const { customers, appointments } = await import("@shared/schema");

    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    // Dokumentierter, aber NICHT abgerechneter Termin mit abweichender Zeit.
    const unbilledApptId = await insertCompletedAppt("2026-09-12", "09:00", "09:30");

    const matched = await matchRows([
      fixtureRow(30, "2026-09-12", { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
    ]);
    const row = matched.find((r) => r.existingAppointmentId === unbilledApptId);
    expect(row?.billedProtected).toBeFalsy();

    const result = await executeImport(matched, [{ action: "update", rowIndex: 30 }], auth.user.id);

    expect(result.billedProtected).toBe(0);
    expect(result.updated).toBe(1);

    const [after] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, unbilledApptId))
      .limit(1);
    expect(after.actualStart?.slice(0, 5)).toBe("09:00");
    expect(after.actualEnd?.slice(0, 5)).toBe("10:00");
  });
});

async function get45bConsumptionCents(): Promise<number> {
  const { db } = await import("../server/lib/db");
  const { budgetTransactions } = await import("@shared/schema");
  const [agg] = await db
    .select({ total: sum(budgetTransactions.amountCents).mapWith(Number) })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
        gte(budgetTransactions.transactionDate, "2026-01-01"),
        lte(budgetTransactions.transactionDate, "2026-12-31"),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'reversal')`,
      ),
    );
  return Math.abs(Number(agg?.total ?? 0));
}
