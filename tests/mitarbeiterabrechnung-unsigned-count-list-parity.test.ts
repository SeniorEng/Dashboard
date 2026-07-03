/**
 * Task #1569 — Übersichts-Zähler „Noch nicht abrechenbar" ≡ Detailliste.
 *
 * Der Überblick zählt unsignierte, dokumentierte Termine je Mitarbeiter
 * (`unsignedAppointmentCount`/`unsignedMinutes`, SSoT in
 * `server/storage/time-tracking/payroll-hours.ts`) OHNE Kunden-Join. Die
 * Detailliste (GET /mitarbeiterabrechnung/unsigned-appointments) holt die
 * Termine über einen LEFT JOIN auf `customers` — Zähler (Anzahl + Minuten) und
 * Detailliste (Länge + Summe Minuten) MÜSSEN deckungsgleich sein.
 *
 * Task #1586 — Carve-out: Erstberatungen (`appointment_type = 'Erstberatung'`)
 * werden dokumentiert, bekommen aber NIE eine Unterschrift (kein Kunde). Sie
 * sind aus der SSoT „completed, aber unsigniert" ausgeschlossen und dürfen
 * daher WEDER im Zähler NOCH in der Detailliste auftauchen. Der einzige real
 * mögliche kundenlose Fall ist eine Erstberatung — sie wird hier als
 * ausgeschlossen behauptet; ein normaler Termin (mit Kunde, completed,
 * unsigniert) bleibt gezählt und gelistet (Invariante Zähler ≡ Liste hält).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  apiGet,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  assignEmployeeToCustomer,
  createAndDocumentAppointment,
} from "./test-utils";

async function getSeededHauswirtschaftServiceId(): Promise<number> {
  const res = await db.execute(
    sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`,
  );
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

// Fester historischer Jahrgang; die Aggregation filtert strikt auf unsere
// brandneue performed_by_employee_id ⇒ keine Kollision mit Fremddaten.
const YEAR = 2019;
const MONTH = 4;
const DATE_WITH_CUSTOMER = `${YEAR}-04-10`;
const DATE_ORPHAN = `${YEAR}-04-11`;

const MIN_WITH_CUSTOMER = 120; // 2.0 h
const MIN_ORPHAN = 45; //        0.75 h

interface OverviewRow {
  employeeId: number;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
}
interface OverviewResponse {
  rows: OverviewRow[];
}
interface UnsignedAppt {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  minutes: number;
}
interface UnsignedResponse {
  appointments: UnsignedAppt[];
}

describe("Task #1569: Übersichts-Zähler ≡ Detailliste (Noch nicht abrechenbar)", () => {
  let customerId: number;
  let employeeId: number;
  let prospectId: number;
  let apptWithCustomerId: number;
  let apptOrphanId: number;

  async function getOverviewRow(): Promise<OverviewRow> {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/mitarbeiterabrechnung?year=${YEAR}&month=${MONTH}`,
    );
    expect(res.status).toBe(200);
    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, `Mitarbeiter ${employeeId} muss eine Übersichts-Zeile haben`).toBeDefined();
    return row!;
  }

  async function getUnsignedList(): Promise<UnsignedAppt[]> {
    const res = await apiGet<UnsignedResponse>(
      `/api/admin/mitarbeiterabrechnung/unsigned-appointments?year=${YEAR}&month=${MONTH}&employeeId=${employeeId}`,
    );
    expect(res.status).toBe(200);
    return res.data.appointments;
  }

  // Macht einen frisch dokumentierten Termin zu „completed & unsigniert" für
  // unseren Mitarbeiter im Zielmonat: exakte HW-Minuten, keine Unterschrift.
  async function makeCompletedUnsigned(appointmentId: number, date: string, minutes: number) {
    await db.execute(sql`
      UPDATE appointments
      SET date = ${date},
          status = 'completed',
          signature_data = NULL,
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId}
      WHERE id = ${appointmentId}
    `);
    await db.execute(sql`
      UPDATE appointment_services
      SET actual_duration_minutes = ${minutes}
      WHERE appointment_id = ${appointmentId}
    `);
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    const serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestUnsignedParity" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    const a1 = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: MIN_WITH_CUSTOMER,
    });
    apptWithCustomerId = a1.appointmentId;
    await makeCompletedUnsigned(apptWithCustomerId, DATE_WITH_CUSTOMER, MIN_WITH_CUSTOMER);

    // Kern-Fall (Task #1586): Termin OHNE auflösbaren Kunden. Der einzige real
    // mögliche Fall ist ein Interessenten-Termin (Erstberatung): der CHECK-Constraint
    // `appointments_prospect_or_customer_check` verlangt prospect_id ODER
    // customer_id, und die FK verhindert einen verwaisten customer_id-Verweis —
    // also customer_id NULL + prospect_id gesetzt. Erstberatungen werden
    // dokumentiert (status='completed'), aber nie unterschrieben; sie sind aus
    // der SSoT „completed, aber unsigniert" ausgeschlossen und dürfen weder im
    // Zähler noch in der Liste erscheinen. Mit dem kanonischen appointment_type
    // 'Erstberatung' (groß) angelegt. Direkt per SQL (keine Budget-Transaktionen),
    // damit die Aufräumung nicht am GoBD-Trigger scheitert.
    const prospectRes = await db.execute(sql`
      INSERT INTO prospects (vorname, nachname, status)
      VALUES ('Test1569', 'OrphanProspect', 'neu')
      RETURNING id
    `);
    prospectId = Number((prospectRes.rows[0] as { id: number }).id);

    const apptRes = await db.execute(sql`
      INSERT INTO appointments (
        prospect_id, customer_id, appointment_type, date,
        scheduled_start, scheduled_end, duration_promised, status,
        signature_data, performed_by_employee_id, assigned_employee_id
      ) VALUES (
        ${prospectId}, NULL, 'Erstberatung', ${DATE_ORPHAN},
        '09:00:00', '09:45:00', ${MIN_ORPHAN}, 'completed',
        NULL, ${employeeId}, ${employeeId}
      ) RETURNING id
    `);
    apptOrphanId = Number((apptRes.rows[0] as { id: number }).id);
    await db.execute(sql`
      INSERT INTO appointment_services (
        appointment_id, service_id, planned_duration_minutes, actual_duration_minutes
      ) VALUES (${apptOrphanId}, ${serviceId}, ${MIN_ORPHAN}, ${MIN_ORPHAN})
    `);
  });

  afterAll(async () => {
    // Orphan-Termin explizit entfernen (cleanupCustomer erreicht ihn nicht, da er
    // mit keinem Kunden verknüpft ist).
    await db.execute(sql`DELETE FROM appointment_services WHERE appointment_id = ${apptOrphanId}`);
    await db.execute(sql`DELETE FROM appointments WHERE id = ${apptOrphanId}`);
    await db.execute(sql`DELETE FROM prospects WHERE id = ${prospectId}`);
    await db.execute(sql`DELETE FROM employee_hours_accounts WHERE user_id = ${employeeId}`);
    await db.execute(sql`DELETE FROM employee_month_closings WHERE user_id = ${employeeId}`);
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("zählt nur den Nicht-Erstberatungs-Termin — die Erstberatung ist aus Zähler UND Liste ausgeschlossen", async () => {
    const overview = await getOverviewRow();
    const list = await getUnsignedList();

    // Kontroll-Anker: genau EIN Termin (der mit Kunde), Erstberatung fällt raus.
    expect(overview.unsignedAppointmentCount).toBe(1);
    expect(overview.unsignedMinutes).toBe(MIN_WITH_CUSTOMER);

    // Kern-Invariante: Zähler ≡ Detailliste (Anzahl + Summe Minuten).
    expect(list.length).toBe(overview.unsignedAppointmentCount);
    const listMinutes = list.reduce((s, a) => s + a.minutes, 0);
    expect(listMinutes).toBe(overview.unsignedMinutes);

    // Der Nicht-Erstberatungs-Termin ist vorhanden …
    expect(list.some((a) => a.id === apptWithCustomerId)).toBe(true);
    // … die dokumentierte, unsignierte Erstberatung NICHT (Task #1586).
    expect(
      list.find((a) => a.id === apptOrphanId),
      "Erstberatung darf nicht als unsigniert gelistet werden",
    ).toBeUndefined();
  });

  it("fällt auf 0, sobald der gezählte Termin unterschrieben ist (Zähler UND Liste)", async () => {
    await db.execute(sql`
      UPDATE appointments
      SET signature_data = 'data:image/png;base64,SIGNED_1569'
      WHERE id IN (${apptWithCustomerId}, ${apptOrphanId})
    `);

    const overview = await getOverviewRow();
    const list = await getUnsignedList();

    expect(overview.unsignedAppointmentCount).toBe(0);
    expect(overview.unsignedMinutes).toBe(0);
    expect(list.length).toBe(0);
  });
});
