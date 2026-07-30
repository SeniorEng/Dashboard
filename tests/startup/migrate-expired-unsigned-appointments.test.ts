/**
 * Task #1119 — Regressionsschutz für die Migration `expired_unsigned` →
 * echter Lebenszyklus-Status.
 *
 * Der automatische Monatsabschluss hat Termine früher mit `expired_unsigned`
 * überschrieben. Dieser Status ist jetzt rein abgeleitet (Anzeige-Label „Nicht
 * abgerechnet") und wird nie mehr persistiert. `migrateExpiredUnsignedAppointments`
 * führt Bestandszeilen idempotent auf ihren wahren Status zurück:
 *   - Unterschrift vorhanden / aktuell ⇒ completed
 *   - Ende erfasst                      ⇒ completed
 *   - nur Beginn erfasst                ⇒ documenting
 *   - sonst                             ⇒ scheduled
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { migrateExpiredUnsignedAppointments } from "../../server/startup/migrate-expired-unsigned-appointments";
import {
  createTestCustomer,
  cleanupCustomer,
  createAndDocumentAppointment,
  createTestEmployee,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
  getFutureDate,
} from "../test-utils";

async function getSeededServiceId(): Promise<number> {
  const res = await db.execute(sql`SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1`);
  const row = res.rows?.[0] as { id: number } | undefined;
  if (!row) throw new Error("Basis-Leistung 'hauswirtschaft' fehlt in der Test-DB");
  return Number(row.id);
}

async function forceExpiredUnsigned(
  appointmentId: number,
  fields: { actualStart?: string | null; actualEnd?: string | null; signatureData?: string | null },
): Promise<void> {
  await db.execute(sql`
    UPDATE appointments
    SET status = 'expired_unsigned',
        actual_start = ${fields.actualStart ?? null},
        actual_end = ${fields.actualEnd ?? null},
        signature_data = ${fields.signatureData ?? null}
    WHERE id = ${appointmentId}
  `);
}

async function getStatus(appointmentId: number): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM appointments WHERE id = ${appointmentId}`);
  return (res.rows?.[0] as { status: string }).status;
}

describe("Task #1119: migrateExpiredUnsignedAppointments", () => {
  let customerId: number;
  let employeeId: number;
  let serviceId: number;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    const customer = await createTestCustomer();
    customerId = customer.id as number;
    serviceId = await getSeededServiceId();

    // Eigener Mitarbeiter statt des geteilten Admin-Users: dessen Kalender
    // belegen andere parallel laufende Suiten über die Defaults von
    // `createAndDocumentAppointment` (getFutureDate(7), 09:00) ebenfalls.
    const employee = await createTestEmployee({ nachnamePrefix: "TestMigExp" });
    employeeId = employee.id;
    await assignEmployeeToCustomer(customerId, employeeId);

    // Je Termin eine EIGENE Uhrzeit. Die Tage allein reichen nicht: `getFutureDate`
    // rollt Sa auf Mo (+2) und So auf Mo (+1), deshalb fallen z.B. an einem
    // Donnerstags-Lauf getFutureDate(9) und (10) beide auf denselben Montag —
    // zwei 09:00-Termine desselben Kunden ⇒ 409 „Terminüberschneidung".
    const slots = [
      { key: "signed", startTime: "09:00" },
      { key: "ended", startTime: "11:00" },
      { key: "startedOnly", startTime: "13:00" },
      { key: "untouched", startTime: "15:00" },
    ];
    for (let i = 0; i < slots.length; i++) {
      const { appointmentId } = await createAndDocumentAppointment(customerId, serviceId, {
        date: getFutureDate(7 + i),
        startTime: slots[i].startTime,
        assignedEmployeeId: employeeId,
      });
      ids[slots[i].key] = appointmentId;
    }

    await forceExpiredUnsigned(ids.signed, { actualStart: "09:00", actualEnd: "10:00", signatureData: "data:image/png;base64,AAAA" });
    await forceExpiredUnsigned(ids.ended, { actualStart: "09:00", actualEnd: "10:00", signatureData: null });
    await forceExpiredUnsigned(ids.startedOnly, { actualStart: "09:00", actualEnd: null, signatureData: null });
    await forceExpiredUnsigned(ids.untouched, { actualStart: null, actualEnd: null, signatureData: null });
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
  });

  it("restauriert jeden expired_unsigned-Termin auf seinen wahren Lebenszyklus-Status", async () => {
    await migrateExpiredUnsignedAppointments();

    expect(await getStatus(ids.signed)).toBe("completed");
    expect(await getStatus(ids.ended)).toBe("completed");
    expect(await getStatus(ids.startedOnly)).toBe("documenting");
    expect(await getStatus(ids.untouched)).toBe("scheduled");
  });

  it("ist idempotent — ein zweiter Lauf ändert nichts mehr", async () => {
    await migrateExpiredUnsignedAppointments();
    await migrateExpiredUnsignedAppointments();

    // Kein expired_unsigned mehr übrig (für die migrierten Termine).
    for (const id of Object.values(ids)) {
      expect(await getStatus(id)).not.toBe("expired_unsigned");
    }
  });

  it("schreibt einen Audit-Eintrag pro restauriertem Termin", async () => {
    const res = await db.execute(sql`
      SELECT entity_id FROM audit_log
      WHERE entity_type = 'appointment'
        AND action = 'appointment_status_restored_from_expired'
        AND entity_id = ANY(${sql`ARRAY[${sql.join(Object.values(ids).map((id) => sql`${id}`), sql`, `)}]::int[]`})
    `);
    const auditedIds = new Set((res.rows as Array<{ entity_id: number }>).map((r) => Number(r.entity_id)));
    for (const id of Object.values(ids)) {
      expect(auditedIds.has(id)).toBe(true);
    }
  });
});
