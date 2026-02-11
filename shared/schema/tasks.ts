import { pgTable, text, integer, serial, date, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";

// ============================================
// TASKS (AUFGABEN) TABLES
// ============================================

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export const TASK_STATUSES = ["open", "in-progress", "completed"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: date("due_date"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  assignedToUserId: integer("assigned_to_user_id").notNull().references(() => users.id),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("tasks_assigned_to_idx").on(table.assignedToUserId),
  index("tasks_status_idx").on(table.status),
  index("tasks_due_date_idx").on(table.dueDate),
]);

export const insertTaskSchema = z.object({
  title: z.string().min(1, "Titel ist erforderlich").max(200, "Titel darf maximal 200 Zeichen haben"),
  description: z.string().max(2000, "Beschreibung darf maximal 2000 Zeichen haben").optional().nullable(),
  dueDate: z.string().optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional().default("medium"),
  assignedToUserId: z.number().optional(),
  customerId: z.number().optional().nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  dueDate: z.string().optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignedToUserId: z.number().optional(),
  customerId: z.number().optional().nullable(),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
