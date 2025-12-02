import { pgTable, text, integer, timestamp, serial, time } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// German phone number regex - supports mobile (01XX) and landline (0XX) formats
export const germanPhoneRegex = /^(\+49|0)[1-9]\d{1,14}$/;

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  // Original combined name field (kept for backwards compatibility)
  name: text("name").notNull(),
  // New separate name fields for Erstberatung
  vorname: text("vorname"),
  nachname: text("nachname"),
  telefon: text("telefon"),
  // Address fields
  address: text("address").notNull(),
  strasse: text("strasse"),
  nr: text("nr"),
  plz: text("plz"),
  stadt: text("stadt"),
  // Care level 1-5
  pflegegrad: integer("pflegegrad"),
  // Legacy fields
  avatar: text("avatar").notNull().default("person"),
  needs: text("needs").array().notNull().default([]),
});

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  appointmentType: text("appointment_type").notNull(), // "Erstberatung" | "Kundentermin"
  // Service durations in minutes (15-min increments) - for Kundentermin
  hauswirtschaftDauer: integer("hauswirtschaft_dauer"), // null if not selected
  alltagsbegleitungDauer: integer("alltagsbegleitung_dauer"), // null if not selected
  // Legacy serviceType field (for display compatibility)
  serviceType: text("service_type"),
  date: text("date").notNull(),
  time: time("time").notNull(), // Start time (Von) - proper SQL time type
  endTime: time("end_time"), // End time (Bis) - proper SQL time type
  durationPromised: integer("duration_promised").notNull(),
  status: text("status").notNull().default("scheduled"),
  // Actual visit times (set during visit)
  startTime: timestamp("start_time"),
  actualEndTime: timestamp("actual_end_time"),
  kilometers: text("kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCustomerSchema = createInsertSchema(customers).omit({
  id: true,
});

// Schema for creating new customer during Erstberatung
export const insertErstberatungCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  telefon: z.string().regex(germanPhoneRegex, "Ungültige deutsche Telefonnummer"),
  strasse: z.string().min(1, "Straße ist erforderlich"),
  nr: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben"),
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  pflegegrad: z.number().min(1).max(5),
});

// Base appointment insert schema
const baseAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  createdAt: true,
});

// Schema for Kundentermin appointment
export const insertKundenterminSchema = z.object({
  customerId: z.number(),
  date: z.string(),
  time: z.string(),
  hauswirtschaftDauer: z.number().min(15).multipleOf(15).nullable().optional(),
  alltagsbegleitungDauer: z.number().min(15).multipleOf(15).nullable().optional(),
  notes: z.string().max(255).optional(),
}).refine(
  (data) => data.hauswirtschaftDauer || data.alltagsbegleitungDauer,
  { message: "Mindestens ein Service muss ausgewählt werden" }
);

// Schema for Erstberatung appointment
export const insertErstberatungSchema = z.object({
  customer: insertErstberatungCustomerSchema,
  date: z.string(),
  time: z.string(), // Von
  endTime: z.string(), // Bis
  notes: z.string().max(255).optional(),
});

// Refined schema for general appointment insert
export const insertAppointmentSchema = baseAppointmentSchema.superRefine((data, ctx) => {
  if (data.appointmentType === "Kundentermin") {
    if (!data.hauswirtschaftDauer && !data.alltagsbegleitungDauer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Mindestens ein Service muss ausgewählt werden",
        path: ["serviceType"],
      });
    }
  }
});

export const updateAppointmentSchema = baseAppointmentSchema.partial();

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertErstberatungCustomer = z.infer<typeof insertErstberatungCustomerSchema>;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type InsertKundentermin = z.infer<typeof insertKundenterminSchema>;
export type InsertErstberatung = z.infer<typeof insertErstberatungSchema>;
