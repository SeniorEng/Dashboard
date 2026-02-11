import { pgTable, text, integer, serial, unique, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";

// ============================================
// MONTHLY SERVICE RECORDS (LEISTUNGSNACHWEISE) TABLES
// ============================================

export const SERVICE_RECORD_STATUSES = [
  "pending",              // Created, awaiting employee signature
  "employee_signed",      // Employee signed, awaiting customer signature
  "completed",            // Both signatures collected, record finalized
] as const;

export type ServiceRecordStatus = typeof SERVICE_RECORD_STATUSES[number];

export const monthlyServiceRecords = pgTable("monthly_service_records", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(), // 1-12
  status: text("status").notNull().default("pending"), // ServiceRecordStatus
  // Employee signature
  employeeSignatureData: text("employee_signature_data"), // Base64 PNG from react-signature-canvas
  employeeSignedAt: timestamp("employee_signed_at"),
  // Customer signature
  customerSignatureData: text("customer_signature_data"), // Base64 PNG from react-signature-canvas
  customerSignedAt: timestamp("customer_signed_at"),
  // Metadata
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("service_record_unique").on(table.customerId, table.employeeId, table.year, table.month),
  index("service_records_customer_idx").on(table.customerId),
  index("service_records_employee_idx").on(table.employeeId),
  index("service_records_period_idx").on(table.year, table.month),
  index("service_records_status_idx").on(table.status),
]);

// Join table to link appointments to service records
export const serviceRecordAppointments = pgTable("service_record_appointments", {
  id: serial("id").primaryKey(),
  serviceRecordId: integer("service_record_id").notNull().references(() => monthlyServiceRecords.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("service_record_appointment_unique").on(table.serviceRecordId, table.appointmentId),
  index("service_record_appointments_record_idx").on(table.serviceRecordId),
  index("service_record_appointments_appointment_idx").on(table.appointmentId),
]);

// Insert schemas
export const insertServiceRecordSchema = z.object({
  customerId: z.number(),
  employeeId: z.number(),
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12),
});

export const signServiceRecordSchema = z.object({
  signatureData: z.string().min(1, "Unterschrift ist erforderlich"),
  signerType: z.enum(["employee", "customer"]),
});

export type MonthlyServiceRecord = typeof monthlyServiceRecords.$inferSelect;
export type InsertServiceRecord = z.infer<typeof insertServiceRecordSchema>;
export type SignServiceRecord = z.infer<typeof signServiceRecordSchema>;
export type ServiceRecordAppointment = typeof serviceRecordAppointments.$inferSelect;
