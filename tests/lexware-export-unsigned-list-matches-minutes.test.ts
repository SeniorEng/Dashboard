/**
 * Task #1128 — Warnung und Termin-Liste müssen identische Minuten-Summen zeigen.
 *
 * Aufbauend auf Task #1127 (Anzahl-Parität) sichert dieser Test die zweite
 * gelieferte Größe ab: Dienst-Minuten. Die Stundenübersicht
 * (`GET /api/admin/hours-overview`) aggregiert pro Mitarbeiter `unsignedMinutes`
 * über eine LATERAL-Subquery auf `appointment_services`. Die aufgeklappte Liste
 * (`GET /api/admin/hours-overview/unsigned-appointments`) liefert `minutes` pro
 * Termin über eine separate, aber strukturell identische LATERAL-Subquery.
 *
 * Driftet eine der beiden Subqueries (z.B. anderer service-code-Filter oder
 * anderer COALESCE actual/planned), stimmt zwar weiterhin die ANZAHL, aber die
 * Minuten-Summe nicht mehr. Dieser Test garantiert:
 *   - Σ(`minutes` aller gelisteten Termine) === `unsignedMinutes` aus der
 *     Stundenübersicht für denselben Mitarbeiter/Monat,
 *   - die Summe ist > 0 und ergibt sich aus unterschiedlichen Termin-Dauern
 *     (damit ein versehentlich konstanter/falscher Aggregat-Pfad auffällt).
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
const TARGET_MONTH = 10;
const TARGET_DATE = `${TARGET_YEAR}-${TARGET_MONTH}-15`;

// Bewusst UNTERSCHIEDLICHE Minuten je Termin, damit ein fehlerhafter Aggregat-
// pfad (z.B. konstanter Wert oder doppelte Zählung) sofort auffällt.
const UNSIGNED_MINUTES = [45, 90, 120];
const EXPECTED_TOTAL_MINUTES = UNSIGNED_MINUTES.reduce((a, b) => a + b, 0);

interface OverviewRow {
  employeeId: number;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
}
interface OverviewResponse {
  rows: OverviewRow[];
}

interface UnsignedAppointment {
  id: number;
  minutes: number;
}
interface UnsignedListResponse {
  appointments: UnsignedAppointment[];
}

describe("Task #1128: unsigned-appointments-Minuten stimmen mit unsignedMinutes überein", () => {
  let customerId: number;
  let employeeId: number;
  let serviceId: number;

  async function seedAppointment(opts: {
    status: string;
    signed: boolean;
    minutes: number;
  }): Promise<number> {
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: employeeId,
      durationMinutes: opts.minutes,
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
      SET actual_duration_minutes = ${opts.minutes}
      WHERE appointment_id = ${appointmentId}
    `);

    return appointmentId;
  }

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    serviceId = await getSeededHauswirtschaftServiceId();
    const employee = await createTestEmployee({ nachnamePrefix: "TestLexMin" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // N completed-aber-unsignierte Termine mit unterschiedlichen Minuten.
    for (const minutes of UNSIGNED_MINUTES) {
      await seedAppointment({ status: "completed", signed: false, minutes });
    }
    // Rauschen, das weder zählt noch zur Minuten-Summe beiträgt:
    await seedAppointment({ status: "completed", signed: true, minutes: 60 }); // unterschrieben
    await seedAppointment({ status: "documenting", signed: false, minutes: 60 }); // nicht abgeschlossen
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("liefert dieselbe Minuten-Summe in Warnung (unsignedMinutes) und Liste (Σ minutes)", async () => {
    const overview = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(overview.status).toBe(200);

    const row = overview.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, "Zeile für Test-Mitarbeiter muss existieren").toBeDefined();
    expect(row!.unsignedAppointmentCount).toBe(UNSIGNED_MINUTES.length);
    // Sanity: die Warnung meldet die erwartete Gesamt-Minutensumme.
    expect(row!.unsignedMinutes).toBe(EXPECTED_TOTAL_MINUTES);

    const list = await apiGet<UnsignedListResponse>(
      `/api/admin/hours-overview/unsigned-appointments?year=${TARGET_YEAR}&month=${TARGET_MONTH}&employeeId=${employeeId}`,
    );
    expect(list.status).toBe(200);
    expect(list.data.appointments.length).toBe(UNSIGNED_MINUTES.length);

    const listMinutesSum = list.data.appointments.reduce((sum, a) => sum + a.minutes, 0);

    // Kern-Assertion: Σ(Liste.minutes) === Warnung.unsignedMinutes.
    expect(listMinutesSum).toBe(row!.unsignedMinutes);
    expect(listMinutesSum).toBe(EXPECTED_TOTAL_MINUTES);
  });
});
