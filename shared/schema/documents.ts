import { pgTable, text, integer, serial, boolean, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";
import { customers } from "./customers";

export const DOCUMENT_TYPE_CONTEXTS = ["vertragsabschluss", "bestandskunde", "beide"] as const;
export type DocumentTypeContext = typeof DOCUMENT_TYPE_CONTEXTS[number];

export const DOCUMENT_TYPE_CONTEXT_LABELS: Record<DocumentTypeContext, string> = {
  vertragsabschluss: "Nur bei Vertragsabschluss",
  bestandskunde: "Nur bei Bestandskunden",
  beide: "Immer verfügbar",
};

export const documentTypes = pgTable("document_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetType: text("target_type").notNull().default("employee"),
  context: text("context").notNull().default("beide"),
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
  documentTypeId: integer("document_type_id").references(() => documentTypes.id, { onDelete: "set null" }),
  context: text("context").notNull().default("beide"),
  targetType: text("target_type").notNull().default("customer"),
  requiresCustomerSignature: boolean("requires_customer_signature").notNull().default(true),
  requiresEmployeeSignature: boolean("requires_employee_signature").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("document_templates_type_idx").on(table.documentTypeId),
  index("document_templates_context_idx").on(table.context),
  index("document_templates_target_idx").on(table.targetType),
]);

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

export const SIGNING_STATUSES = ["complete", "pending_employee_signature"] as const;
export type SigningStatus = typeof SIGNING_STATUSES[number];

export const SIGNING_STATUS_LABELS: Record<SigningStatus, string> = {
  complete: "Vollständig unterschrieben",
  pending_employee_signature: "Unterschrift ausstehend",
};

export const generatedDocuments = pgTable("generated_documents", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").references(() => users.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => documentTemplates.id),
  templateVersion: integer("template_version").notNull(),
  documentTypeId: integer("document_type_id").references(() => documentTypes.id, { onDelete: "set null" }),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  renderedHtml: text("rendered_html"),
  customerSignatureData: text("customer_signature_data"),
  employeeSignatureData: text("employee_signature_data"),
  signingStatus: text("signing_status").notNull().default("complete"),
  signedAt: timestamp("signed_at"),
  signedByEmployeeId: integer("signed_by_employee_id").references(() => users.id),
  integrityHash: text("integrity_hash"),
  signingIp: text("signing_ip"),
  signingLocation: text("signing_location"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  generatedByUserId: integer("generated_by_user_id").references(() => users.id),
}, (table) => [
  index("generated_docs_customer_idx").on(table.customerId),
  index("generated_docs_employee_idx").on(table.employeeId),
  index("generated_docs_template_idx").on(table.templateId),
  index("generated_docs_doctype_idx").on(table.documentTypeId),
  index("generated_docs_signing_status_idx").on(table.signingStatus),
]);

export const documentSigningTokens = pgTable("document_signing_tokens", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => generatedDocuments.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("signing_tokens_document_idx").on(table.documentId),
  index("signing_tokens_hash_idx").on(table.tokenHash),
]);

export const TEMPLATE_CONTEXTS = ["vertragsabschluss", "bestandskunde", "beide"] as const;
export type TemplateContext = typeof TEMPLATE_CONTEXTS[number];

export const TEMPLATE_CONTEXT_LABELS: Record<TemplateContext, string> = {
  vertragsabschluss: "Nur bei Vertragsabschluss",
  bestandskunde: "Nur bei Bestandskunden",
  beide: "Immer verfügbar",
};

export const TEMPLATE_TARGET_TYPES = ["customer", "employee", "beide"] as const;
export type TemplateTargetType = typeof TEMPLATE_TARGET_TYPES[number];

export const TEMPLATE_TARGET_TYPE_LABELS: Record<TemplateTargetType, string> = {
  customer: "Kunden",
  employee: "Mitarbeiter",
  beide: "Beide",
};

export const insertDocumentTemplateSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  htmlContent: z.string().min(1).max(500000),
  isSystem: z.boolean().default(false),
  isActive: z.boolean().default(true),
  documentTypeId: z.number().int().nullable().optional(),
  context: z.enum(TEMPLATE_CONTEXTS).default("beide"),
  targetType: z.enum(TEMPLATE_TARGET_TYPES).default("customer"),
  requiresCustomerSignature: z.boolean().default(true),
  requiresEmployeeSignature: z.boolean().default(true),
});

export const updateDocumentTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  htmlContent: z.string().min(1).max(500000).optional(),
  isActive: z.boolean().optional(),
  documentTypeId: z.number().int().nullable().optional(),
  context: z.enum(TEMPLATE_CONTEXTS).optional(),
  targetType: z.enum(TEMPLATE_TARGET_TYPES).optional(),
  requiresCustomerSignature: z.boolean().optional(),
  requiresEmployeeSignature: z.boolean().optional(),
});

export const insertGeneratedDocumentSchema = z.object({
  customerId: z.number().int().nullable().optional(),
  employeeId: z.number().int().nullable().optional(),
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  documentTypeId: z.number().int().nullable().optional(),
  fileName: z.string().min(1),
  objectPath: z.string().min(1),
  renderedHtml: z.string().nullable().optional(),
  customerSignatureData: z.string().nullable().optional(),
  employeeSignatureData: z.string().nullable().optional(),
  signingStatus: z.enum(SIGNING_STATUSES).optional().default("complete"),
  integrityHash: z.string().nullable().optional(),
  signingIp: z.string().nullable().optional(),
  signingLocation: z.string().nullable().optional(),
});

export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
export type UpdateDocumentTemplate = z.infer<typeof updateDocumentTemplateSchema>;
export type DocumentTemplateBillingType = typeof documentTemplateBillingTypes.$inferSelect;
export type GeneratedDocument = typeof generatedDocuments.$inferSelect;
export type InsertGeneratedDocument = z.infer<typeof insertGeneratedDocumentSchema>;
export type DocumentSigningToken = typeof documentSigningTokens.$inferSelect;

export const insertDocumentTypeSchema = z.object({
  name: z.string().min(1, "Name ist erforderlich").max(100),
  description: z.string().max(500).nullable().optional(),
  targetType: z.enum(["employee", "customer"]).default("employee"),
  context: z.enum(DOCUMENT_TYPE_CONTEXTS).default("beide"),
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
