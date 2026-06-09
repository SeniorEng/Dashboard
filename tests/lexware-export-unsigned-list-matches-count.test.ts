/**
 * Task #1127 — Termin-Liste muss mit dem Warnungs-Zähler übereinstimmen.
 *
 * Die Stundenübersicht (`GET /api/admin/hours-overview`) zeigt pro Mitarbeiter
 * `unsignedAppointmentCount` („N Termine ohne Unterschrift"). Der Klick-Sprung
 * öffnet die Liste genau dieser Termine über
 * `GET /api/admin/hours-overview/unsigned-appointments`. Beide Endpoints nutzen
 * dasselbe Prädikat (`completedButUnsignedSqlRaw`, `server/lib/appointment-signed.ts`),
 * aber ohne Test fällt eine Drift (anderer Datums-/Mitarbeiter-Filter) nicht auf.
 *
 * Dieser Test garantiert:
 *   - `appointments.length` === `unsignedAppointmentCount` für denselben
 *     Mitarbeiter/Monat,
 *   - jeder gelieferte Termin ist tatsächlich completed UND ohne Unterschrift
 *     (weder direkte `signature_data` noch unterschriebener Leistungsnachweis),
 *   - ein signierter sowie ein noch nicht abgeschlossener Termin tauchen weder
 *     im Zähler noch in der Liste auf.
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
import { validSignatureDataUrl } from "./helpers/valid-signature";

async function getSeededHauswirtschaftServiceId(): Promise<number> {
  const res = await db.execute(
    sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`,
  );
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

// Fester historischer Monat — die Queries filtern strikt auf unsere brandneue
// performed_by_employee_id, daher keine Kollision mit Fremddaten.
const TARGET_YEAR = 2022;
const TARGET_MONTH = 9;
const TARGET_DATE = `${TARGET_YEAR}-0${TARGET_MONTH}-15`;

const HW_MINUTES = 90;
// Anzahl der completed-aber-unsignierten Termine (> 1, damit ein Off-by-one
// zwischen Liste und Zähler sofort auffällt).
const UNSIGNED_COUNT = 3;

interface OverviewRow {
  employeeId: number;
  unsignedAppointmentCount: number;
}
interface OverviewResponse {
  rows: OverviewRow[];
}

interface UnsignedAppointment {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  minutes: number;
}
interface UnsignedListResponse {
  appointments: UnsignedAppointment[];
  year: number;
  month: number;
  employeeId: number;
}

describe("Task #1127: unsigned-appointments-Liste stimmt mit unsignedAppointmentCount überein", () => {
  let customerId: number;
  let employeeId: number;
  let serviceId: number;

  async function seedAppointment(opts: { status: string; signed: boolean }): Promise<number> {
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: HW_MINUTES,
    });

    await db.execute(sql`
      UPDATE appointments
      SET date = ${TARGET_DATE},
          status = ${opts.status},
          signature_data = ${opts.signed ? validSignatureDataUrl() : null},
          performed_by_employee_id = ${employeeId},
          assigned_employee_id = ${employeeId}
      WHERE id = ${appointmentId}
    `);

    await db.execute(sql`
      UPDATE appointment_services
      SET actual_duration_minutes = ${HW_MINUTES}
      WHERE appointment_id = ${appointmentId}
    `);

    return appointmentId;
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestLexList" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // N completed-aber-unsignierte Termine ⇒ müssen gezählt UND gelistet werden.
    for (let i = 0; i < UNSIGNED_COUNT; i++) {
      await seedAppointment({ status: "completed", signed: false });
    }
    // Rauschen, das weder zählt noch gelistet wird:
    await seedAppointment({ status: "completed", signed: true }); // unterschrieben
    await seedAppointment({ status: "documenting", signed: false }); // nicht abgeschlossen
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("liefert exakt so viele Termine wie der Zähler meldet, alle completed + unsigniert", async () => {
    const overview = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(overview.status).toBe(200);

    const row = overview.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, "Zeile für Test-Mitarbeiter muss existieren").toBeDefined();
    expect(row!.unsignedAppointmentCount).toBe(UNSIGNED_COUNT);

    const list = await apiGet<UnsignedListResponse>(
      `/api/admin/hours-overview/unsigned-appointments?year=${TARGET_YEAR}&month=${TARGET_MONTH}&employeeId=${employeeId}`,
    );
    expect(list.status).toBe(200);

    // Kern-Assertion: Listenlänge === Zähler.
    expect(list.data.appointments.length).toBe(row!.unsignedAppointmentCount);

    // Jeder gelieferte Termin muss tatsächlich completed + unsigniert sein.
    const returnedIds = list.data.appointments.map((a) => a.id);
    expect(returnedIds.length).toBe(UNSIGNED_COUNT);

    const verify = await db.execute(sql`
      SELECT
        a.id,
        a.status,
        (a.signature_data IS NOT NULL) AS has_signature,
        EXISTS (
          SELECT 1
          FROM service_record_appointments sra
          JOIN monthly_service_records msr ON msr.id = sra.service_record_id
          WHERE sra.appointment_id = a.id
            AND msr.deleted_at IS NULL
            AND msr.status IN ('employee_signed', 'completed')
        ) AS has_signed_sr
      FROM appointments a
      WHERE a.id = ANY(${sql`ARRAY[${sql.join(returnedIds.map((id) => sql`${id}`), sql`, `)}]::int[]`})
    `);

    expect(verify.rows.length).toBe(UNSIGNED_COUNT);
    for (const r of verify.rows as any[]) {
      expect(r.status).toBe("completed");
      expect(r.has_signature).toBe(false);
      expect(r.has_signed_sr).toBe(false);
    }
  });
});
