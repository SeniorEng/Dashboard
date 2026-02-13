import { pgTable, text, integer, serial, boolean, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";
import { customers } from "./customers";

export const documentTypes = pgTable("document_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetType: text("target_type").notNull().default("employee"),
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

export const customerDocuments = pgTable("customer_documents", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  documentTypeId: integer("document_type_id").notNull().references(() => documentTypes.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
  reviewDueDate: date("review_due_date"),
  isCurrent: boolean("is_current").notNull().default(true),
  notes: text("notes"),
}, (table) => [
  index("customer_documents_customer_idx").on(table.customerId),
  index("customer_documents_type_idx").on(table.documentTypeId),
  index("customer_documents_current_idx").on(table.customerId, table.isCurrent),
  index("customer_documents_review_due_idx").on(table.reviewDueDate, table.isCurrent),
]);

export const documentTemplates = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  htmlContent: text("html_content").notNull(),
  version: integer("version").notNull().default(1),
  isSystem: boolean("is_system").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const documentTemplateBillingTypes = pgTable("document_template_billing_types", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => documentTemplates.id, { onDelete: "cascade" }),
  billingType: text("billing_type").notNull(),
  requirement: text("requirement").notNull().default("pflicht"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  index("dtbt_template_idx").on(table.templateId),
  index("dtbt_billing_type_idx").on(table.billingType),
  uniqueIndex("dtbt_template_billing_unique").on(table.templateId, table.billingType),
]);

export const generatedDocuments = pgTable("generated_documents", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => documentTemplates.id),
  templateVersion: integer("template_version").notNull(),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  customerSignatureData: text("customer_signature_data"),
  employeeSignatureData: text("employee_signature_data"),
  signedAt: timestamp("signed_at"),
  signedByEmployeeId: integer("signed_by_employee_id").references(() => users.id),
  integrityHash: text("integrity_hash"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  generatedByUserId: integer("generated_by_user_id").references(() => users.id),
}, (table) => [
  index("generated_docs_customer_idx").on(table.customerId),
  index("generated_docs_template_idx").on(table.templateId),
]);

export const insertDocumentTemplateSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  htmlContent: z.string().min(1).max(500000),
  isSystem: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const updateDocumentTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  htmlContent: z.string().min(1).max(500000).optional(),
  isActive: z.boolean().optional(),
});

export const insertGeneratedDocumentSchema = z.object({
  customerId: z.number().int(),
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  fileName: z.string().min(1),
  objectPath: z.string().min(1),
  customerSignatureData: z.string().nullable().optional(),
  employeeSignatureData: z.string().nullable().optional(),
  integrityHash: z.string().nullable().optional(),
});

export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
export type UpdateDocumentTemplate = z.infer<typeof updateDocumentTemplateSchema>;
export type DocumentTemplateBillingType = typeof documentTemplateBillingTypes.$inferSelect;
export type GeneratedDocument = typeof generatedDocuments.$inferSelect;
export type InsertGeneratedDocument = z.infer<typeof insertGeneratedDocumentSchema>;

export const insertDocumentTypeSchema = z.object({
  name: z.string().min(1, "Name ist erforderlich").max(100),
  description: z.string().max(500).nullable().optional(),
  targetType: z.enum(["employee", "customer"]).default("employee"),
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

export const insertCustomerDocumentSchema = z.object({
  customerId: z.number().int(),
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
export type CustomerDocument = typeof customerDocuments.$inferSelect;
export type InsertCustomerDocument = z.infer<typeof insertCustomerDocumentSchema>;
