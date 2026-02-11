import { pgTable, text, integer, serial, time, date, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { customers, insertErstberatungCustomerSchema } from "./customers";
import { users } from "./users";
import { services } from "./services";

// ============================================
// APPOINTMENT TABLES
// ============================================

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  assignedEmployeeId: integer("assigned_employee_id").references(() => users.id),
  performedByEmployeeId: integer("performed_by_employee_id").references(() => users.id),
  appointmentType: text("appointment_type").notNull(),
  serviceType: text("service_type"),
  date: date("date").notNull(),
  // Scheduled times (planned appointment slot)
  scheduledStart: time("scheduled_start").notNull(),
  scheduledEnd: time("scheduled_end"),
  durationPromised: integer("duration_promised").notNull(),
  status: text("status").notNull().default("scheduled"),
  // Actual visit times (recorded during visit) - stored as time strings "HH:MM:SS"
  actualStart: time("actual_start"),
  actualEnd: time("actual_end"),
  // Travel documentation
  travelOriginType: text("travel_origin_type"), // "home" | "appointment"
  travelFromAppointmentId: integer("travel_from_appointment_id"),
  travelKilometers: integer("travel_kilometers"),
  travelMinutes: integer("travel_minutes"),
  // Customer kilometers (for Alltagsbegleitung - trips with/for customer)
  customerKilometers: integer("customer_kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("appointments_customer_id_idx").on(table.customerId),
  index("appointments_date_idx").on(table.date),
  index("appointments_assigned_employee_id_idx").on(table.assignedEmployeeId),
  index("appointments_performed_by_employee_id_idx").on(table.performedByEmployeeId),
  index("appointments_date_customer_id_idx").on(table.date, table.customerId),
  index("appointments_status_date_idx").on(table.status, table.date),
  index("appointments_employee_date_idx").on(table.assignedEmployeeId, table.date),
]);

// ============================================
// APPOINTMENT SERVICES (junction table for dynamic service selection)
// ============================================

export const appointmentServices = pgTable("appointment_services", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
  serviceId: integer("service_id").notNull().references(() => services.id),
  plannedDurationMinutes: integer("planned_duration_minutes").notNull(),
  actualDurationMinutes: integer("actual_duration_minutes"),
  details: text("details"),
}, (table) => [
  index("appointment_services_appointment_id_idx").on(table.appointmentId),
  index("appointment_services_service_id_idx").on(table.serviceId),
]);

export type AppointmentService = typeof appointmentServices.$inferSelect;
export type InsertAppointmentService = typeof appointmentServices.$inferInsert;

// Base appointment insert schema
const baseAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  createdAt: true,
});

// Service entry for dynamic appointment service selection
export const appointmentServiceEntrySchema = z.object({
  serviceId: z.number(),
  durationMinutes: z.number().min(15).multipleOf(15),
});

export type AppointmentServiceEntry = z.infer<typeof appointmentServiceEntrySchema>;

// Schema for Kundentermin appointment (supports dynamic services array)
export const insertKundenterminSchema = z.object({
  customerId: z.number(),
  date: z.string(),
  scheduledStart: z.string(),
  services: z.array(appointmentServiceEntrySchema).min(1, "Mindestens ein Service muss ausgewählt werden"),
  notes: z.string().max(255).optional(),
  assignedEmployeeId: z.number().nullable().optional(),
});

// Schema for Erstberatung appointment
export const insertErstberatungSchema = z.object({
  customer: insertErstberatungCustomerSchema,
  date: z.string(),
  scheduledStart: z.string(),
  erstberatungDauer: z.number().min(15).multipleOf(15),
  notes: z.string().max(255).optional(),
  assignedEmployeeId: z.number().nullable().optional(), // Admin can assign employee
});

export const updateAppointmentSchema = baseAppointmentSchema.partial();

export const documentServiceEntrySchema = z.object({
  serviceId: z.number(),
  actualDurationMinutes: z.number().min(1),
  details: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
});

export type DocumentServiceEntry = z.infer<typeof documentServiceEntrySchema>;

// Schema for documenting any appointment (Kundentermin or Erstberatung)
export const documentAppointmentSchema = z.object({
  performedByEmployeeId: z.number().nullable().optional(),
  actualStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  travelOriginType: z.enum(["home", "appointment"]),
  travelFromAppointmentId: z.number().nullable().optional(),
  travelKilometers: z.number().min(0, "Kilometer müssen positiv sein"),
  travelMinutes: z.number().min(0).nullable().optional(),
  customerKilometers: z.number().min(0).nullable().optional(),
  notes: z.string().max(255).nullable().optional(),
  services: z.array(documentServiceEntrySchema).min(1, "Mindestens ein Service muss dokumentiert werden"),
}).refine(
  (data) => {
    // If origin is "appointment", travelMinutes is required
    if (data.travelOriginType === "appointment" && (data.travelMinutes === null || data.travelMinutes === undefined)) {
      return false;
    }
    return true;
  },
  { message: "Fahrzeit ist erforderlich wenn Sie von einem anderen Termin kommen", path: ["travelMinutes"] }
);

// Alias for backward compatibility
export const documentKundenterminSchema = documentAppointmentSchema;

export type DocumentAppointment = z.infer<typeof documentAppointmentSchema>;
export type DocumentKundentermin = DocumentAppointment;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type InsertKundentermin = z.infer<typeof insertKundenterminSchema>;
export type InsertErstberatung = z.infer<typeof insertErstberatungSchema>;
