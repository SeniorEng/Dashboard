import { pgTable, text, integer, timestamp, serial, time, date, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";

// ============================================
// USER & AUTHENTICATION TABLES
// ============================================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  vorname: text("vorname"),
  nachname: text("nachname"),
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  geburtsdatum: date("geburtsdatum"),
  isActive: boolean("is_active").notNull().default(true),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Employee roles/capabilities - can have multiple per user
export const userRoles = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "hauswirtschaft" | "alltagsbegleitung" | "erstberatung" | "personenbefoerderung" | "kinderbetreuung"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("user_role_unique").on(table.userId, table.role),
]);

// Sessions for authentication
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Password reset tokens
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Employee role types
export const EMPLOYEE_ROLES = [
  "hauswirtschaft",
  "alltagsbegleitung", 
  "erstberatung",
  "personenbefoerderung",
  "kinderbetreuung",
] as const;

export type EmployeeRole = typeof EMPLOYEE_ROLES[number];

// User schemas
export const insertUserSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  isAdmin: z.boolean().optional().default(false),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional().default([]),
});

export const loginSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  password: z.string().min(1, "Passwort ist erforderlich"),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
});

export const passwordResetSchema = z.object({
  token: z.string().min(1, "Token ist erforderlich"),
  newPassword: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserRole = typeof userRoles.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// User with roles (for API responses)
export type UserWithRoles = User & { roles: EmployeeRole[] };

// German phone validation using libphonenumber-js
export const germanPhoneSchema = z.string().refine(
  (value) => {
    if (!value || value.trim() === "") return false;
    try {
      if (!isValidPhoneNumber(value, "DE")) return false;
      const parsed = parsePhoneNumber(value, "DE");
      return parsed?.country === "DE";
    } catch {
      return false;
    }
  },
  { message: "Ungültige deutsche Telefonnummer" }
);

// Transform phone to E.164 format for storage
export const germanPhoneTransformSchema = germanPhoneSchema.transform((value) => {
  const parsed = parsePhoneNumber(value, "DE");
  return parsed?.format("E.164") ?? value;
});

// Legacy regex (kept for backward compatibility)
export const germanPhoneRegex = /^(\+49|0)[1-9]\d{1,14}$/;

// ============================================
// CUSTOMER & ASSIGNMENT TABLES
// ============================================

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
  // Employee assignments
  primaryEmployeeId: integer("primary_employee_id").references(() => users.id),
  backupEmployeeId: integer("backup_employee_id").references(() => users.id),
  // Legacy fields
  avatar: text("avatar").notNull().default("person"),
  needs: text("needs").array().notNull().default([]),
});

// ============================================
// APPOINTMENT TABLES
// ============================================

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  appointmentType: text("appointment_type").notNull(), // "Erstberatung" | "Kundentermin"
  // Service durations in minutes (15-min increments) - for Kundentermin
  hauswirtschaftDauer: integer("hauswirtschaft_dauer"), // null if not selected
  alltagsbegleitungDauer: integer("alltagsbegleitung_dauer"), // null if not selected
  // Service durations in minutes (15-min increments) - for Erstberatung
  erstberatungDauer: integer("erstberatung_dauer"), // null if not Erstberatung
  // Service documentation - actual duration and details (max 55 chars)
  hauswirtschaftActualDauer: integer("hauswirtschaft_actual_dauer"),
  hauswirtschaftDetails: text("hauswirtschaft_details"),
  alltagsbegleitungActualDauer: integer("alltagsbegleitung_actual_dauer"),
  alltagsbegleitungDetails: text("alltagsbegleitung_details"),
  erstberatungActualDauer: integer("erstberatung_actual_dauer"),
  erstberatungDetails: text("erstberatung_details"),
  // Legacy serviceType field (for display compatibility)
  serviceType: text("service_type"),
  date: date("date").notNull(),
  // Scheduled times (planned appointment slot)
  scheduledStart: time("scheduled_start").notNull(),
  scheduledEnd: time("scheduled_end"),
  durationPromised: integer("duration_promised").notNull(),
  status: text("status").notNull().default("scheduled"),
  // Actual visit times (recorded during visit)
  actualStart: timestamp("actual_start"),
  actualEnd: timestamp("actual_end"),
  // Travel documentation
  travelOriginType: text("travel_origin_type"), // "home" | "appointment"
  travelFromAppointmentId: integer("travel_from_appointment_id"),
  travelKilometers: integer("travel_kilometers"),
  travelMinutes: integer("travel_minutes"),
  // Legacy kilometers field (kept for backwards compatibility)
  kilometers: text("kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Base customer schema from Drizzle, with phone validation override
const baseCustomerSchema = createInsertSchema(customers).omit({
  id: true,
});

// Optional phone validation - validates and transforms to E.164 if provided
// Handles: null, undefined, empty string, E.164 format, user input formats
const optionalGermanPhoneSchema = z.union([
  z.null(),
  z.undefined(),
  z.literal(""),
  z.string(),
]).transform((value, ctx) => {
  if (value === null || value === undefined || value === "") return null;
  
  const trimmed = value.trim();
  if (trimmed === "") return null;
  
  try {
    if (!isValidPhoneNumber(trimmed, "DE")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    const parsed = parsePhoneNumber(trimmed, "DE");
    if (parsed?.country !== "DE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    return parsed.format("E.164");
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ungültige deutsche Telefonnummer",
    });
    return z.NEVER;
  }
});

// Customer schema with phone validation
export const insertCustomerSchema = baseCustomerSchema.extend({
  telefon: optionalGermanPhoneSchema,
});

// Schema for creating new customer during Erstberatung
export const insertErstberatungCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  telefon: germanPhoneTransformSchema,
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
  scheduledStart: z.string(),
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
  scheduledStart: z.string(),
  erstberatungDauer: z.number().min(15).multipleOf(15),
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

// Schema for documenting any appointment (Kundentermin or Erstberatung)
export const documentAppointmentSchema = z.object({
  // Service documentation (at least one required based on what was scheduled)
  hauswirtschaftActualDauer: z.number().min(1).nullable().optional(),
  hauswirtschaftDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  alltagsbegleitungActualDauer: z.number().min(1).nullable().optional(),
  alltagsbegleitungDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  erstberatungActualDauer: z.number().min(1).nullable().optional(),
  erstberatungDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  // Travel documentation
  travelOriginType: z.enum(["home", "appointment"]),
  travelFromAppointmentId: z.number().nullable().optional(),
  travelKilometers: z.number().min(0, "Kilometer müssen positiv sein"),
  travelMinutes: z.number().min(0).nullable().optional(), // Only required if origin is appointment
  // Optional notes
  notes: z.string().max(255).nullable().optional(),
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

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertErstberatungCustomer = z.infer<typeof insertErstberatungCustomerSchema>;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type InsertKundentermin = z.infer<typeof insertKundenterminSchema>;
export type InsertErstberatung = z.infer<typeof insertErstberatungSchema>;
