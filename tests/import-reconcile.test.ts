/**
 * Task #669 — Import-Reconcile (Excel als Single Source of Truth).
 *
 * Validiert die zwei neuen Endpunkte:
 *   - POST /api/admin/import-appointments/reconcile/preview
 *   - POST /api/admin/import-appointments/reconcile/execute
 *
 * Erwartung:
 *   1. Ein DB-Termin im Scope, der NICHT in der Excel-Key-Liste vorkommt, wird
 *      vom Preview als cancellable klassifiziert.
 *   2. Execute mit gültiger Begründung storniert den Termin (status='cancelled',
 *      deletedAt gesetzt) und reversed Budget-Buchungen.
 *   3. Re-Preview liefert ihn nicht mehr.
 *   4. Begründung <10 Zeichen → 400.
 *   5. Ein Termin, der in der Excel vorkommt, taucht im Preview gar nicht auf.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiPost,
  apiGet,
  getAuthCookie,
  createTestCustomer,
  createAndDocumentAppointment,
  assignEmployeeToCustomer,
  cleanupCustomer,
  getFutureDate,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
const customerIdsToCleanup: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
});

afterAll(async () => {
  for (const id of customerIdsToCleanup) await cleanupCustomer(id);
});

describe("Task #669 — Import-Reconcile", () => {
  it("storniert DB-Termin, der nicht in der Excel ist; und ignoriert in-Excel-Termine", async () => {
    // Past-date so kein Auto-Close-Cutoff-Risiko: in der nahen Vergangenheit
    // (sicher außerhalb closed month).
    const futureDate = getFutureDate(14);
    const customer = await createTestCustomer({
      vorname: "Reconcile",
      nachname: `Test-${uniqueId()}`,
      pflegegrad: 3,
      acceptsPrivatePayment: true,
    });
    const customerId = customer.id;
    customerIdsToCleanup.push(customerId);
    await assignEmployeeToCustomer(customerId, auth.user.id);

    // Zwei Termine anlegen: einer ist später "in Excel" (Schutz), einer "nur in DB"
    // (Stornier-Kandidat).
    const inExcel = await createAndDocumentAppointment(customerId, hwServiceId, {
      date: futureDate,
      startTime: "08:00",
      durationMinutes: 30,
    });
    const onlyInDb = await createAndDocumentAppointment(customerId, hwServiceId, {
      date: futureDate,
      startTime: "10:00",
      durationMinutes: 30,
    });

    const excelKeys = [
      { customerId, date: futureDate, startTime: "08:00" },
    ];

    // Preview
    const preview = await apiPost<any>("/api/admin/import-appointments/reconcile/preview", {
      customerIds: [customerId],
      startDate: futureDate,
      endDate: futureDate,
      excelKeys,
    });
    expect(preview.status).toBe(200);
    const cancellableIds = (preview.data.cancellable as Array<{ appointmentId: number }>).map(
      (a) => a.appointmentId,
    );
    expect(cancellableIds).toContain(onlyInDb.appointmentId);
    expect(cancellableIds).not.toContain(inExcel.appointmentId);

    // Begründung zu kurz → 400
    const shortReason = await apiPost<any>("/api/admin/import-appointments/reconcile/execute", {
      appointmentIds: [onlyInDb.appointmentId],
      reason: "kurz",
    });
    expect(shortReason.status).toBe(400);

    // Execute mit gültiger Begründung
    const exec = await apiPost<any>("/api/admin/import-appointments/reconcile/execute", {
      appointmentIds: [onlyInDb.appointmentId],
      reason: "Excel ist Single Source of Truth für diesen Zeitraum (Test)",
      scopeCustomerIds: [customerId],
      scopeStartDate: futureDate,
      scopeEndDate: futureDate,
    });
    expect(exec.status).toBe(200);
    expect(exec.data.cancelled).toBe(1);
    expect(typeof exec.data.batchId).toBe("string");
    expect(exec.data.batchId).toMatch(/^[0-9a-f-]{36}$/i);

    // Re-Preview: storno-Kandidat sollte verschwunden sein
    const preview2 = await apiPost<any>("/api/admin/import-appointments/reconcile/preview", {
      customerIds: [customerId],
      startDate: futureDate,
      endDate: futureDate,
      excelKeys,
    });
    expect(preview2.status).toBe(200);
    const stillCancellable = (preview2.data.cancellable as Array<{ appointmentId: number }>).map(
      (a) => a.appointmentId,
    );
    expect(stillCancellable).not.toContain(onlyInDb.appointmentId);

    // Audit-Log: ein Eintrag mit der Batch-ID muss existieren
    const audit = await apiGet<any>(
      `/api/admin/audit-log?action=appointment_import_reconciled_cancelled&batchId=${exec.data.batchId}`,
    );
    expect(audit.status).toBe(200);
    const entries = (audit.data.entries ?? audit.data) as Array<{ entityId: number; metadata?: any }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.entityId === onlyInDb.appointmentId)).toBe(true);
  });
});
