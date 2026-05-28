/**
 * Task #708 — Integrationstest für den Excel-Importer:
 *
 * (1) Upgrade-Pfad: ein vorhandener `scheduled`/unsignierter Termin, der
 *     auf einen Excel-Eintrag matched, wird durch `executeImport` mit
 *     Action="upgrade" auf `completed` angehoben, mit Actuals + signed_at
 *     versehen und §45b-Verbrauch gebucht.
 *
 * (2) Cutoff-Schutz (Defense-in-Depth): wird `excelCutoff` explizit an
 *     `executeImport` übergeben, werden Mutationen auf Zeilen jenseits
 *     dieses Cutoffs hart blockiert — selbst wenn der Client eine
 *     `matchedRows`-Zeile mit Datum > Cutoff einschmuggelt und eine
 *     passende Action mitliefert.
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
let scheduledApptId: number;
let futureApptId: number;
let hauswirtschaftServiceId: number;

const TARGET_DATE_IN_SCOPE = "2026-09-15"; // Dienstag, Excel-Monat
const FUTURE_DATE_BEYOND_CUTOFF = "2026-10-15"; // Donnerstag, jenseits Cutoff

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `ImportCutoff_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
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
  const { appointments, services: servicesTable } = await import("@shared/schema");

  const allServices = await db.select().from(servicesTable);
  const hauswirtschaft = allServices.find(
    (s) => /hauswirtschaft/i.test(s.name ?? "") || /hauswirtschaft/i.test(s.code ?? ""),
  );
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  hauswirtschaftServiceId = hauswirtschaft.id;

  // (1) Geplanter Termin im Excel-Cutoff-Scope — Kandidat für Upgrade.
  const [scheduledAppt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: auth.user.id,
      date: TARGET_DATE_IN_SCOPE,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "scheduled",
      appointmentType: "Kundentermin",
      travelKilometers: 0,
    })
    .returning({ id: appointments.id });
  scheduledApptId = scheduledAppt.id;

  // (2) Termin im Monat jenseits des Cutoffs — soll NICHT angefasst werden.
  const [futureAppt] = await db
    .insert(appointments)
    .values({
      customerId,
      assignedEmployeeId: auth.user.id,
      date: FUTURE_DATE_BEYOND_CUTOFF,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "scheduled",
      appointmentType: "Kundentermin",
      travelKilometers: 0,
    })
    .returning({ id: appointments.id });
  futureApptId = futureAppt.id;
});

afterAll(async () => {
  await runCleanup();
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

function fixtureRow(
  rowIndex: number,
  date: string,
  customer: { vorname: string; nachname: string },
  employeeName: string,
) {
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

// DB liefert TIME-Spalten als "HH:MM:SS" — der Importer schreibt "HH:MM".
function trimSeconds(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.length >= 5 ? t.slice(0, 5) : t;
}

describe("Task #708: Excel-Import Upgrade-Pfad + Cutoff-Schutz", () => {
  it("matchRows: scheduled+unsigned Termin im Scope wird als 'upgrade' getaggt", async () => {
    const { matchRows } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const { customers } = await import("@shared/schema");
    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    const result = await matchRows([
      fixtureRow(1, TARGET_DATE_IN_SCOPE, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("upgrade");
    expect(result[0].existingAppointmentId).toBe(scheduledApptId);
    expect(result[0].serviceId).toBe(hauswirtschaftServiceId);
  });

  it("executeImport: Upgrade hebt scheduled → completed an, setzt signed_at und bucht §45b-Verbrauch", async () => {
    const { matchRows, executeImport } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const { appointments, customers } = await import("@shared/schema");

    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    const matched = await matchRows([
      fixtureRow(10, TARGET_DATE_IN_SCOPE, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
    ]);

    const before = await get45bConsumptionCents();

    const result = await executeImport(
      matched,
      [{ action: "upgrade", rowIndex: 10 }],
      auth.user.id,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.upgraded).toBe(1);

    const [appt] = await db.select().from(appointments).where(eq(appointments.id, scheduledApptId)).limit(1);
    expect(appt.status).toBe("completed");
    expect(appt.signedAt).not.toBeNull();
    expect(trimSeconds(appt.actualStart)).toBe("09:00");
    expect(trimSeconds(appt.actualEnd)).toBe("10:00");

    const after = await get45bConsumptionCents();
    expect(after).toBeGreaterThan(before);
  });

  it("HTTP /execute lehnt manipulierte Zeilen ohne gültigen previewToken ab (Trust-Boundary)", async () => {
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;
    const { db } = await import("../server/lib/db");
    const { customers } = await import("@shared/schema");
    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);

    const row = {
      ...fixtureRow(1, TARGET_DATE_IN_SCOPE, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
      customerId,
      employeeId: auth.user.id,
      serviceId: hauswirtschaftServiceId,
      budgetTypeKey: "entlastungsbetrag_45b" as const,
      status: "upgrade" as const,
      errors: [] as string[],
      existingAppointmentId: scheduledApptId,
      differences: [] as string[],
      budgetTrimInfo: null,
    };

    // Kein previewToken → 400/422 von zod-Validierung.
    const noToken = await apiPost("/api/admin/import-appointments/execute", {
      rows: [row],
      actions: [{ action: "upgrade", rowIndex: 1 }],
    });
    expect(noToken.status).toBeGreaterThanOrEqual(400);
    expect(noToken.status).toBeLessThan(500);

    // Zufalls-UUID, die nie ge-store-d wurde → 409.
    const fakeToken = await apiPost("/api/admin/import-appointments/execute", {
      rows: [row],
      actions: [{ action: "upgrade", rowIndex: 1 }],
      previewToken: "00000000-0000-4000-8000-000000000000",
    });
    expect(fakeToken.status).toBe(409);
  });

  it("HTTP /execute: manipulierter existingAppointmentId wird abgelehnt (keine DB-Mutation, kein Budget-Booking)", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const { db } = await import("../server/lib/db");
    const { appointments, customers } = await import("@shared/schema");
    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);

    // Frischen scheduled+unsigned Termin für diesen Test anlegen
    // (scheduledApptId wurde vom Upgrade-Test bereits auf completed gehoben).
    const TAMPER_DATE = "2026-09-22";
    const [tamperAppt] = await db
      .insert(appointments)
      .values({
        customerId,
        assignedEmployeeId: auth.user.id,
        date: TAMPER_DATE,
        scheduledStart: "11:00",
        scheduledEnd: "12:00",
        durationPromised: 60,
        status: "scheduled",
        appointmentType: "Kundentermin",
        travelKilometers: 0,
      })
      .returning({ id: appointments.id });

    // Echte XLSX → echter Preview-Call → echter Server-Snapshot im
    // Server-Prozess. Anders kommt die in-memory Cache nicht zustande.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow([
      "Kunde", "Datum", "Start", "Ende", "Stunden", "Kilometer",
      "Senioren Engel", "Art", "Budget",
      "Pflegekasse Name", "IK", "Versichertennummer", "Pflegegrad",
    ]);
    const employeeName = auth.user.displayName ?? `${auth.user.vorname} ${auth.user.nachname}`;
    // Start/Ende: numerische Tages-Fraktionen (Excel-Time-Format).
    ws.addRow([
      `${customerId}|${cust.vorname}|${cust.nachname}`,
      new Date(`${TAMPER_DATE}T00:00:00.000Z`),
      11 / 24, 12 / 24, 1, 0,
      employeeName, "Hauswirtschaft", "Entlastungsbetrag",
      "", "", "", "",
    ]);
    const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
    const form = new FormData();
    form.append("file", new Blob([xlsxBuffer]), "preview.xlsx");
    const previewRes = await fetch(`${process.env.TEST_BASE_URL ?? "http://localhost:5000"}/api/admin/import-appointments/preview`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "x-csrf-token": auth.csrfToken },
      body: form,
    });
    expect(previewRes.status).toBe(200);
    const previewData = await previewRes.json() as {
      rows: Array<Record<string, unknown> & { rowIndex: number; existingAppointmentId: number | null }>;
      previewToken: string;
    };
    expect(previewData.previewToken).toBeTruthy();
    const previewRow = previewData.rows[0];
    expect(previewRow.existingAppointmentId).toBe(tamperAppt.id);

    // Snapshot futureAppt VOR Manipulationsversuch.
    const [beforeFuture] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, futureApptId));
    const consumedBefore = await get45bConsumptionCents();

    // Tampered payload: rowIndex/date/customerId/serviceId passen, aber
    // existingAppointmentId wird auf futureApptId verschoben → 400.
    const tampered = await apiPost("/api/admin/import-appointments/execute", {
      rows: [{ ...previewRow, existingAppointmentId: futureApptId }],
      actions: [{ action: "upgrade", rowIndex: previewRow.rowIndex }],
      previewToken: previewData.previewToken,
    });
    expect(tampered.status).toBe(400);
    expect(JSON.stringify(tampered.data)).toContain("existingAppointmentId");

    // futureAppt unangetastet, kein neuer §45b-Verbrauch.
    const [afterFuture] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, futureApptId));
    expect(afterFuture.status).toBe(beforeFuture.status);
    expect(afterFuture.actualStart).toBe(beforeFuture.actualStart);
    expect(afterFuture.signedAt).toBe(beforeFuture.signedAt);
    expect(await get45bConsumptionCents()).toBe(consumedBefore);
  });

  it("executeImport mit explizitem excelCutoff blockiert manipulierte Zeilen jenseits des Cutoffs (cutoffProtected++)", async () => {
    const { executeImport } = await import("../server/services/appointment-import");
    const { computeLastExcelMonth } = await import("@shared/domain/import-cutoff");
    const { db } = await import("../server/lib/db");
    const { appointments, customers } = await import("@shared/schema");

    const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const employeeName = `${auth.user.vorname} ${auth.user.nachname}`;

    // Echter Excel-Cutoff: Sept 2026 (entspricht der Preview-Berechnung).
    const excelCutoff = computeLastExcelMonth([TARGET_DATE_IN_SCOPE]);
    expect(excelCutoff?.yearMonth).toBe("2026-09");

    // Manipulierte matchedRows: Client schickt eine Zeile mit Datum
    // ausserhalb des Excel-Cutoffs samt voll aufgelöster IDs + Status
    // "upgrade", um die Preview-Klassifizierung zu umgehen.
    const manipulatedRow = {
      ...fixtureRow(99, FUTURE_DATE_BEYOND_CUTOFF, { vorname: cust.vorname!, nachname: cust.nachname! }, employeeName),
      customerId,
      employeeId: auth.user.id,
      serviceId: hauswirtschaftServiceId,
      budgetTypeKey: "entlastungsbetrag_45b" as const,
      status: "upgrade" as const,
      errors: [] as string[],
      existingAppointmentId: futureApptId,
      differences: [] as string[],
      budgetTrimInfo: null,
    };

    const [beforeFuture] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, futureApptId))
      .limit(1);
    const beforeStatus = beforeFuture.status;
    const beforeSignedAt = beforeFuture.signedAt;

    const result = await executeImport(
      [manipulatedRow],
      [{ action: "upgrade", rowIndex: 99 }],
      auth.user.id,
      excelCutoff,
    );

    expect(result.cutoffProtected).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);

    const [afterFuture] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, futureApptId))
      .limit(1);
    expect(afterFuture.status).toBe(beforeStatus);
    expect(afterFuture.signedAt).toBe(beforeSignedAt);
  });
});
