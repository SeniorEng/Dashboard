import { notifications, InsertNotification, Notification } from "@shared/schema";
import { eq, and, desc, isNull, sql as sqlBuilder } from "drizzle-orm";
import { db } from "../lib/db";

export async function createNotification(data: InsertNotification): Promise<Notification> {
  const result = await db.insert(notifications).values(data).returning();
  return result[0];
}

export async function getNotifications(userId: number, limit = 50): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function getUnreadNotifications(userId: number): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .orderBy(desc(notifications.createdAt));
}

export async function getUnreadCount(userId: number): Promise<number> {
  const result = await db
    .select({ count: sqlBuilder<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return result[0]?.count ?? 0;
}

export async function markAsRead(id: number, userId: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

export async function markAllAsRead(userId: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
