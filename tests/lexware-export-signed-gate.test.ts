/**
 * Task #1121 — Regressionsschutz für den Lohn-/Lexware-Export
 * (`GET /api/admin/hours-overview`, `server/routes/admin/lexware-export.ts`).
 *
 * Der Export aggregiert Dienst-Minuten, Anfahrts-Minuten und Kilometer über drei
 * Roh-SQL-Queries, die seit Task #1119 alle auf das geteilte Prädikat
 * „dokumentiert & unterschrieben" (`documentedAndSignedSqlRaw`,
 * `server/lib/appointment-signed.ts`) gaten. Dieser Test stellt sicher, dass
 * NUR dokumentiert+unterschriebene Termine in die exportierten Stunden-/KM-Summen
 * einfließen. Ein nicht unterschriebener oder noch nicht abgeschlossener Termin
 * darf die Lohnzahlen NICHT erhöhen.
 *
 * Der Gating-Zustand der Termine wird — wie in `auto-close-no-overwrite.test.ts` —
 * direkt per `db.execute` gesetzt, um exakt drei reproduzierbare Fälle zu erzeugen:
 *   A) status='completed' + signature_data ⇒ zählt (direkte Unterschrift)
 *   B) status='completed' + signature_data NULL, kein LN  ⇒ zählt NICHT
 *   C) status='documenting' (nicht abgeschlossen)         ⇒ zählt NICHT
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
// performed_by_employee_id, daher gibt es keine Kollision mit Fremddaten.
const TARGET_YEAR = 2023;
const TARGET_MONTH = 4;
const TARGET_DATE = `${TARGET_YEAR}-0${TARGET_MONTH}-12`;

// Pro Termin identische Roh-Werte, damit doppeltes Zählen sofort auffällt.
const HW_MINUTES = 120;
const TRAVEL_MINUTES = 30;
const TRAVEL_KM = 10;
const CUSTOMER_KM = 8;

interface OverviewRow {
  employeeId: number;
  stundenHauswirtschaft: number;
  stundenAnfahrt: number;
  kilometer: number;
  kilometerAnfahrt: number;
  kilometerKunden: number;
}

interface OverviewResponse {
  rows: OverviewRow[];
  year: number;
  month: number;
}

describe("Task #1121: Lexware-Export zählt nur dokumentiert+unterschriebene Termine", () => {
  let customerId: number;
  let employeeId: number;
  let serviceId: number;

  async function seedAppointment(opts: {
    status: string;
    signed: boolean;
  }): Promise<number> {
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
          assigned_employee_id = ${employeeId},
          travel_minutes = ${TRAVEL_MINUTES},
          travel_kilometers = ${TRAVEL_KM},
          customer_kilometers = ${CUSTOMER_KM}
      WHERE id = ${appointmentId}
    `);

    // Die Dienst-Minuten kommen aus appointment_services (actual_duration_minutes).
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
    const employee = await createTestEmployee({ nachnamePrefix: "TestLex" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // A) dokumentiert + unterschrieben ⇒ zählt
    await seedAppointment({ status: "completed", signed: true });
    // B) completed, aber ohne Unterschrift ⇒ zählt NICHT
    await seedAppointment({ status: "completed", signed: false });
    // C) noch nicht abgeschlossen ⇒ zählt NICHT
    await seedAppointment({ status: "documenting", signed: false });
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("aggregiert nur den unterschriebenen Termin in Stunden und Kilometern", async () => {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);

    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, "Zeile für Test-Mitarbeiter muss existieren").toBeDefined();

    // Genau EIN Termin (A) zählt — nicht drei. Würde das Gating brechen, wären
    // alle Werte das Dreifache.
    expect(row!.stundenHauswirtschaft).toBe(HW_MINUTES / 60); // 2.0
    expect(row!.stundenAnfahrt).toBe(TRAVEL_MINUTES / 60); // 0.5
    expect(row!.kilometerAnfahrt).toBeCloseTo(TRAVEL_KM, 3); // 10
    expect(row!.kilometerKunden).toBeCloseTo(CUSTOMER_KM, 3); // 8
    expect(row!.kilometer).toBeCloseTo(TRAVEL_KM + CUSTOMER_KM, 3); // 18
  });
});
