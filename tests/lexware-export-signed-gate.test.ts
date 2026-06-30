/**
 * Task #1121 / #1496 — Regressionsschutz für den Lohn-/Lexware-Export
 * (`GET /api/admin/hours-overview`, `server/routes/admin/lexware-export.ts`).
 *
 * Der Export aggregiert Dienst-Minuten, Anfahrts-Minuten und Kilometer über
 * Roh-SQL-Queries, die seit Task #1496 alle auf das geteilte Prädikat
 * „dokumentiert" (`documentedSqlRaw` = `status='completed'`,
 * `server/lib/appointment-signed.ts`) gaten — ENTKOPPELT von der Unterschrift.
 * Für Lohn/Export/Statistik gilt: „dokumentiert" == abgeschlossen; die
 * Unterschrift steuert NUR die Kunden-/Pflegekassen-Abrechnung.
 *
 * Dieser Test stellt sicher, dass dokumentierte (abgeschlossene) Termine in die
 * exportierten Stunden-/KM-Summen einfließen — auch ohne Unterschrift — während
 * ein noch nicht abgeschlossener Termin (`documenting`) NICHT zählt. Fehlende
 * Unterschriften werden zwar gezählt, aber zusätzlich als Warnung nachgehalten.
 *
 * Der Gating-Zustand der Termine wird — wie in `auto-close-no-overwrite.test.ts` —
 * direkt per `db.execute` gesetzt, um exakt drei reproduzierbare Fälle zu erzeugen:
 *   A) status='completed' + signature_data ⇒ zählt (direkte Unterschrift)
 *   B) status='completed' + signature_data NULL, kein LN  ⇒ zählt (dokumentiert),
 *                                                            aber als Warnung
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
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
}

interface OverviewResponse {
  rows: OverviewRow[];
  year: number;
  month: number;
}

describe("Task #1496: Lexware-Export zählt dokumentierte Termine (unabhängig von der Unterschrift)", () => {
  let customerId: number;
  let employeeId: number;
  // Zweiter Mitarbeiter mit AUSSCHLIESSLICH unsignierter (aber dokumentierter)
  // Monatsaktivität: Seine Stunden zählen (documented-only), zusätzlich erhält er
  // eine Warnung wegen fehlender Unterschrift.
  let unsignedOnlyEmployeeId: number;
  let serviceId: number;

  async function seedAppointment(opts: {
    status: string;
    signed: boolean;
    forEmployeeId?: number;
  }): Promise<number> {
    const empId = opts.forEmployeeId ?? employeeId;
    const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
      assignedEmployeeId: empId,
      durationMinutes: HW_MINUTES,
    });

    await db.execute(sql`
      UPDATE appointments
      SET date = ${TARGET_DATE},
          status = ${opts.status},
          signature_data = ${opts.signed ? validSignatureDataUrl() : null},
          performed_by_employee_id = ${empId},
          assigned_employee_id = ${empId},
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

    const unsignedOnlyEmployee = await createTestEmployee({ nachnamePrefix: "TestLexUnsigned" });
    unsignedOnlyEmployeeId = unsignedOnlyEmployee.id;
    await assignEmployeeToCustomer(customerId, unsignedOnlyEmployeeId);

    // A) dokumentiert + unterschrieben ⇒ zählt
    await seedAppointment({ status: "completed", signed: true });
    // B) completed, aber ohne Unterschrift ⇒ zählt (dokumentiert), plus Warnung
    await seedAppointment({ status: "completed", signed: false });
    // C) noch nicht abgeschlossen ⇒ zählt NICHT
    await seedAppointment({ status: "documenting", signed: false });

    // Zweiter Mitarbeiter: NUR ein completed-aber-unsignierter Termin, sonst nichts.
    await seedAppointment({ status: "completed", signed: false, forEmployeeId: unsignedOnlyEmployeeId });
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await deactivateTestEmployee(unsignedOnlyEmployeeId);
  });

  it("aggregiert alle dokumentierten Termine in Stunden und Kilometern, auch ohne Unterschrift", async () => {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);

    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, "Zeile für Test-Mitarbeiter muss existieren").toBeDefined();

    // ZWEI dokumentierte Termine (A signiert + B unsigniert) zählen — nur C
    // (`documenting`, nicht abgeschlossen) zählt nicht. Würde das Gating auf
    // „unterschrieben" zurückfallen, wäre nur A gezählt (halbe Werte).
    expect(row!.stundenHauswirtschaft).toBe((HW_MINUTES * 2) / 60); // 4.0
    expect(row!.stundenAnfahrt).toBe((TRAVEL_MINUTES * 2) / 60); // 1.0
    expect(row!.kilometerAnfahrt).toBeCloseTo(TRAVEL_KM * 2, 3); // 20
    expect(row!.kilometerKunden).toBeCloseTo(CUSTOMER_KM * 2, 3); // 16
    expect(row!.kilometer).toBeCloseTo((TRAVEL_KM + CUSTOMER_KM) * 2, 3); // 36
  });

  it("meldet completed-aber-unsignierte Termine zusätzlich als Warnung (zählen aber zur Lohnzeit)", async () => {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);

    const row = res.data.rows.find((r) => r.employeeId === employeeId);
    expect(row, "Zeile für Test-Mitarbeiter muss existieren").toBeDefined();

    // Nur Termin B (completed, ohne Unterschrift) zählt als „ohne Unterschrift".
    // Termin C ist `documenting` (nicht completed) und zählt auch hier NICHT.
    expect(row!.unsignedAppointmentCount).toBe(1);
    expect(row!.unsignedMinutes).toBe(HW_MINUTES);
    // Die gezählten Stunden umfassen weiterhin BEIDE dokumentierten Termine (A+B) —
    // die fehlende Unterschrift mindert die Lohnzeit nicht (Task #1496).
    expect(row!.stundenHauswirtschaft).toBe((HW_MINUTES * 2) / 60);
  });

  it("zählt die Stunden eines Mitarbeiters mit ausschließlich unsignierter (dokumentierter) Aktivität und warnt zugleich", async () => {
    const res = await apiGet<OverviewResponse>(
      `/api/admin/hours-overview?year=${TARGET_YEAR}&month=${TARGET_MONTH}`,
    );
    expect(res.status).toBe(200);

    const row = res.data.rows.find((r) => r.employeeId === unsignedOnlyEmployeeId);
    expect(
      row,
      "Mitarbeiter mit dokumentierter (wenn auch unsignierter) Aktivität muss eine Zeile bekommen",
    ).toBeDefined();

    expect(row!.unsignedAppointmentCount).toBe(1);
    expect(row!.unsignedMinutes).toBe(HW_MINUTES);
    // Documented-only: der eine abgeschlossene Termin zählt zur Lohnzeit, obwohl
    // die Unterschrift fehlt.
    expect(row!.stundenHauswirtschaft).toBe(HW_MINUTES / 60); // 2.0
    expect(row!.stundenAnfahrt).toBe(TRAVEL_MINUTES / 60); // 0.5
    expect(row!.kilometer).toBeCloseTo(TRAVEL_KM + CUSTOMER_KM, 3); // 18
  });
});
