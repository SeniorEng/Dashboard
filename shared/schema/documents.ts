import { pgTable, text, integer, serial, boolean, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

export const documentTypes = pgTable("document_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  reviewIntervalMonths: integer("review_interval_months"),
  reminderLeadTimeDays: integer("reminder_lead_time_days").default(14),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const employeeDocuments = pgTable("employee_documents", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentTypeId: integer("document_type_id").notNull().references(() => documentTypes.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
  reviewDueDate: date("review_due_date"),
  isCurrent: boolean("is_current").notNull().default(true),
  notes: text("notes"),
}, (table) => [
  index("employee_documents_employee_idx").on(table.employeeId),
  index("employee_documents_type_idx").on(table.documentTypeId),
  index("employee_documents_current_idx").on(table.employeeId, table.isCurrent),
  index("employee_documents_review_due_idx").on(table.reviewDueDate, table.isCurrent),
]);

export const insertDocumentTypeSchema = z.object({
  name: z.string().min(1, "Name ist erforderlich").max(100),
  description: z.string().max(500).nullable().optional(),
  reviewIntervalMonths: z.number().int().min(1).nullable().optional(),
  reminderLeadTimeDays: z.number().int().min(1).max(365).default(14),
  isActive: z.boolean().default(true),
});

export const updateDocumentTypeSchema = insertDocumentTypeSchema.partial();

export const insertEmployeeDocumentSchema = z.object({
  employeeId: z.number().int(),
  documentTypeId: z.number().int(),
  fileName: z.string().min(1),
  objectPath: z.string().min(1),
  notes: z.string().max(500).nullable().optional(),
});

export type DocumentType = typeof documentTypes.$inferSelect;
export type InsertDocumentType = z.infer<typeof insertDocumentTypeSchema>;
export type UpdateDocumentType = z.infer<typeof updateDocumentTypeSchema>;
export type EmployeeDocument = typeof employeeDocuments.$inferSelect;
export type InsertEmployeeDocument = z.infer<typeof insertEmployeeDocumentSchema>;
