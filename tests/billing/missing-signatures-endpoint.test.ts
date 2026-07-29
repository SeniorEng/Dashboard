/**
 * Task #1889 — „Fehlende Unterschriften nach Abschluss": Endpoint-Contract.
 *
 * Die separate obere Box entfällt; ihre termingenaue Info wird über DENSELBEN
 * Endpoint (`GET /time-entries/month-closing/missing-signatures`) in die
 * Abrechnungsliste integriert. Dieser Test sichert den Server-Contract, auf dem die
 * Integration aufsetzt:
 *   • neu `customerId` je Eintrag (zum Gruppieren unter dem Kunden),
 *   • Definition = `completedButUnsignedSqlRaw` (#1586): completed, keine
 *     Direktunterschrift, NICHT unter einem signierten LN, Monat abgeschlossen,
 *   • Erstberatungs-Carve-out bleibt (#1886),
 *   • ein `employee_signed`-abgedeckter Termin erscheint NICHT als „unsigniert"
 *     (Stufen-Abgrenzung: der gehört zu „Wartet auf Kundenunterschrift").
 *
 * ISOLATION: isolierter Monat 2019-05 + dedizierter Test-Mitarbeiter; es wird nur
 * nach den eigenen Termin-IDs gefiltert.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  apiGet,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

const YEAR = 2019;
const MONTH = 5;

let employeeId: number;
let customerId: number;
const apptIds: number[] = [];
const srIds: number[] = [];

function dateOf(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function insertAppt(
  day: number,
  opts: { appointmentType?: string } = {},
): Promise<number> {
  const apptType = opts.appointmentType ?? "kundentermin";
  const r = await db.execute(sql`
    INSERT INTO appointments (customer_id, appointment_type, date, scheduled_start, duration_promised, status, performed_by_employee_id, assigned_employee_id, signature_data)
    VALUES (${customerId}, ${apptType}, ${dateOf(day)}::date, '09:00', 60, 'completed', ${employeeId}, ${employeeId}, NULL)
    RETURNING id
  `);
  const id = Number((r.rows[0] as { id: number }).id);
  apptIds.push(id);
  return id;
}

async function coverWithEmployeeSignedRecord(apptId: number): Promise<void> {
  const r = await db.execute(sql`
    INSERT INTO monthly_service_records (customer_id, employee_id, year, month, record_type, status)
    VALUES (${customerId}, ${employeeId}, ${YEAR}, ${MONTH}, 'monthly', 'employee_signed')
    RETURNING id
  `);
  const srId = Number((r.rows[0] as { id: number }).id);
  srIds.push(srId);
  await db.execute(sql`
    INSERT INTO service_record_appointments (service_record_id, appointment_id) VALUES (${srId}, ${apptId})
  `);
}

async function fetchItems(): Promise<Array<{ id: number; customerId: number; customerName: string; employeeName: string; date: string }>> {
  const res = await apiGet<{ items: Array<{ id: number; customerId: number; customerName: string; employeeName: string; date: string }> }>(
    "/api/time-entries/month-closing/missing-signatures",
  );
  if (res.status !== 200) throw new Error(`endpoint failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.items ?? [];
}

let unsignedApptId: number;
let erstberatungApptId: number;
let employeeSignedApptId: number;

beforeAll(async () => {
  await getAuthCookie();
  const emp = await createTestEmployee({ nachnamePrefix: "t1889" });
  employeeId = emp.id;
  const c = await createTestCustomer({ billingType: "selbstzahler" });
  customerId = c.id as number;

  unsignedApptId = await insertAppt(6); // completed, keine Unterschrift, kein LN
  erstberatungApptId = await insertAppt(7, { appointmentType: "Erstberatung" });
  employeeSignedApptId = await insertAppt(8);
  await coverWithEmployeeSignedRecord(employeeSignedApptId); // unter employee_signed LN

  // Monat für den Test-Mitarbeiter abschließen (kein POST-Endpoint mehr → Direkt-Insert).
  await db.execute(sql`
    INSERT INTO employee_month_closings (user_id, year, month, closed_by_user_id)
    VALUES (${employeeId}, ${YEAR}, ${MONTH}, ${employeeId})
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM employee_month_closings WHERE user_id = ${employeeId} AND year = ${YEAR} AND month = ${MONTH}`);
  if (srIds.length > 0) {
    await db.execute(sql`DELETE FROM service_record_appointments WHERE service_record_id IN (${sql.join(srIds.map((i) => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM monthly_service_records WHERE id IN (${sql.join(srIds.map((i) => sql`${i}`), sql`, `)})`);
  }
  if (apptIds.length > 0) {
    await db.execute(sql`DELETE FROM appointments WHERE id IN (${sql.join(apptIds.map((i) => sql`${i}`), sql`, `)})`);
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Task #1889 — missing-signatures Endpoint-Contract", () => {
  it("unsignierter completed-Termin im geschlossenen Monat erscheint MIT customerId, Datum, Mitarbeiter", async () => {
    const items = await fetchItems();
    const item = items.find((i) => i.id === unsignedApptId);
    expect(item, "unsignierter Termin muss gelistet sein").toBeDefined();
    expect(item!.customerId).toBe(customerId);
    expect(item!.date.startsWith(`${YEAR}-0${MONTH}`)).toBe(true);
    expect(typeof item!.employeeName).toBe("string");
    expect(item!.employeeName.length).toBeGreaterThan(0);
  });

  it("Erstberatung erscheint NICHT (Carve-out #1886)", async () => {
    const items = await fetchItems();
    expect(items.some((i) => i.id === erstberatungApptId)).toBe(false);
  });

  it("employee_signed-abgedeckter Termin erscheint NICHT als unsigniert (Stufen-Abgrenzung)", async () => {
    const items = await fetchItems();
    expect(items.some((i) => i.id === employeeSignedApptId)).toBe(false);
  });
});
