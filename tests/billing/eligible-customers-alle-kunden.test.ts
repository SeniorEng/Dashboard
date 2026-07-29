/**
 * Task #1885 — Alle Kunden in der Rechnungsliste, auch ohne Leistungsnachweis.
 *
 * `GET /api/billing/eligible-customers` startete früher NUR von Kunden mit einem
 * (mitarbeiter-/kunden-)signierten LN im Monat. Kunden mit dokumentierten oder noch
 * offenen Terminen, aber ganz ohne LN, waren unsichtbar. #1885 erweitert die
 * Kandidatenmenge auf ALLE Kunden mit noch nicht vollständig abgerechneter
 * Termin-Aktivität und ergänzt die Gruppe „Leistungsnachweis fehlt noch"
 * (`classifyBillingMaturity === "service_record_missing"`).
 *
 * KRITISCH (#1885 Punkt 4): Sichtbarkeit ≠ Abrechenbarkeit. Die Sammel-Erstellung
 * `POST /generate-all` leitet ihre Menge weiterhin eigenständig aus signierten LNs
 * ab — die neu sichtbaren (LN-losen) Kunden dürfen NICHT angefasst werden.
 *
 * ISOLATION: isolierter historischer Monat (2019-04, den kein anderer Test nutzt),
 * damit der GLOBALE `generate-all`-Lauf ausschließlich die hier geseedeten Kunden
 * trifft. Direkt-Insert (die API-Terminanlage ist auf ~3 Monate begrenzt). Es wird
 * IMMER nur nach der eigenen `customerId` gefiltert, nie über globale Summen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";
import { classifyBillingMaturity } from "@shared/domain/billing-eligibility";
import type { BillingCustomerItem } from "@shared/api";

const YEAR = 2019;
const MONTH = 4;

let employeeId: number;
let hwServiceId: number;
const customerIds: number[] = [];
let invSeq = 0;
const uniq = `t1885-${Date.now()}`;

function dateOf(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Termin (Default kundentermin, completed) inkl. Hauswirtschaft-Service (60 Min). */
async function insertAppointment(
  customerId: number,
  day: number,
  opts: { status?: string; appointmentType?: string; withService?: boolean } = {},
): Promise<number> {
  const status = opts.status ?? "completed";
  const apptType = opts.appointmentType ?? "kundentermin";
  const r = await db.execute(sql`
    INSERT INTO appointments (customer_id, appointment_type, date, scheduled_start, duration_promised, status, performed_by_employee_id, assigned_employee_id)
    VALUES (${customerId}, ${apptType}, ${dateOf(day)}::date, '09:00', 60, ${status}, ${employeeId}, ${employeeId})
    RETURNING id
  `);
  const apptId = Number((r.rows[0] as { id: number }).id);
  if (opts.withService !== false) {
    await db.execute(sql`
      INSERT INTO appointment_services (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
      VALUES (${apptId}, ${hwServiceId}, 60, 60)
    `);
  }
  return apptId;
}

/** Vollständiger (kunden-)signierter LN (status 'completed') über die Termine. */
async function insertCompletedRecord(customerId: number, appointmentIds: number[]): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO monthly_service_records (customer_id, employee_id, year, month, record_type, status)
    VALUES (${customerId}, ${employeeId}, ${YEAR}, ${MONTH}, 'monthly', 'completed')
    RETURNING id
  `);
  const recordId = Number((r.rows[0] as { id: number }).id);
  for (const apptId of appointmentIds) {
    await db.execute(sql`
      INSERT INTO service_record_appointments (service_record_id, appointment_id)
      VALUES (${recordId}, ${apptId})
    `);
  }
  return recordId;
}

/** Aktive Rechnung, die die Termine abdeckt (markiert sie als abgerechnet). */
async function insertInvoiceCovering(customerId: number, appointmentIds: number[]): Promise<void> {
  const number = `${uniq}-${invSeq++}`;
  const r = await db.execute(sql`
    INSERT INTO invoices (invoice_number, customer_id, billing_type, invoice_type, billing_month, billing_year, recipient_name, status)
    VALUES (${number}, ${customerId}, 'selbstzahler', 'rechnung', ${MONTH}, ${YEAR}, 'Testempfänger', 'entwurf')
    RETURNING id
  `);
  const invoiceId = Number((r.rows[0] as { id: number }).id);
  for (const apptId of appointmentIds) {
    await db.execute(sql`
      INSERT INTO invoice_line_items (invoice_id, appointment_id, appointment_date, service_description, duration_minutes, unit_price_cents, total_cents)
      VALUES (${invoiceId}, ${apptId}, ${dateOf(15)}::date, 'Hauswirtschaft', 60, 3800, 3800)
    `);
  }
}

async function fetchList(): Promise<BillingCustomerItem[]> {
  const res = await apiGet<BillingCustomerItem[]>(`/api/billing/eligible-customers?month=${MONTH}&year=${YEAR}`);
  if (res.status !== 200) throw new Error(`eligible-customers failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}
async function rowFor(customerId: number): Promise<BillingCustomerItem | undefined> {
  return (await fetchList()).find((c) => c.id === customerId);
}

async function newCustomer(): Promise<number> {
  const c = await createTestCustomer({ billingType: "selbstzahler" });
  customerIds.push(c.id as number);
  return c.id as number;
}

// Kunden für alle Fälle
let lnMissingId: number; // dokumentiert, KEIN LN → „Leistungsnachweis fehlt noch"
let openOnlyId: number; // nur geplanter Termin → „Noch offene Termine"
let readyId: number; // dokumentiert + signierter LN, keine Rechnung → „Bereit zum Abrechnen"
let billedId: number; // dokumentiert + LN + Rechnung → vollständig abgerechnet (verschwindet)
let erstberatungId: number; // nur Erstberatungstermin → ausgeschlossen (#1886)

beforeAll(async () => {
  await getAuthCookie();
  const emp = await createTestEmployee({ nachnamePrefix: "t1885" });
  employeeId = emp.id;
  const svc = await db.execute(sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`);
  hwServiceId = Number((svc.rows[0] as { id: number }).id);

  lnMissingId = await newCustomer();
  await insertAppointment(lnMissingId, 4, { status: "completed" });

  openOnlyId = await newCustomer();
  await insertAppointment(openOnlyId, 5, { status: "scheduled", withService: false });

  readyId = await newCustomer();
  const readyAppt = await insertAppointment(readyId, 6, { status: "completed" });
  await insertCompletedRecord(readyId, [readyAppt]);

  billedId = await newCustomer();
  const billedAppt = await insertAppointment(billedId, 7, { status: "completed" });
  await insertCompletedRecord(billedId, [billedAppt]);
  await insertInvoiceCovering(billedId, [billedAppt]);

  erstberatungId = await newCustomer();
  await insertAppointment(erstberatungId, 8, { status: "completed", appointmentType: "Erstberatung" });
});

afterAll(async () => {
  for (const id of customerIds) await cleanupCustomer(id);
  await deactivateTestEmployee(employeeId);
});

describe("Task #1885 — Rechnungsliste zeigt alle Kunden, auch ohne Leistungsnachweis", () => {
  it("Kunde mit dokumentiertem Termin OHNE LN erscheint als 'Leistungsnachweis fehlt noch' und ist nicht abrechenbar", async () => {
    const row = await rowFor(lnMissingId);
    expect(row).toBeDefined();
    expect(row!.completedAppointments).toBe(1);
    expect(row!.coveredAppointments).toBe(0);
    expect(row!.eligibility.status).toBe("blocked");
    expect(classifyBillingMaturity(row!)).toBe("service_record_missing");
  });

  it("Kunde mit nur offenem (geplantem) Termin erscheint als 'Noch offene Termine'", async () => {
    const row = await rowFor(openOnlyId);
    expect(row).toBeDefined();
    expect(row!.completedAppointments).toBe(0);
    expect(row!.openAppointments).toBe(1);
    expect(classifyBillingMaturity(row!)).toBe("has_open_appointments");
  });

  it("vollständig abgerechneter Kunde verschwindet aus der Liste", async () => {
    const row = await rowFor(billedId);
    expect(row).toBeUndefined();
  });

  it("Erstberatung/kundenloser Termin erscheint NICHT (#1886)", async () => {
    const row = await rowFor(erstberatungId);
    expect(row).toBeUndefined();
  });

  it("bestehende Gruppe 'Bereit zum Abrechnen' bleibt unveraendert (Regression)", async () => {
    const row = await rowFor(readyId);
    expect(row).toBeDefined();
    expect(row!.eligibility.status).toBe("eligible");
    expect(classifyBillingMaturity(row!)).toBe("ready");
  });

  it("KRITISCH — generate-all fasst nur abrechenbare (LN-)Kunden an, NICHT die neu sichtbaren", async () => {
    const res = await apiPost<{ results: Array<{ customerId: number; status: string }> }>(
      "/api/billing/generate-all",
      { billingMonth: MONTH, billingYear: YEAR, readyOnly: false },
    );
    expect(res.status).toBe(200);
    const results = res.data.results ?? [];
    const idsTouched = new Set(results.map((r) => r.customerId));

    // Der abrechenbare Kunde (mit signiertem LN) wird angefasst …
    expect(idsTouched.has(readyId)).toBe(true);
    // … die neu sichtbaren, LN-losen Kunden NICHT.
    expect(idsTouched.has(lnMissingId)).toBe(false);
    expect(idsTouched.has(openOnlyId)).toBe(false);
    expect(idsTouched.has(erstberatungId)).toBe(false);

    // Sichtbarkeit bleibt: der LN-lose Kunde ist nach dem Bulk-Lauf weiterhin
    // gelistet (er wurde nicht abgerechnet).
    const stillListed = await rowFor(lnMissingId);
    expect(stillListed).toBeDefined();
    expect(classifyBillingMaturity(stillListed!)).toBe("service_record_missing");
  });
});
