import { pgTable, text, integer, serial, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";
import { documentTypes } from "./documents";

// Migration SQL:
// ALTER TABLE qualifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
// ALTER TABLE employee_qualifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
// ALTER TABLE employee_document_proofs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

export const PROOF_STATUSES = ["pending", "uploaded", "approved", "rejected"] as const;
export type ProofStatus = typeof PROOF_STATUSES[number];

export const PROOF_STATUS_LABELS: Record<ProofStatus, string> = {
  pending: "Ausstehend",
  uploaded: "Hochgeladen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
};

export const qualifications = pgTable("qualifications", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const qualificationDocuments = pgTable("qualification_documents", {
  id: serial("id").primaryKey(),
  qualificationId: integer("qualification_id").notNull().references(() => qualifications.id, { onDelete: "cascade" }),
  documentTypeId: integer("document_type_id").notNull().references(() => documentTypes.id, { onDelete: "cascade" }),
  isRequired: boolean("is_required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  index("qual_docs_qual_idx").on(table.qualificationId),
  index("qual_docs_doctype_idx").on(table.documentTypeId),
  uniqueIndex("qual_docs_unique").on(table.qualificationId, table.documentTypeId),
]);

export const employeeQualifications = pgTable("employee_qualifications", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  qualificationId: integer("qualification_id").notNull().references(() => qualifications.id, { onDelete: "cascade" }),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  assignedByUserId: integer("assigned_by_user_id").references(() => users.id),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("emp_qual_employee_idx").on(table.employeeId),
  index("emp_qual_qual_idx").on(table.qualificationId),
  uniqueIndex("emp_qual_unique").on(table.employeeId, table.qualificationId),
]);

export const employeeDocumentProofs = pgTable("employee_document_proofs", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  qualificationId: integer("qualification_id").notNull().references(() => qualifications.id, { onDelete: "cascade" }),
  documentTypeId: integer("document_type_id").notNull().references(() => documentTypes.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  fileName: text("file_name"),
  objectPath: text("object_path"),
  uploadedAt: timestamp("uploaded_at"),
  reviewedAt: timestamp("reviewed_at"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => users.id),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("edp_employee_idx").on(table.employeeId),
  index("edp_qual_idx").on(table.qualificationId),
  index("edp_doctype_idx").on(table.documentTypeId),
  index("edp_status_idx").on(table.status),
  uniqueIndex("edp_unique").on(table.employeeId, table.qualificationId, table.documentTypeId),
]);

export const insertQualificationSchema = z.object({
  name: z.string().min(1, "Name ist erforderlich").max(100),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateQualificationSchema = insertQualificationSchema.partial();

export const insertQualificationDocumentSchema = z.object({
  qualificationId: z.number().int(),
  documentTypeId: z.number().int(),
  isRequired: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export type Qualification = typeof qualifications.$inferSelect;
export type InsertQualification = z.infer<typeof insertQualificationSchema>;
export type UpdateQualification = z.infer<typeof updateQualificationSchema>;
export type QualificationDocument = typeof qualificationDocuments.$inferSelect;
export type EmployeeQualification = typeof employeeQualifications.$inferSelect;
export type EmployeeDocumentProof = typeof employeeDocumentProofs.$inferSelect;
