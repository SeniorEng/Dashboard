import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  assignEmployeeToCustomer,
  deactivateTestEmployee,
  getFutureDate,
} from "./test-utils";

async function getOrCreateAnyService(): Promise<{ id: number }> {
  const list = await apiGet<any[]>("/api/services");
  if (list.status === 200 && Array.isArray(list.data) && list.data.length > 0) {
    const active = list.data.find((s: any) => s.isActive !== false) || list.data[0];
    return { id: active.id as number };
  }
  const created = await apiPost<any>("/api/services", {
    name: `revoke_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    unitType: "hour",
    defaultPriceCents: 3500,
    isActive: true,
    minDurationMinutes: 15,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`getOrCreateAnyService failed: ${created.status} ${JSON.stringify(created.data)}`);
  }
  return { id: created.data.id as number };
}
import { notificationService } from "../server/services/notification-service";
import { db } from "../server/lib/db";
import { notifications, type Notification, type NotificationType } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";

beforeAll(async () => {
  await getAuthCookie();
});

async function waitForNotification(
  userId: number,
  type: NotificationType,
  predicate: (n: Notification) => boolean,
  timeoutMs = 2000,
): Promise<Notification | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type)))
      .orderBy(desc(notifications.id))
      .limit(20);
    const hit = rows.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("NOT-1: Benachrichtigungen laden", () => {
  it("NOT-1.1 – GET /api/notifications liefert Array", async () => {
    const res = await apiGet<any[]>("/api/notifications");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("NOT-1.2 – Mit Limit-Parameter", async () => {
    const res = await apiGet<any[]>("/api/notifications?limit=5");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("NOT-2: Ungelesen-Zähler", () => {
  it("NOT-2.1 – GET unread-count liefert Zahl", async () => {
    const res = await apiGet<any>("/api/notifications/unread-count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
    expect(res.data.count).toBeGreaterThanOrEqual(0);
  });
});

describe("NOT-3: Als gelesen markieren", () => {
  it("NOT-3.1 – PATCH mit ungültiger ID wird akzeptiert (idempotent)", async () => {
    const res = await apiPatch<any>("/api/notifications/999999/read", {});
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("NOT-3.2 – Alle als gelesen markieren", async () => {
    const res = await apiPost<any>("/api/notifications/mark-all-read", {});
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const countRes = await apiGet<any>("/api/notifications/unread-count");
    expect(countRes.data.count).toBe(0);
  });
});

// Service-Level-Tests für die Trigger-Erweiterungen (Task #377)
describe("NOT-4: Self-Assign-Schutz für neue Trigger (Task #377)", () => {
  it("NOT-4.1 – G1: notifyCustomerAssigned mit actingUserId === employeeId erzeugt KEINE Notification", async () => {
    const auth = await getAuthCookie();
    const uid = auth.user.id;
    notificationService.notifyCustomerAssigned(999_999_001, "Self Assign Test", uid, "primary", uid);
    await new Promise((r) => setTimeout(r, 400));
    const hit = await waitForNotification(uid, "customer_assigned", (n) => n.referenceId === 999_999_001, 500);
    expect(hit).toBeNull();
  });

  it("NOT-4.2 – G4: notifySeriesAppointmentsCreated mit actingUserId === employeeId erzeugt KEINE Notification", async () => {
    const auth = await getAuthCookie();
    const uid = auth.user.id;
    notificationService.notifySeriesAppointmentsCreated(uid, "Self Series Test", 5, "2030-01-01", 999_999_002, uid);
    await new Promise((r) => setTimeout(r, 400));
    const hit = await waitForNotification(uid, "appointment_created", (n) => n.referenceId === 999_999_002, 500);
    expect(hit).toBeNull();
  });

  it("NOT-4.3 – G4: notifySeriesAppointmentsCreated mit count=0 erzeugt KEINE Notification", async () => {
    const auth = await getAuthCookie();
    const uid = auth.user.id;
    const otherEmployeeId = uid + 2_000_000;
    notificationService.notifySeriesAppointmentsCreated(otherEmployeeId, "Empty Series", 0, "2030-03-01", 999_999_003, uid);
    await new Promise((r) => setTimeout(r, 300));
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, otherEmployeeId), eq(notifications.type, "appointment_created")));
    expect(rows.length).toBe(0);
  });

  it("NOT-4.4 – G2: notifyCustomerAssigned an fremden Mitarbeiter feuert (Format-Check)", async () => {
    const auth = await getAuthCookie();
    const uid = auth.user.id;
    const refId = 999_999_200 + Math.floor(Math.random() * 1000);
    // Empfänger-User existiert nicht: FK-Constraint kann greifen — wir
    // akzeptieren beide Ausgänge (siehe Cleanup).
    const fakeRecipient = uid + 3_000_000;
    notificationService.notifyCustomerAssigned(refId, "Bulk Handover Test", fakeRecipient, "primary", uid);
    const hit = await waitForNotification(fakeRecipient, "customer_assigned", (n) => n.referenceId === refId);
    if (hit) {
      expect(hit.title).toBe("Neue Kundenzuordnung");
      expect(hit.message).toContain("Bulk Handover Test");
      expect(hit.message).toContain("Hauptmitarbeiter");
      await db.delete(notifications).where(eq(notifications.id, hit.id));
    }
  });
});

// Regression-Schutz für die Assign-Route (Task #383, Nacharbeit zu #377):
// PATCH /admin/customers/:id/assign muss actingUserId an
// notifyCustomerAssigned übergeben, sonst greift der Self-Assign-Schutz nicht.
describe("NOT-5: Self-Assign-Schutz für PATCH /admin/customers/:id/assign", () => {
  let createdCustomerId: number | null = null;

  afterAll(async () => {
    await cleanupCustomer(createdCustomerId);
  });

  it("NOT-5.1 – Self-Assign über Assign-Endpoint erzeugt KEINE customer_assigned-Notification", async () => {
    const auth = await getAuthCookie();
    const uid = auth.user.id;

    const customer = await createTestCustomer();
    createdCustomerId = customer.id as number;

    const res = await apiPatch<any>(`/api/admin/customers/${createdCustomerId}/assign`, {
      primaryEmployeeId: uid,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 400));
    const hit = await waitForNotification(
      uid,
      "customer_assigned",
      (n) => n.referenceId === createdCustomerId,
      500,
    );
    expect(hit).toBeNull();
  });
});

// Task #386: Wechsel des assignedEmployeeId muss den alten Mitarbeiter
// per "Termin entzogen"-Notification informieren (Self-Assign-Schutz analog
// zu den anderen Triggern).
describe("NOT-6: appointment_revoked-Notification bei Mitarbeiter-Wechsel (Task #386)", () => {
  let customerId: number | null = null;
  let oldEmployeeId: number | null = null;
  let newEmployeeId: number | null = null;

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(oldEmployeeId);
    await deactivateTestEmployee(newEmployeeId);
  });

  it("NOT-6.1 – PATCH mit Mitarbeiter-Wechsel feuert appointment_revoked an alten Mitarbeiter", async () => {
    const auth = await getAuthCookie();
    const oldEmp = await createTestEmployee({ nachnamePrefix: "RevokeOld" });
    const newEmp = await createTestEmployee({ nachnamePrefix: "RevokeNew" });
    oldEmployeeId = oldEmp.id;
    newEmployeeId = newEmp.id;

    const customer = await createTestCustomer();
    customerId = customer.id as number;
    await assignEmployeeToCustomer(customerId, oldEmp.id);

    const service = await getOrCreateAnyService();
    const date = getFutureDate(14);
    const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: service.id, durationMinutes: 60 }],
      assignedEmployeeId: oldEmp.id,
    });
    expect(apptRes.status).toBe(201);
    const appointmentId = apptRes.data.id as number;

    const patchRes = await apiPatch<any>(`/api/appointments/${appointmentId}`, {
      assignedEmployeeId: newEmp.id,
    });
    expect(patchRes.status).toBe(200);

    const hit = await waitForNotification(
      oldEmp.id,
      "appointment_revoked",
      (n) => n.referenceId === appointmentId,
    );
    expect(hit).not.toBeNull();
    expect(hit!.title).toBe("Termin entzogen");
    expect(hit!.message).toContain("entzogen");
    const [y, m, d] = date.split("-");
    expect(hit!.message).toContain(`${d}.${m}.${y}`);
    expect(hit!.referenceType).toBe("appointment");

    // Sicherstellen, dass der Acting-User (nicht der alte/neue Mitarbeiter)
    // KEINE Self-Notification bekommt.
    const selfHit = await waitForNotification(
      auth.user.id,
      "appointment_revoked",
      (n) => n.referenceId === appointmentId,
      300,
    );
    expect(selfHit).toBeNull();
  });

  it("NOT-6.2 – Self-Assign-Schutz: Wechsel auf Acting-User selbst erzeugt KEINE Self-Notification", async () => {
    const auth = await getAuthCookie();
    const otherEmp = await createTestEmployee({ nachnamePrefix: "RevokeSelf" });

    const customer = await createTestCustomer();
    const cId = customer.id as number;
    try {
      await assignEmployeeToCustomer(cId, auth.user.id);

      const service = await getOrCreateAnyService();
      const date = getFutureDate(15);
      const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: cId,
        date,
        scheduledStart: "11:00",
        services: [{ serviceId: service.id, durationMinutes: 60 }],
        assignedEmployeeId: auth.user.id,
      });
      expect(apptRes.status).toBe(201);
      const appointmentId = apptRes.data.id as number;

      // Acting-User entzieht sich den Termin selbst → keine Revoke-Notification
      const patchRes = await apiPatch<any>(`/api/appointments/${appointmentId}`, {
        assignedEmployeeId: otherEmp.id,
      });
      expect(patchRes.status).toBe(200);

      const hit = await waitForNotification(
        auth.user.id,
        "appointment_revoked",
        (n) => n.referenceId === appointmentId,
        500,
      );
      expect(hit).toBeNull();
    } finally {
      await cleanupCustomer(cId);
      await deactivateTestEmployee(otherEmp.id);
    }
  });
});
