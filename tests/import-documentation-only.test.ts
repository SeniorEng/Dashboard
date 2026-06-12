/**
 * Task #1243 — Vorjahres-Termine echter Pflegekassen-Kunden (ohne
 * Privatzahlung) werden beim Excel-Import NUR als Dokumentation angelegt:
 * Termin-Datensatz ja, Budget-Buchung nein.
 *
 * Hintergrund: Der §45b-Anker wird auf den 1. Januar des laufenden Jahres
 * gebodet (`floorAutoAnchor45bToCurrentYear`). Für Vorjahres-Daten ist das
 * gesetzliche §45b-Budget damit = 0; eine echte Consumption-Buchung würde
 * immer hart blocken ("Budget reicht nicht — … Kunde akzeptiert keine
 * Privatzahlung."). Selbstzahler/privat-zahlende Kunden behalten ihren
 * regulären, abrechenbaren Pfad.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { isWeekend } from "@shared/utils/datetime";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  cleanupCustomer,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;

/** Erster Werktag (Mo–Fr) im Juni des Vorjahres — gespiegelt über `isWeekend`,
 * damit der Importer den Termin nicht wegen Wochenende ablehnt. */
function priorYearWeekday(): string {
  const year = new Date().getFullYear() - 1;
  for (let day = 1; day <= 28; day++) {
    const date = `${year}-06-${String(day).padStart(2, "0")}`;
    if (!isWeekend(date)) return date;
  }
  throw new Error("Kein Werktag im Juni des Vorjahres gefunden");
}

function fixtureRow(
  rowIndex: number,
  customerId: number,
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
    serviceType: "Alltagsbegleitung",
    budgetType: "Entlastungsbetrag",
    pflegekasseName: "",
    pflegekasseIK: "",
    versichertennummer: "",
    pflegegrad: "",
  };
}

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  await runCleanup();
});

describe("Task #1243: Vorjahres-Import als reine Dokumentation (ohne Budgetverbrauch)", () => {
  it("Pflegekasse ohne Privatzahlung: Vorjahres-Zeile wird in der Vorschau als documentationOnly markiert (kein Trim)", async () => {
    const { matchRows, enrichWithBudgetInfo } = await import("../server/services/appointment-import");
    const customer = await createTestCustomer({
      vorname: "Doku",
      nachname: `Vorjahr_${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    await assignEmployeeToCustomer(customer.id, auth.user.id);

    const employeeName = auth.user.displayName ?? `${auth.user.vorname} ${auth.user.nachname}`;
    const date = priorYearWeekday();

    const matched = await matchRows([
      fixtureRow(1, customer.id, date, { vorname: customer.vorname as string, nachname: customer.nachname as string }, employeeName),
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0].status).toBe("new");

    await enrichWithBudgetInfo(matched);
    expect(matched[0].documentationOnly).toBe(true);
    // Reine Dokumentation → keine Kürzungs-Berechnung.
    expect(matched[0].budgetTrimInfo).toBeNull();

    await cleanupCustomer(customer.id);
  }, 30000);

  it("executeImport: legt den Termin als 'completed' an, zählt documentationOnly++ und bucht KEINE Budget-Transaktion", async () => {
    const { matchRows, executeImport } = await import("../server/services/appointment-import");
    const { db } = await import("../server/lib/db");
    const { appointments, budgetTransactions } = await import("@shared/schema");

    const customer = await createTestCustomer({
      vorname: "Doku",
      nachname: `Exec_${Date.now()}`,
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    await assignEmployeeToCustomer(customer.id, auth.user.id);

    const employeeName = auth.user.displayName ?? `${auth.user.vorname} ${auth.user.nachname}`;
    const date = priorYearWeekday();

    const matched = await matchRows([
      fixtureRow(20, customer.id, date, { vorname: customer.vorname as string, nachname: customer.nachname as string }, employeeName),
    ]);
    expect(matched[0].status).toBe("new");

    const result = await executeImport(matched, [{ action: "import", rowIndex: 20 }], auth.user.id);

    expect(result.errors).toHaveLength(0);
    expect(result.documentationOnly).toBe(1);
    // NICHT als regulärer Import gezählt — Doku-Pfad ist eigener Eimer.
    expect(result.imported).toBe(0);

    // Termin existiert als completed, Notes-Präfix bleibt "Import aus Altdaten"
    // (damit Leistungsnachweis-Synthese ihn weiter findet).
    const appts = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.customerId, customer.id), eq(appointments.date, date)));
    expect(appts).toHaveLength(1);
    expect(appts[0].status).toBe("completed");
    expect(appts[0].notes ?? "").toContain("Import aus Altdaten");

    // Kernassertion: KEINE Budget-Buchung für diesen Termin.
    const tx = await db
      .select()
      .from(budgetTransactions)
      .where(eq(budgetTransactions.appointmentId, appts[0].id));
    expect(tx).toHaveLength(0);

    await cleanupCustomer(customer.id);
  }, 30000);

  it("Selbstzahler: Vorjahres-Zeile bleibt abrechenbar (NICHT documentationOnly)", async () => {
    const { matchRows, enrichWithBudgetInfo } = await import("../server/services/appointment-import");
    const customer = await createTestCustomer({
      vorname: "Selbst",
      nachname: `Zahler_${Date.now()}`,
      pflegegrad: 3,
      billingType: "selbstzahler",
    });
    await assignEmployeeToCustomer(customer.id, auth.user.id);

    const employeeName = auth.user.displayName ?? `${auth.user.vorname} ${auth.user.nachname}`;
    const date = priorYearWeekday();

    const matched = await matchRows([
      fixtureRow(30, customer.id, date, { vorname: customer.vorname as string, nachname: customer.nachname as string }, employeeName),
    ]);
    expect(matched[0].status).toBe("new");

    await enrichWithBudgetInfo(matched);
    expect(matched[0].documentationOnly).toBe(false);

    await cleanupCustomer(customer.id);
  }, 30000);
});
