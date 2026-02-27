import { pgTable, text, integer, serial, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";
import { sql } from "drizzle-orm";

export const NOTIFICATION_TYPES = [
  "customer_assigned",
  "appointment_created",
  "task_assigned",
  "birthday_reminder",
] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const NOTIFICATION_REFERENCE_TYPES = [
  "customer",
  "appointment",
  "task",
] as const;
export type NotificationReferenceType = typeof NOTIFICATION_REFERENCE_TYPES[number];

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  referenceId: integer("reference_id"),
  referenceType: text("reference_type"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("notifications_user_id_idx").on(table.userId),
  index("notifications_unread_idx").on(table.userId).where(sql`read_at IS NULL`),
  index("notifications_created_at_idx").on(table.createdAt),
]);

export const insertNotificationSchema = z.object({
  userId: z.number(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
  referenceId: z.number().optional(),
  referenceType: z.enum(NOTIFICATION_REFERENCE_TYPES).optional(),
});

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
