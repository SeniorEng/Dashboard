import { pgTable, text, integer, serial, boolean, unique, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

// ============================================
// SYSTEM SETTINGS
// ============================================

export const systemSettings = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  autoBreaksEnabled: boolean("auto_breaks_enabled").notNull().default(true),
  lastDocumentReviewAt: timestamp("last_document_review_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

export const updateSystemSettingsSchema = z.object({
  autoBreaksEnabled: z.boolean().optional(),
});

export type UpdateSystemSettings = z.infer<typeof updateSystemSettingsSchema>;

// ============================================
// EMPLOYEE MONTH CLOSINGS (MONATSABSCHLUSS)
// ============================================

export const employeeMonthClosings = pgTable("employee_month_closings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  closedAt: timestamp("closed_at").notNull().defaultNow(),
  closedByUserId: integer("closed_by_user_id").notNull().references(() => users.id),
  reopenedAt: timestamp("reopened_at"),
  reopenedByUserId: integer("reopened_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("month_closing_unique").on(table.userId, table.year, table.month),
  index("month_closing_user_idx").on(table.userId),
]);

export type EmployeeMonthClosing = typeof employeeMonthClosings.$inferSelect;

// Task #1496: closeMonthSchema/adminCloseMonthSchema/reopenMonthSchema entfernt —
// es gibt keinen manuellen Monatsabschluss und kein Wieder-Öffnen mehr. Der
// Abschluss läuft ausschließlich automatisch über den Scheduler am Cutoff.

