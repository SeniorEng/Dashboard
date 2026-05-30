/**
 * Task #824 — GoBD: technische Unveränderbarkeit von `audit_log`.
 *
 * Verifiziert die BEFORE-Trigger aus
 * `server/startup/ensure-audit-log-immutable.ts`:
 *  1. Append-Insert funktioniert weiterhin.
 *  2. Direktes UPDATE auf audit_log schlägt fehl (Exception).
 *  3. Direktes DELETE auf audit_log schlägt fehl (Exception).
 *  4. Mit dem transaktions-lokalen Bypass-GUC ist Cleanup-DELETE möglich
 *     (nur Test-/Nicht-Prod-Pfade).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../server/lib/db";
import { auditLog } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

let userId: number;
let seededId: number | null = null;

beforeAll(async () => {
  const rows = await db.execute<{ id: number }>(sql`SELECT id FROM users ORDER BY id LIMIT 1`);
  const list = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? (rows as unknown as Array<{ id: number }>);
  userId = list[0]?.id;
  expect(userId, "Es muss mindestens ein User für den FK existieren").toBeTruthy();
});

afterAll(async () => {
  if (seededId != null) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(eq(auditLog.id, seededId as number));
    });
  }
});

describe("audit_log ist GoBD-technisch unveränderbar", () => {
  it("Append-Insert funktioniert weiterhin", async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        userId,
        action: "login_success",
        entityType: "user",
        entityId: userId,
        metadata: { test: "task-824-immutability" },
      })
      .returning({ id: auditLog.id });
    expect(row?.id).toBeTruthy();
    seededId = row.id;
  });

  it("UPDATE schlägt fehl", async () => {
    await expect(
      db.update(auditLog).set({ action: "login_failed" }).where(eq(auditLog.id, seededId as number)),
    ).rejects.toThrow();

    // Wert ist unverändert geblieben.
    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.id, seededId as number));
    expect(rows[0]?.action).toBe("login_success");
  });

  it("DELETE schlägt fehl", async () => {
    await expect(
      db.delete(auditLog).where(eq(auditLog.id, seededId as number)),
    ).rejects.toThrow();

    // Zeile existiert weiterhin.
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.id, seededId as number));
    expect(rows.length).toBe(1);
  });

  it("DELETE mit transaktions-lokalem Bypass-GUC ist möglich", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(eq(auditLog.id, seededId as number));
    });

    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.id, seededId as number));
    expect(rows.length).toBe(0);
    seededId = null;
  });
});
