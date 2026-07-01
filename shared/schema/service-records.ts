import { pgTable, text, integer, serial, unique, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";

// ============================================
// SERVICE RECORDS (LEISTUNGSNACHWEISE) TABLES
// ============================================

export const SERVICE_RECORD_STATUSES = [
  "pending",              // Created, awaiting employee signature
  "employee_signed",      // Employee signed, awaiting customer signature
  "completed",            // Both signatures collected, record finalized
] as const;

// Task #1542 — Bedeutung neu interpretiert (GoBD: KEINE Datenmutation der
// bestehenden record_type-Werte):
//   "monthly" = Sammel-Leistungsnachweis (ein Bündel aus N dokumentierten
//               Terminen eines Monats; on-demand vom Mitarbeiter angelegt).
//   "single"  = Einzel-Leistungsnachweis (genau ein Termin).
// Es gibt KEINEN automatisch wachsenden Monatscontainer mehr; pro Monat können
// mehrere Sammel-LN existieren. Bestehende "monthly"-Sätze bleiben unverändert
// und gelten fortan als (abgeschlossener) Sammel-LN.
export const SERVICE_RECORD_TYPES = [
  "monthly",   // Sammel-Leistungsnachweis (Bündel mehrerer Termine)
  "single",    // Einzel-Leistungsnachweis (genau ein Termin)
] as const;

export type ServiceRecordStatus = typeof SERVICE_RECORD_STATUSES[number];
export type ServiceRecordType = typeof SERVICE_RECORD_TYPES[number];

export const monthlyServiceRecords = pgTable("monthly_service_records", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(), // 1-12
  recordType: text("record_type").notNull().default("monthly"), // "monthly" = Sammel-LN | "single" = Einzel-LN
  status: text("status").notNull().default("pending"), // ServiceRecordStatus
  // Employee signature
  employeeSignatureData: text("employee_signature_data"),
  employeeSignatureHash: text("employee_signature_hash"),
  employeeSignedAt: timestamp("employee_signed_at"),
  employeeSignedByUserId: integer("employee_signed_by_user_id").references(() => users.id),
  employeeSigningIp: text("employee_signing_ip"),
  employeeSigningLocation: text("employee_signing_location"),
  // Customer signature
  customerSignatureData: text("customer_signature_data"),
  customerSignatureHash: text("customer_signature_hash"),
  customerSignedAt: timestamp("customer_signed_at"),
  customerSignedByUserId: integer("customer_signed_by_user_id").references(() => users.id),
  customerSigningIp: text("customer_signing_ip"),
  customerSigningLocation: text("customer_signing_location"),
  // Metadata
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("service_records_customer_idx").on(table.customerId),
  index("service_records_employee_idx").on(table.employeeId),
  index("service_records_period_idx").on(table.year, table.month),
  index("service_records_status_idx").on(table.status),
  index("service_records_type_idx").on(table.recordType),
  // Task #1542 — Der partielle Unique-Index aus #1528
  // (monthly_service_records_pending_unique_idx) wurde ENTFERNT: mit dem
  // On-Demand-Sammel-LN sind mehrere offene Bündel pro Kunde+Mitarbeiter+Monat
  // gewollt (kein automatisch wachsender Monatscontainer mehr). Der Index wird
  // idempotent per Startup-Migration
  // (drop-monthly-service-record-pending-unique.ts) auf Bestandssystemen
  // abgeräumt.
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
  year: z.number().min(2020, "Jahr muss zwischen 2020 und 2100 liegen").max(2100, "Jahr muss zwischen 2020 und 2100 liegen"),
  month: z.number().min(1, "Monat muss zwischen 1 und 12 liegen").max(12, "Monat muss zwischen 1 und 12 liegen"),
  recordType: z.enum(["monthly", "single"]).default("monthly"),
  // Task #1542 — On-Demand-Sammel-LN: der Mitarbeiter wählt gezielt aus, welche
  // dokumentierten Termine des Monats gebündelt werden. Ohne Angabe werden alle
  // noch nicht abgedeckten, dokumentierten Termine des Monats vorgeschlagen.
  appointmentIds: z.number().array().optional(),
});

export const insertSingleServiceRecordSchema = z.object({
  customerId: z.number(),
  appointmentId: z.number(),
});

export const signServiceRecordSchema = z.object({
  signatureData: z.string().min(1, "Unterschrift ist erforderlich"),
  signerType: z.enum(["employee", "customer"]),
  signingLocation: z.string().nullable().optional(),
});

export type MonthlyServiceRecord = typeof monthlyServiceRecords.$inferSelect;
export type InsertServiceRecord = z.infer<typeof insertServiceRecordSchema>;
export type InsertSingleServiceRecord = z.infer<typeof insertSingleServiceRecordSchema>;
export type SignServiceRecord = z.infer<typeof signServiceRecordSchema>;
export type ServiceRecordAppointment = typeof serviceRecordAppointments.$inferSelect;
