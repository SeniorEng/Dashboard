import { pgTable, text, integer, serial, time, date, boolean, index, real, type AnyPgColumn } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { prospects } from "./prospects";
import { users } from "./users";
import { services } from "./services";

// ============================================
// APPOINTMENT SERIES (recurring appointment rules)
// ============================================

export const SERIES_FREQUENCIES = ["weekly", "biweekly"] as const;
export type SeriesFrequency = typeof SERIES_FREQUENCIES[number];

export const SERIES_STATUSES = ["active", "paused", "ended"] as const;
export type SeriesStatus = typeof SERIES_STATUSES[number];

export const WEEKDAYS = ["mo", "di", "mi", "do", "fr"] as const;
export type Weekday = typeof WEEKDAYS[number];

export const appointmentSeries = pgTable("appointment_series", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  assignedEmployeeId: integer("assigned_employee_id").notNull().references(() => users.id),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  frequency: text("frequency").notNull().default("weekly"),
  weekdays: text("weekdays").array().notNull(),
  scheduledStart: time("scheduled_start").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  serviceIds: integer("service_ids").array().notNull(),
  serviceDurations: integer("service_durations").array().notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("appointment_series_customer_id_idx").on(table.customerId),
  index("appointment_series_employee_id_idx").on(table.assignedEmployeeId),
  index("appointment_series_status_idx").on(table.status),
]);

export type AppointmentSeries = typeof appointmentSeries.$inferSelect;
export type InsertAppointmentSeries = typeof appointmentSeries.$inferInsert;

export const insertAppointmentSeriesSchema = createInsertSchema(appointmentSeries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const createSeriesSchema = z.object({
  customerId: z.number(),
  assignedEmployeeId: z.number(),
  frequency: z.enum(SERIES_FREQUENCIES),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1, "Mindestens ein Wochentag muss ausgewählt werden"),
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  durationMinutes: z.number().min(15).multipleOf(15),
  services: z.array(z.object({
    serviceId: z.number(),
    durationMinutes: z.number().min(15).multipleOf(15),
  })).min(1, "Mindestens ein Service muss ausgewählt werden"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat"),
  notes: z.string().max(255).optional(),
});

export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;

export const updateSeriesSchema = z.object({
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  assignedEmployeeId: z.number().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(255).optional().nullable(),
  status: z.enum(SERIES_STATUSES).optional(),
});

export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;

// ============================================
// APPOINTMENT TABLES
// ============================================

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  prospectId: integer("prospect_id").references(() => prospects.id, { onDelete: "set null" }),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  assignedEmployeeId: integer("assigned_employee_id").references(() => users.id),
  performedByEmployeeId: integer("performed_by_employee_id").references(() => users.id),
  appointmentType: text("appointment_type").notNull(),
  serviceType: text("service_type"), // Legacy: replaced by appointment_services junction table
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
  travelFromAppointmentId: integer("travel_from_appointment_id").references((): AnyPgColumn => appointments.id),
  travelKilometers: real("travel_kilometers"),
  travelMinutes: integer("travel_minutes"),
  // Customer kilometers (for Alltagsbegleitung - trips with/for customer)
  customerKilometers: real("customer_kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]), // Legacy: replaced by appointment_services junction table
  signatureData: text("signature_data"),
  signatureHash: text("signature_hash"),
  signedAt: timestamp("signed_at"),
  signedByUserId: integer("signed_by_user_id").references(() => users.id),
  isFahrtdienst: boolean("is_fahrtdienst").notNull().default(false),
  doctorName: text("doctor_name"),
  doctorAppointmentTime: time("doctor_appointment_time"),
  doctorStrasse: text("doctor_strasse"),
  doctorPlz: text("doctor_plz"),
  doctorStadt: text("doctor_stadt"),
  doctorLatitude: real("doctor_latitude"),
  doctorLongitude: real("doctor_longitude"),
  estimatedTravelMinutes: integer("estimated_travel_minutes"),
  travelBufferMinutes: integer("travel_buffer_minutes"),
  seriesId: integer("series_id").references(() => appointmentSeries.id, { onDelete: "set null" }),
  isSeriesException: boolean("is_series_exception").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("appointments_customer_id_idx").on(table.customerId),
  index("appointments_date_idx").on(table.date),
  index("appointments_assigned_employee_id_idx").on(table.assignedEmployeeId),
  index("appointments_performed_by_employee_id_idx").on(table.performedByEmployeeId),
  index("appointments_date_customer_id_idx").on(table.date, table.customerId),
  index("appointments_status_date_idx").on(table.status, table.date),
  index("appointments_employee_date_idx").on(table.assignedEmployeeId, table.date),
  index("appointments_active_date_idx").on(table.date).where(isNull(table.deletedAt)),
  index("appointments_active_customer_idx").on(table.customerId).where(isNull(table.deletedAt)),
  index("appointments_active_employee_date_idx").on(table.assignedEmployeeId, table.date).where(isNull(table.deletedAt)),
  index("appointments_prospect_id_idx").on(table.prospectId),
  index("appointments_series_id_idx").on(table.seriesId),
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
  durationMinutes: z.number().min(15, "Mindestens 15 Minuten").multipleOf(15),
});

export type AppointmentServiceEntry = z.infer<typeof appointmentServiceEntrySchema>;

// Schema for Kundentermin appointment (supports dynamic services array)
export const fahrtdienstSchema = z.object({
  isFahrtdienst: z.literal(true),
  doctorAppointmentTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  doctorStrasse: z.string().min(1, "Arzt-Adresse (Straße) ist erforderlich"),
  doctorPlz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben"),
  doctorStadt: z.string().min(1, "Arzt-Adresse (Ort) ist erforderlich"),
  doctorName: z.string().max(200).optional(),
  doctorLatitude: z.number().optional(),
  doctorLongitude: z.number().optional(),
  estimatedTravelMinutes: z.number().int().min(0).optional(),
  travelBufferMinutes: z.number().int().min(0).optional(),
});

export type FahrtdienstData = z.infer<typeof fahrtdienstSchema>;

export const insertKundenterminSchema = z.object({
  customerId: z.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)"),
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  services: z.array(appointmentServiceEntrySchema).min(1, "Mindestens ein Service muss ausgewählt werden"),
  notes: z.string().max(255, "Maximal 255 Zeichen").optional(),
  assignedEmployeeId: z.number().nullable().optional(),
  isFahrtdienst: z.boolean().optional().default(false),
  doctorAppointmentTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat").optional(),
  doctorStrasse: z.string().max(200).optional(),
  doctorPlz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben").optional(),
  doctorStadt: z.string().max(200).optional(),
  doctorName: z.string().max(200).optional(),
  doctorLatitude: z.number().optional(),
  doctorLongitude: z.number().optional(),
  estimatedTravelMinutes: z.number().int().min(0).optional(),
  travelBufferMinutes: z.number().int().min(0).optional(),
});

// Schema for Erstberatung appointment linked to prospect
export const insertProspectErstberatungSchema = z.object({
  prospectId: z.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)"),
  scheduledStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  erstberatungDauer: z.number().min(15, "Mindestens 15 Minuten").multipleOf(15),
  notes: z.string().max(255, "Maximal 255 Zeichen").optional(),
  assignedEmployeeId: z.number().nullable().optional(),
});

export const updateAppointmentSchema = baseAppointmentSchema.omit({
  customerId: true,
}).partial();

export const documentServiceEntrySchema = z.object({
  serviceId: z.number(),
  actualDurationMinutes: z.number().min(1, "Mindestens 1 Minute").max(1440, "Maximal 1440 Minuten"),
  details: z.string().min(1, "Servicedetails sind erforderlich").max(120, "Maximal 120 Zeichen"),
});

export type DocumentServiceEntry = z.infer<typeof documentServiceEntrySchema>;

// Schema for documenting any appointment (Kundentermin or Erstberatung)
export const documentAppointmentSchema = z.object({
  performedByEmployeeId: z.number().nullable().optional(),
  actualStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  travelOriginType: z.enum(["home", "appointment"]),
  travelFromAppointmentId: z.number().nullable().optional(),
  travelKilometers: z.number().min(0, "Kilometer müssen positiv sein").max(500, "Maximal 500 km Anfahrt"),
  travelMinutes: z.number().min(0, "Fahrzeit darf nicht negativ sein").max(480, "Maximal 8 Stunden Fahrzeit").nullable().optional(),
  customerKilometers: z.number().min(0, "Kilometer dürfen nicht negativ sein").max(500, "Maximal 500 km Kundenkilometer").nullable().optional(),
  notes: z.string().max(255, "Maximal 255 Zeichen").nullable().optional(),
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



export type DocumentAppointment = z.infer<typeof documentAppointmentSchema>;
export type DocumentKundentermin = DocumentAppointment;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type InsertKundentermin = z.infer<typeof insertKundenterminSchema>;
export type InsertProspectErstberatung = z.infer<typeof insertProspectErstberatungSchema>;
