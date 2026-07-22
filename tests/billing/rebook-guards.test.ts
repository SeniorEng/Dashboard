/**
 * Task #1785 — Schutzgitter für Budget-Umwidmung (Umbuchung).
 *
 * `assertRebookAllowed` (server/storage/budget/rebook-guards.ts) läuft in JEDEM
 * Umbuchungs-Pfad VOR jeder Mutation. Dieser Test deckt die beiden Guards über
 * `rebookSingleTransaction` (dünner Wrapper) ab:
 *
 *  1) Monatsabschluss — berührt die Umbuchung einen für den verantwortlichen
 *     Mitarbeiter abgeschlossenen Monat, blockt sie für Admins (403
 *     MONTH_CLOSED), die Geschäftsführung (Superadmin) darf sie aber ausführen.
 *  2) Bereits gestellte Rechnung — hängt der Verbrauch an einer aktiven,
 *     gestellten (nicht-Entwurf, nicht-stornierten) Rechnung, ist die direkte
 *     Umbuchung für ALLE gesperrt (409 ISSUED_INVOICE), auch für den Superadmin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  appointmentServices,
  budgetTransactions,
  employeeMonthClosings,
  invoiceLineItems,
  invoices,
} from "@shared/schema";
import {
  rebookSingleTransaction,
  getRebookMonthPreview,
} from "../../server/storage/budget/rebook-storage";
import {
  RebookIssuedInvoiceError,
  RebookMonthClosedError,
  evaluateRebookBlockers,
} from "../../server/storage/budget/rebook-guards";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
// Beide Termine auf Werktage (createAppt lehnt Wochenenden ab).
const CLOSED_DATE = `${YEAR}-03-16`; // Montag — Monat wird geschlossen
const OPEN_DATE = `${YEAR}-05-15`; // Freitag — Monat bleibt offen

let customerId: number;
let employeeId: number;
let userId: number;
let abServiceId: number;
const cleanupApptIds: number[] = [];

async function createAppt(date: string, scheduledStart: string, scheduledEnd: string): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart,
    scheduledEnd,
    notes: `Rebook-Guard-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId: abServiceId, durationMinutes: 30 }],
  });
  expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
  cleanupApptIds.push(res.data.id);
  await db.update(appointmentServices)
    .set({ actualDurationMinutes: 30 })
    .where(eq(appointmentServices.appointmentId, res.data.id));
  return res.data.id;
}

/** Legt einen Termin + eine rohe §39-Verbrauchsbuchung an (die Quelle der Umbuchung). */
async function seedRebookable(date: string, start: string, end: string): Promise<{ apptId: number; txId: number }> {
  const apptId = await createAppt(date, start, end);
  const [src] = await db.insert(budgetTransactions).values({
    customerId,
    budgetType: "ersatzpflege_39_42a",
    transactionDate: date,
    transactionType: "consumption",
    amountCents: -2380,
    appointmentId: apptId,
    notes: "§39 (Umbuchungs-Quelle)",
    createdByUserId: userId,
  }).returning({ id: budgetTransactions.id });
  return { apptId, txId: src.id };
}

function liveConsumptionCount(apptId: number): Promise<number> {
  return db.select({ id: budgetTransactions.id })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.appointmentId, apptId),
      eq(budgetTransactions.transactionType, "consumption"),
    ))
    .then((rows) => rows.length);
}

beforeAll(async () => {
  const auth = await getAuthCookie();
  userId = auth.user.id;

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Rebook",
    nachname: `Guard-${uniqueId()}`,
    geburtsdatum: "1941-02-02",
    email: `rebook-guard-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000021",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  customerId = custRes.data.id;

  const emp = await createTestEmployee({ nachnamePrefix: "Rebook_Guard" });
  employeeId = emp.id;
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // §45b komfortabel ausgestattet — Ziel der Umbuchung (deckt 2380 locker).
  const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-03-01`,
  });
  expect([200, 201]).toContain(init45b.status);

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  try { await cleanupCustomer(customerId); } catch { /* best-effort (GoBD-Rechnungszeilen) */ }
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("Rebook-Schutzgitter: Monatsabschluss (Task #1785)", () => {
  it("blockt Admins über einen abgeschlossenen Monat, lässt den Superadmin durch", async () => {
    const { apptId, txId } = await seedRebookable(CLOSED_DATE, "09:00", "09:30");

    // Monat des verantwortlichen Mitarbeiters schließen.
    await db.insert(employeeMonthClosings).values({
      userId: employeeId,
      year: YEAR,
      month: 3,
      closedByUserId: userId,
    });

    // Admin (kein Superadmin) → hart geblockt, KEINE Mutation.
    await expect(
      rebookSingleTransaction(customerId, txId, "entlastungsbetrag_45b", userId, false),
    ).rejects.toBeInstanceOf(RebookMonthClosedError);
    // Quelle unverändert (kein Storno gebucht).
    expect(await liveConsumptionCount(apptId)).toBe(1);

    // Superadmin → darf umbuchen (Guard übersprungen), Rebook läuft durch.
    const result = await rebookSingleTransaction(customerId, txId, "entlastungsbetrag_45b", userId, true);
    expect(result.amountCents).toBe(2380);
    expect(result.reversalTransaction).toBeTruthy();
    expect(result.newTransaction?.budgetType).toBe("entlastungsbetrag_45b");
  }, 120_000);
});

describe("Rebook-Schutzgitter: bereits gestellte Rechnung (Task #1785)", () => {
  it("blockt Admin UND Superadmin, wenn der Verbrauch an einer gestellten Rechnung hängt", async () => {
    const { apptId, txId } = await seedRebookable(OPEN_DATE, "10:00", "10:30");

    // Aktive, gestellte (versendete) Rechnung mit Zeile auf diesen Termin.
    const [inv] = await db.insert(invoices).values({
      invoiceNumber: `TEST-RB-${uniqueId()}`,
      customerId,
      billingType: "pflegekasse_gesetzlich",
      invoiceType: "rechnung",
      billingMonth: 5,
      billingYear: YEAR,
      recipientName: "Test Pflegekasse",
      status: "versendet",
    }).returning({ id: invoices.id });
    await db.insert(invoiceLineItems).values({
      invoiceId: inv.id,
      appointmentId: apptId,
      appointmentDate: OPEN_DATE,
      serviceDescription: "Alltagsbegleitung",
      durationMinutes: 30,
      unitPriceCents: 2380,
      totalCents: 2380,
    });

    // Superadmin umgeht NUR den Monatsabschluss, NICHT die gestellte Rechnung.
    await expect(
      rebookSingleTransaction(customerId, txId, "entlastungsbetrag_45b", userId, true),
    ).rejects.toBeInstanceOf(RebookIssuedInvoiceError);
    await expect(
      rebookSingleTransaction(customerId, txId, "entlastungsbetrag_45b", userId, false),
    ).rejects.toBeInstanceOf(RebookIssuedInvoiceError);

    // Quelle unverändert (kein Storno gebucht).
    expect(await liveConsumptionCount(apptId)).toBe(1);
  }, 120_000);
});

describe("Rebook-Vorschau: Blocker vorab (Task #1827)", () => {
  it("meldet den bereits-abgerechnet-Blocker für ALLE Rollen (inkl. Superadmin)", async () => {
    const BILLED_DATE = `${YEAR}-08-14`; // Freitag
    const { apptId } = await seedRebookable(BILLED_DATE, "11:00", "11:30");

    const [inv] = await db.insert(invoices).values({
      invoiceNumber: `TEST-RBP-${uniqueId()}`,
      customerId,
      billingType: "pflegekasse_gesetzlich",
      invoiceType: "rechnung",
      billingMonth: 8,
      billingYear: YEAR,
      recipientName: "Test Pflegekasse",
      status: "versendet",
    }).returning({ id: invoices.id });
    await db.insert(invoiceLineItems).values({
      invoiceId: inv.id,
      appointmentId: apptId,
      appointmentDate: BILLED_DATE,
      serviceDescription: "Alltagsbegleitung",
      durationMinutes: 30,
      unitPriceCents: 2380,
      totalCents: 2380,
    });

    for (const isSuperAdmin of [false, true]) {
      const preview = await getRebookMonthPreview({ customerId, year: YEAR, month: 8, actor: { userId, isSuperAdmin } });
      expect(preview.blockers.issuedInvoice, `issuedInvoice (superadmin=${isSuperAdmin})`).toBe(true);
      expect(preview.blockers.issuedInvoiceAppointmentIds).toContain(apptId);
      // (c) Vorschau- und Ausführungs-Ableitung liefern denselben Status.
      const direct = await evaluateRebookBlockers([apptId], { userId, isSuperAdmin });
      expect(preview.blockers).toEqual(direct);
    }
  }, 120_000);

  it("meldet Monat-abgeschlossen nur für Nicht-Superadmins (nicht abgerechnet)", async () => {
    const CLOSED_ONLY_DATE = `${YEAR}-09-15`; // Dienstag
    const { apptId } = await seedRebookable(CLOSED_ONLY_DATE, "12:00", "12:30");

    await db.insert(employeeMonthClosings).values({
      userId: employeeId,
      year: YEAR,
      month: 9,
      closedByUserId: userId,
    });

    const adminPreview = await getRebookMonthPreview({ customerId, year: YEAR, month: 9, actor: { userId, isSuperAdmin: false } });
    expect(adminPreview.blockers.monthClosed).toBe(true);
    expect(adminPreview.blockers.monthClosedAppointmentIds).toContain(apptId);
    expect(adminPreview.blockers.issuedInvoice).toBe(false);

    const superPreview = await getRebookMonthPreview({ customerId, year: YEAR, month: 9, actor: { userId, isSuperAdmin: true } });
    expect(superPreview.blockers.monthClosed).toBe(false);
    expect(superPreview.blockers.monthClosedAppointmentIds).toEqual([]);

    // (c) Parität mit der direkten SSoT-Ableitung für beide Rollen.
    expect(adminPreview.blockers).toEqual(await evaluateRebookBlockers([apptId], { userId, isSuperAdmin: false }));
    expect(superPreview.blockers).toEqual(await evaluateRebookBlockers([apptId], { userId, isSuperAdmin: true }));
  }, 120_000);
});
