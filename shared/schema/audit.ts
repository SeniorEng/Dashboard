import { pgTable, text, integer, serial, jsonb, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

export const AUDIT_ACTIONS = [
  "documentation_submitted",
  "documentation_signature_added",
  "service_record_created",
  "service_record_signed_employee",
  "service_record_signed_customer",
  "service_record_revoked",
  "appointment_revoked",
  "appointment_updated",
  "appointment_deleted",
  "employee_anonymized",
] as const;

export type AuditAction = typeof AUDIT_ACTIONS[number];

export const AUDIT_ENTITY_TYPES = [
  "appointment",
  "service_record",
  "user",
] as const;

export type AuditEntityType = typeof AUDIT_ENTITY_TYPES[number];

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("audit_log_entity_idx").on(table.entityType, table.entityId),
  index("audit_log_user_idx").on(table.userId),
  index("audit_log_action_idx").on(table.action),
  index("audit_log_created_at_idx").on(table.createdAt),
]);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type InsertAuditLogEntry = typeof auditLog.$inferInsert;

export const auditLogFilterSchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.number().optional(),
  userId: z.number().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().min(1).max(200).default(50),
  offset: z.number().min(0).default(0),
});

export type AuditLogFilter = z.infer<typeof auditLogFilterSchema>;
