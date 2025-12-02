import { pgTable, text, integer, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  avatar: text("avatar").notNull().default("lady"),
  needs: text("needs").array().notNull().default([]),
});

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  appointmentType: text("appointment_type").notNull(), // "Erstberatung" | "Kundentermin"
  serviceType: text("service_type"), // "Hauswirtschaft" | "Alltagsbegleitung" (only for Kundentermin)
  date: text("date").notNull(),
  time: text("time").notNull(),
  durationPromised: integer("duration_promised").notNull(),
  status: text("status").notNull().default("scheduled"),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  kilometers: text("kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCustomerSchema = createInsertSchema(customers).omit({
  id: true,
});

// Base appointment insert schema with refinement for conditional serviceType
const baseAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  createdAt: true,
});

// Refined schema: serviceType required for Kundentermin, null for Erstberatung
export const insertAppointmentSchema = baseAppointmentSchema.superRefine((data, ctx) => {
  if (data.appointmentType === "Kundentermin" && !data.serviceType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "serviceType is required for Kundentermin appointments",
      path: ["serviceType"],
    });
  }
  if (data.appointmentType === "Erstberatung" && data.serviceType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "serviceType must be null for Erstberatung appointments",
      path: ["serviceType"],
    });
  }
});

export const updateAppointmentSchema = baseAppointmentSchema.partial();

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
