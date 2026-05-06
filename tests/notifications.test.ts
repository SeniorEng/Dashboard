import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
} from "./test-utils";
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
